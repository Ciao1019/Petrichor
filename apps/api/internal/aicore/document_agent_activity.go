package aicore

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"

	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/adk/middlewares/summarization"
	"github.com/cloudwego/eino/schema"

	"petrichor/api/internal/kb"
)

// documentAgentActivityTracker 把 ADK 原始事件翻译为可公开的业务动作。
// 工具参数只提取虚拟路径、行区间和数量，绝不透传正文、Prompt、工具结果或模型思维链。
type documentAgentActivityTracker struct {
	mu              sync.Mutex
	request         kb.DocumentAgentRequest
	sequence        int
	round           int
	pending         map[string]kb.DocumentAgentActivity
	summarizationID map[string]string
}

func newDocumentAgentActivityTracker(request kb.DocumentAgentRequest) *documentAgentActivityTracker {
	return &documentAgentActivityTracker{
		request: request, pending: map[string]kb.DocumentAgentActivity{},
		summarizationID: map[string]string{},
	}
}

func (t *documentAgentActivityTracker) handle(event *adk.AgentEvent) {
	if event == nil {
		return
	}
	t.handleSummarization(event)
	if event.Err != nil {
		var retry *adk.WillRetryError
		if errors.As(event.Err, &retry) {
			t.notify(kb.DocumentAgentActivity{
				ID: t.nextID("retry"), Kind: "retry", Status: "running",
				Title: "模型调用正在重试", Detail: fmt.Sprintf("第 %d 次局部重试", retry.RetryAttempt),
				AgentName: documentAgentDisplayName(event.AgentName),
			})
		}
	}
	if event.Output == nil || event.Output.MessageOutput == nil {
		return
	}
	message := event.Output.MessageOutput.Message
	if message == nil {
		return
	}
	switch message.Role {
	case schema.Assistant:
		if len(message.ToolCalls) == 0 {
			return
		}
		round := t.nextRound()
		for _, call := range message.ToolCalls {
			t.startTool(event.AgentName, round, call)
		}
	case schema.Tool:
		t.completeTool(message.ToolCallID, message.ToolName, event.AgentName)
	}
}

func (t *documentAgentActivityTracker) startTool(agentName string, round int, call schema.ToolCall) {
	activity := describeDocumentAgentTool(call.Function.Name, call.Function.Arguments)
	activity.ID = strings.TrimSpace(call.ID)
	if activity.ID == "" {
		activity.ID = t.nextID("tool")
	}
	activity.Status = "running"
	activity.AgentName = documentAgentDisplayName(agentName)
	activity.ToolName = safeDocumentAgentToolName(call.Function.Name)
	activity.Round = round

	t.mu.Lock()
	t.pending[activity.ID] = activity
	t.mu.Unlock()
	t.notify(activity)
}

func (t *documentAgentActivityTracker) completeTool(callID, toolName, agentName string) {
	callID = strings.TrimSpace(callID)
	if callID == "" {
		return
	}
	t.mu.Lock()
	activity, ok := t.pending[callID]
	if ok {
		delete(t.pending, callID)
	}
	t.mu.Unlock()
	if !ok {
		return
	}
	activity.Status = "completed"
	if activity.AgentName == "" {
		activity.AgentName = documentAgentDisplayName(agentName)
	}
	if activity.ToolName == "" {
		activity.ToolName = safeDocumentAgentToolName(toolName)
	}
	t.notify(activity)
}

func (t *documentAgentActivityTracker) handleSummarization(event *adk.AgentEvent) {
	if event.Action == nil || event.Action.CustomizedAction == nil {
		return
	}
	action, ok := event.Action.CustomizedAction.(*summarization.CustomizedAction)
	if !ok || action == nil {
		return
	}
	agentName := documentAgentDisplayName(event.AgentName)
	switch action.Type {
	case summarization.ActionTypeBeforeSummarize:
		id := t.nextID("context")
		t.mu.Lock()
		t.summarizationID[agentName] = id
		t.mu.Unlock()
		t.notify(kb.DocumentAgentActivity{
			ID: id, Kind: "context", Status: "running",
			Title: "压缩 Agent 上下文", Detail: "保留已读分卷、候选、来源和待办后继续执行",
			AgentName: agentName,
		})
	case summarization.ActionTypeAfterSummarize:
		t.mu.Lock()
		id := t.summarizationID[agentName]
		delete(t.summarizationID, agentName)
		t.mu.Unlock()
		if id == "" {
			id = t.nextID("context")
		}
		t.notify(kb.DocumentAgentActivity{
			ID: id, Kind: "context", Status: "completed",
			Title: "Agent 上下文压缩完成", AgentName: agentName,
		})
	}
}

func (t *documentAgentActivityTracker) partVerified(path string, completed, total int) {
	t.notify(kb.DocumentAgentActivity{
		ID: "verified-" + filepath.Base(path), Kind: "validation", Status: "completed",
		Title:  "确认正文分卷已完整读取",
		Detail: fmt.Sprintf("%s · 全文覆盖 %d/%d", filepath.Base(path), completed, total),
	})
}

func (t *documentAgentActivityTracker) complete(id, title, detail string) {
	t.notify(kb.DocumentAgentActivity{ID: id, Status: "completed", Title: title, Detail: detail})
}

func (t *documentAgentActivityTracker) fail(id, title string) {
	t.notify(kb.DocumentAgentActivity{ID: id, Status: "failed", Title: title})
}

func (t *documentAgentActivityTracker) notify(activity kb.DocumentAgentActivity) {
	if t.request.Activity != nil {
		t.request.Activity(activity)
	}
}

func (t *documentAgentActivityTracker) nextID(prefix string) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.sequence++
	return fmt.Sprintf("adk-%s-%d", prefix, t.sequence)
}

func (t *documentAgentActivityTracker) nextRound() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.round++
	return t.round
}

func describeDocumentAgentTool(name, arguments string) kb.DocumentAgentActivity {
	args := map[string]any{}
	_ = json.Unmarshal([]byte(arguments), &args)
	path := safeDocumentAgentVirtualPath(firstDocumentAgentString(args, "file_path", "path"))

	switch name {
	case "read_file":
		title := documentAgentReadTitle(path)
		return kb.DocumentAgentActivity{Kind: "tool", Title: title, Detail: documentAgentReadDetail(path, args)}
	case "ls":
		return kb.DocumentAgentActivity{Kind: "tool", Title: "浏览 Agent 工作区", Detail: path}
	case "glob":
		return kb.DocumentAgentActivity{Kind: "tool", Title: "扫描工作区文件", Detail: path}
	case "grep":
		title := "检索文档内容"
		if strings.HasPrefix(path, "/knowledge-base/") {
			title = "检索知识库已有 Wiki 页面"
		}
		return kb.DocumentAgentActivity{Kind: "tool", Title: title, Detail: path}
	case "write_file":
		return kb.DocumentAgentActivity{Kind: "tool", Title: documentAgentWriteTitle(path, false), Detail: path}
	case "edit_file":
		return kb.DocumentAgentActivity{Kind: "tool", Title: documentAgentWriteTitle(path, true), Detail: path}
	case "write_todos":
		return kb.DocumentAgentActivity{Kind: "plan", Title: "更新 Agent 执行计划", Detail: documentAgentTodoCount(args)}
	case "task":
		subagent := firstDocumentAgentString(args, "subagent_type")
		return kb.DocumentAgentActivity{Kind: "delegation", Title: "委派子 Agent 分析文档", Detail: safeDocumentAgentToolName(subagent)}
	default:
		return kb.DocumentAgentActivity{Kind: "tool", Title: "执行 Agent 工具", Detail: safeDocumentAgentToolName(name)}
	}
}

func documentAgentReadTitle(path string) string {
	switch {
	case path == "/document/manifest.md":
		return "读取文档清单"
	case strings.HasPrefix(path, "/document/parts/"):
		return "阅读正文分卷"
	case path == "/knowledge-base/existing-pages.json":
		return "读取知识库已有 Wiki 摘要"
	case strings.HasPrefix(path, "/work/"):
		return "读取阶段性分析"
	case path == documentAgentResultPath:
		return "检查最终抽取结果"
	default:
		return "读取 Agent 工作区文件"
	}
}

func documentAgentWriteTitle(path string, editing bool) string {
	switch {
	case path == documentAgentResultPath:
		return "写入最终知识抽取结果"
	case strings.HasPrefix(path, "/work/") && editing:
		return "更新阶段性分析"
	case strings.HasPrefix(path, "/work/"):
		return "保存阶段性分析"
	case editing:
		return "更新 Agent 工作区文件"
	default:
		return "写入 Agent 工作区文件"
	}
}

func documentAgentReadDetail(path string, args map[string]any) string {
	parts := make([]string, 0, 2)
	if path != "" {
		parts = append(parts, path)
	}
	offset := documentAgentInt(args["offset"])
	limit := documentAgentInt(args["limit"])
	if offset > 0 && limit > 0 {
		parts = append(parts, fmt.Sprintf("从第 %d 行读取 %d 行", offset, limit))
	} else if offset > 0 {
		parts = append(parts, fmt.Sprintf("从第 %d 行继续读取", offset))
	} else if limit > 0 {
		parts = append(parts, fmt.Sprintf("读取前 %d 行", limit))
	} else if path != "" {
		parts = append(parts, "读取完整文件")
	}
	return strings.Join(parts, " · ")
}

func documentAgentTodoCount(args map[string]any) string {
	if todos, ok := args["todos"].([]any); ok {
		return fmt.Sprintf("共 %d 项任务", len(todos))
	}
	return ""
}

func safeDocumentAgentVirtualPath(value string) string {
	if value == "" {
		return ""
	}
	path := normalizeDocumentAgentPath(value)
	for _, prefix := range []string{"/document/", "/knowledge-base/", "/work/", "/output/"} {
		if strings.HasPrefix(path, prefix) {
			return truncateDocumentAgentActivity(path, 120)
		}
	}
	return ""
}

func safeDocumentAgentToolName(value string) string {
	var builder strings.Builder
	for _, current := range value {
		if (current >= 'a' && current <= 'z') || (current >= 'A' && current <= 'Z') ||
			(current >= '0' && current <= '9') || current == '-' || current == '_' {
			builder.WriteRune(current)
		}
	}
	return truncateDocumentAgentActivity(builder.String(), 48)
}

func firstDocumentAgentString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := values[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func documentAgentInt(value any) int {
	switch current := value.(type) {
	case float64:
		return int(current)
	case int:
		return current
	default:
		return 0
	}
}

func documentAgentDisplayName(name string) string {
	if strings.Contains(strings.ToLower(name), "knowledge-document-extractor") {
		return "主 Agent"
	}
	if strings.TrimSpace(name) != "" {
		return "子 Agent"
	}
	return "ADK"
}

func truncateDocumentAgentActivity(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}
