package aicore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"

	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/adk/filesystem"
	"github.com/cloudwego/eino/adk/middlewares/summarization"
	"github.com/cloudwego/eino/adk/prebuilt/deep"

	"petrichor/api/internal/kb"
)

const (
	documentAgentPartMaxChars = 18_000
	documentAgentMaxIteration = 48
	documentAgentResultPath   = "/output/result.json"
)

type trackedDocumentBackend struct {
	*filesystem.InMemoryBackend
	mu              sync.Mutex
	expectedLines   map[string]int
	readLines       map[string]map[int]struct{}
	completedPaths  map[string]struct{}
	onPartCompleted func(completed, total int)
	onPartVerified  func(path string, completed, total int)
}

func newTrackedDocumentBackend(callbacks ...func(completed, total int)) *trackedDocumentBackend {
	var callback func(completed, total int)
	if len(callbacks) > 0 {
		callback = callbacks[0]
	}
	return &trackedDocumentBackend{
		InMemoryBackend: filesystem.NewInMemoryBackend(),
		expectedLines:   map[string]int{},
		readLines:       map[string]map[int]struct{}{},
		completedPaths:  map[string]struct{}{},
		onPartCompleted: callback,
	}
}

func (b *trackedDocumentBackend) expect(path, content string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.expectedLines[normalizeDocumentAgentPath(path)] = strings.Count(content, "\n") + 1
}

func (b *trackedDocumentBackend) Read(ctx context.Context, req *filesystem.ReadRequest) (*filesystem.FileContent, error) {
	content, err := b.InMemoryBackend.Read(ctx, req)
	if err != nil {
		return nil, err
	}
	path := normalizeDocumentAgentPath(req.FilePath)
	b.mu.Lock()
	completed, total := 0, len(b.expectedLines)
	shouldNotify := false
	if totalLines, ok := b.expectedLines[path]; ok && content.Content != "" {
		start := req.Offset
		if start < 1 {
			start = 1
		}
		readCount := strings.Count(content.Content, "\n") + 1
		if b.readLines[path] == nil {
			b.readLines[path] = map[int]struct{}{}
		}
		for line := start; line < start+readCount && line <= totalLines; line++ {
			b.readLines[path][line] = struct{}{}
		}
		if len(b.readLines[path]) >= totalLines {
			if _, exists := b.completedPaths[path]; !exists {
				b.completedPaths[path] = struct{}{}
				shouldNotify = true
			}
		}
	}
	completed = len(b.completedPaths)
	callback := b.onPartCompleted
	verifiedCallback := b.onPartVerified
	b.mu.Unlock()
	if shouldNotify && callback != nil {
		callback(completed, total)
	}
	if shouldNotify && verifiedCallback != nil {
		verifiedCallback(path, completed, total)
	}
	return content, nil
}

func normalizeDocumentAgentPath(path string) string {
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return filepath.Clean(path)
}

func (b *trackedDocumentBackend) unreadCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.expectedLines) - len(b.completedPaths)
}

func (b *trackedDocumentBackend) expectedCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.expectedLines)
}

type documentAgentPart struct {
	path   string
	chunks []kb.DocumentAgentChunk
}

func runKnowledgeDocumentAgent(ctx context.Context, request kb.DocumentAgentRequest) (string, error) {
	if len(request.Chunks) == 0 {
		return "", fmt.Errorf("文档 Agent 没有可读取的内容")
	}
	resolved, err := ResolveModelForPurpose(ctx, request.UserID, PurposeChat, nil)
	if err != nil {
		return "", err
	}

	activityTracker := newDocumentAgentActivityTracker(request)
	activityTracker.notify(kb.DocumentAgentActivity{
		ID: "adk-workspace", Kind: "lifecycle", Status: "running",
		Title: "创建隔离文档工作区", Detail: fmt.Sprintf("正在准备 %d 个文档切片", len(request.Chunks)),
	})
	backend := newTrackedDocumentBackend(func(completed, total int) {
		percent := 0
		message := "文档 Agent 正在读取完整正文"
		if total > 0 {
			percent = completed * 80 / total
		}
		if completed >= total && total > 0 {
			percent = 85
			message = "全文读取完成，正在跨章节汇总"
		}
		notifyDocumentAgentProgress(request, message, completed, total, percent)
	})
	backend.onPartVerified = activityTracker.partVerified
	if err := prepareDocumentAgentWorkspace(ctx, backend, request); err != nil {
		activityTracker.fail("adk-workspace", "隔离文档工作区创建失败")
		return "", err
	}
	activityTracker.complete("adk-workspace", "隔离文档工作区准备完成",
		fmt.Sprintf("已生成 %d 个正文分卷和既有 Wiki 摘要索引", backend.expectedCount()))
	notifyDocumentAgentProgress(request, "文档工作区准备完成，Agent 开始阅读全文", 0, backend.expectedCount(), 0)
	chatModel := newEinoToolCallingModel(resolved)
	summaryRetries := 1
	summaryHandler, err := summarization.New(ctx, &summarization.Config{
		Model: chatModel,
		Trigger: &summarization.TriggerCondition{
			ContextTokens: documentAgentSummaryTokenLimit(resolved.ContextWindow),
		},
		UserInstruction:    "压缩当前长文档抽取上下文。必须保留已完整读取的分卷路径与 chunkKey、所有候选名称/pageKey/别名/摘要/sourceChunkKeys、关系、尚未读取的分卷和最终结果文件契约。",
		Retry:              &summarization.RetryConfig{MaxRetries: &summaryRetries},
		EmitInternalEvents: true,
	})
	if err != nil {
		return "", fmt.Errorf("创建文档 Agent 上下文压缩器失败: %w", err)
	}
	instruction := documentAgentInstruction(request)
	agent, err := deep.New(ctx, &deep.Config{
		Name:             "knowledge-document-extractor",
		Description:      "遍历完整长文档并生成可追溯的 Wiki 实体、概念和关系",
		ChatModel:        chatModel,
		Instruction:      instruction,
		MaxIteration:     documentAgentMaxIteration,
		Backend:          backend,
		Handlers:         []adk.ChatModelAgentMiddleware{summaryHandler},
		ModelRetryConfig: &adk.ModelRetryConfig{MaxRetries: 2},
	})
	if err != nil {
		return "", fmt.Errorf("创建文档 Agent 失败: %w", err)
	}

	activityTracker.notify(kb.DocumentAgentActivity{
		ID: "adk-runtime", Kind: "lifecycle", Status: "running",
		Title: "启动文档抽取 Agent", Detail: fmt.Sprintf("最多执行 %d 轮", documentAgentMaxIteration),
		AgentName: "主 Agent",
	})
	runner := adk.NewRunner(ctx, adk.RunnerConfig{Agent: agent, EnableStreaming: false})
	iterator := runner.Query(ctx, strings.Join([]string{
		"请分析知识库「" + request.KnowledgeBaseName + "」中的文章「" + request.ArticleTitle + "」。",
		"正文不在本消息里；从 /document/manifest.md 开始，遍历工作区中的完整文档。",
		"完成后把唯一结果写入 " + documentAgentResultPath + "。",
	}, "\n"))
	finalAnswer := ""
	for {
		event, ok := iterator.Next()
		if !ok {
			break
		}
		activityTracker.handle(event)
		if event.Err != nil {
			var retryNotice *adk.WillRetryError
			if !errors.As(event.Err, &retryNotice) {
				activityTracker.fail("adk-runtime", "文档抽取 Agent 执行失败")
				return "", event.Err
			}
		}
		if event.Output == nil || event.Output.MessageOutput == nil {
			continue
		}
		message := event.Output.MessageOutput.Message
		if message != nil && message.Role == "assistant" && trimAgentText(message.Content) != "" {
			finalAnswer = message.Content
		}
	}
	if unread := backend.unreadCount(); unread > 0 {
		activityTracker.fail("adk-runtime", "Agent 未完整阅读全部正文分卷")
		return "", fmt.Errorf("文档 Agent 跳过了 %d 个正文分卷", unread)
	}

	result, readErr := backend.Read(ctx, &filesystem.ReadRequest{FilePath: documentAgentResultPath})
	if readErr == nil && result != nil && trimAgentText(result.Content) != "" {
		activityTracker.complete("adk-runtime", "文档抽取 Agent 执行完成", "已读取最终结果文件")
		return result.Content, nil
	}
	if trimAgentText(finalAnswer) != "" {
		activityTracker.complete("adk-runtime", "文档抽取 Agent 执行完成", "使用 Agent 最终响应进行结果校验")
		return finalAnswer, nil
	}
	activityTracker.fail("adk-runtime", "Agent 未生成最终抽取结果")
	return "", fmt.Errorf("文档 Agent 没有生成结果文件")
}

func notifyDocumentAgentProgress(
	request kb.DocumentAgentRequest,
	message string,
	completed, total, percent int,
) {
	if request.Progress == nil {
		return
	}
	request.Progress(kb.DocumentAgentProgress{
		Message: message, Completed: completed, Total: total, Percent: percent,
	})
}

func documentAgentSummaryTokenLimit(contextWindow int64) int {
	if contextWindow <= 0 {
		return 64_000
	}
	limit := contextWindow * 2 / 3
	if limit > 120_000 {
		limit = 120_000
	}
	if limit < 8_000 {
		limit = 8_000
	}
	return int(limit)
}

func prepareDocumentAgentWorkspace(ctx context.Context, backend *trackedDocumentBackend, request kb.DocumentAgentRequest) error {
	parts := splitDocumentAgentParts(request.Chunks)
	manifest := []string{
		"# 长文档清单", "", "必须读取下面每一个正文分卷；每个 chunkKey 都必须出现在最终 coveredChunkKeys 中。", "",
	}
	for _, part := range parts {
		var body []string
		keys := make([]string, 0, len(part.chunks))
		for _, chunk := range part.chunks {
			keys = append(keys, chunk.ChunkKey)
			heading := strings.Join(chunk.HeadingPath, " > ")
			if heading == "" {
				heading = "文档正文"
			}
			body = append(body,
				"<document_chunk id=\""+chunk.ChunkKey+"\">",
				"标题路径："+heading,
				chunk.ContentMd,
				"</document_chunk>", "",
			)
		}
		content := strings.Join(body, "\n")
		if err := backend.Write(ctx, &filesystem.WriteRequest{FilePath: part.path, Content: content}); err != nil {
			return err
		}
		backend.expect(part.path, content)
		manifest = append(manifest, "- `"+part.path+"`："+strings.Join(keys, "、"))
	}
	if err := backend.Write(ctx, &filesystem.WriteRequest{
		FilePath: "/document/manifest.md", Content: strings.Join(manifest, "\n"),
	}); err != nil {
		return err
	}

	existingJSON, err := json.MarshalIndent(request.ExistingPages, "", "  ")
	if err != nil {
		return err
	}
	return backend.Write(ctx, &filesystem.WriteRequest{
		FilePath: "/knowledge-base/existing-pages.json", Content: string(existingJSON),
	})
}

func splitDocumentAgentParts(chunks []kb.DocumentAgentChunk) []documentAgentPart {
	parts := make([]documentAgentPart, 0)
	current := make([]kb.DocumentAgentChunk, 0)
	currentChars := 0
	flush := func() {
		if len(current) == 0 {
			return
		}
		path := fmt.Sprintf("/document/parts/part-%03d.md", len(parts)+1)
		parts = append(parts, documentAgentPart{path: path, chunks: current})
		current = nil
		currentChars = 0
	}
	for _, chunk := range chunks {
		chars := len([]rune(chunk.ContentMd))
		if len(current) > 0 && currentChars+chars > documentAgentPartMaxChars {
			flush()
		}
		current = append(current, chunk)
		currentChars += chars
	}
	flush()
	return parts
}

func documentAgentInstruction(request kb.DocumentAgentRequest) string {
	maxCandidates := request.MaxCandidates
	if maxCandidates <= 0 {
		maxCandidates = 24
	}
	instruction := fmt.Sprintf(`你是 Wiki 文档知识抽取 Agent。你的任务不是按固定窗口各自猜测，而是使用文件系统工具遍历整篇文档、跨章节综合，再输出一个全局一致的结果。

工作区：
- /document/manifest.md：正文分卷与 chunkKey 清单。
- /document/parts/*.md：完整正文；每段都用 document_chunk 和稳定 chunkKey 标记。
- /knowledge-base/existing-pages.json：同知识库已有页面，可用 grep 检索同名、别名和近义名称并复用 pageKey。

执行要求：
1. 先读 manifest，再实际读取每一个正文分卷，不能只看开头、目录、摘要或关键词命中。系统会校验所有分卷是否被读取。
2. 分卷较多时优先用 task 并行委派不同分卷的分析，再由主 Agent 跨分卷去重、合并和补充关系；最终结果只能由主 Agent 汇总。内容特别长时可把阶段性候选写入 /work 下的临时文件，避免上下文压缩时丢失依据。
3. 实体是人物、组织、产品、工具、平台、系统、协议、具名技术/服务或事件；概念是功能、方法、流程、规则、原理、配置方式、安全机制或抽象知识。
4. 章节标题、源文件名、泛化目录名和一带而过的术语不应成为页面。仅保留正文有独立小节、多项事实或至少 2-3 句实质说明的知识。
5. 全文中的同一对象只能有一个候选；中英文名、缩写和别名放 aliases。先检索已有页面，同一对象应复用其 pageKey。
6. sourceChunkKeys 必须列出直接支持该候选的全部关键 chunkKey；不得填写未读取或不存在的 key。
7. relations 可以跨远距离章节，但两端必须在本次 candidates 中，且必须有原文依据。
8. 候选最多 %d 个；按知识价值、独立性和全文覆盖选择，而不是按出现顺序截断。
9. 在确认所有分卷完成后，将纯 JSON 写入 /output/result.json。不要写 Markdown 围栏，不要把分析过程写入结果文件。

结果结构：
{"documentSummary":"覆盖全文首中尾的摘要","coveredChunkKeys":["chunk-001"],"entities":[{"name":"","pageKey":"entity/name","aliases":[],"summary":"","sourceChunkKeys":["chunk-001"]}],"concepts":[{"name":"","pageKey":"concept/name","aliases":[],"summary":"","sourceChunkKeys":["chunk-002"]}],"relations":[{"fromPageKey":"","toPageKey":"","relationType":"实现","description":""}]}`, maxCandidates)
	if guide := strings.TrimSpace(request.CompileGuide); guide != "" {
		instruction += "\n\n以下是本知识库的编译约定；不得覆盖上述遍历和 JSON 契约：\n<compile_guide>\n" + guide + "\n</compile_guide>"
	}
	return instruction
}

func trimAgentText(value string) string {
	return strings.TrimSpace(value)
}
