package aicore

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"petrichor/api/internal/kb"
	"petrichor/api/internal/piruntime"
)

// 使用真实 Pi 进程与可控模型 HTTP 端点，验证全文读取、并行委派与最终文件形成闭环。
func TestDocumentPiBuildsResultWithDelegatedFullReads(t *testing.T) {
	var parents, children atomic.Int32
	resultJSON := `{"documentSummary":"首尾完整摘要","coveredChunkKeys":["chunk-a","chunk-b"],"entities":[],"concepts":[],"relations":[]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
			Tools []struct {
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			} `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
			http.Error(w, "bad", 400)
			return
		}
		parent := false
		for _, tool := range input.Tools {
			if tool.Function.Name == "task" {
				parent = true
			}
		}
		calls := []map[string]any{}
		text := "完成"
		addCall := func(name string, args any) {
			encoded, _ := json.Marshal(args)
			calls = append(calls, map[string]any{"index": len(calls), "id": fmt.Sprintf("call-%d", len(calls)), "type": "function", "function": map[string]any{"name": name, "arguments": string(encoded)}})
		}
		if parent {
			switch parents.Add(1) {
			case 1:
				addCall("read_file", map[string]any{"file_path": "/document/manifest.md"})
				addCall("task", map[string]any{"tasks": []map[string]any{
					{"description": "阅读全文 /document/parts/part-001.md"}, {"description": "阅读全文 /document/parts/part-002.md"},
				}})
			case 2:
				addCall("write_file", map[string]any{"file_path": documentAgentResultPath, "content": resultJSON})
			case 3:
			default:
				t.Error("主 Agent 未停止")
			}
		} else {
			children.Add(1)
			if input.Messages[len(input.Messages)-1].Role != "tool" {
				file := "/document/parts/part-001.md"
				for _, message := range input.Messages {
					if message.Role == "user" && strings.Contains(message.Content, "part-002") {
						file = "/document/parts/part-002.md"
					}
				}
				addCall("read_file", map[string]any{"file_path": file})
			} else {
				text = "已阅读全文，候选和 sourceChunkKeys 已核对"
			}
		}
		delta := map[string]any{"content": text}
		if len(calls) > 0 {
			delta["tool_calls"] = calls
		}
		encoded, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": delta}}})
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", encoded)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	request := kb.DocumentAgentRequest{KnowledgeBaseName: "测试库", ArticleTitle: "全文", Chunks: []kb.DocumentAgentChunk{
		{ChunkKey: "chunk-a", ContentMd: strings.Repeat("头部", 5000)}, {ChunkKey: "chunk-b", ContentMd: strings.Repeat("尾部", 5000)},
	}}
	activities := []kb.DocumentAgentActivity{}
	request.Activity = func(activity kb.DocumentAgentActivity) { activities = append(activities, activity) }
	backend := newTrackedDocumentBackend()
	if err := prepareDocumentAgentWorkspace(ctx, backend, request); err != nil {
		t.Fatal(err)
	}
	resolved := &ResolvedModel{ModelRef: "test-model", Runtime: RuntimeConfig{ProviderKey: "openai-compatible", BaseURL: server.URL}}
	_, err := executeDocumentPiAgent(ctx, resolved, request, backend, newDocumentAgentActivityTracker(request))
	if err != nil {
		t.Fatal(err)
	}
	if parents.Load() != 3 || children.Load() != 4 || backend.unreadCount() != 0 {
		t.Fatalf("parents=%d children=%d unread=%d", parents.Load(), children.Load(), backend.unreadCount())
	}
	result, err := backend.Read(ctx, &documentReadRequest{FilePath: documentAgentResultPath})
	if err != nil || result.Content != resultJSON {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if len(activities) < 8 {
		t.Fatalf("缺少主任务和子任务活动事件: %d", len(activities))
	}
}

func TestDocumentPiWorkspaceRejectsSourceMutationAndChildFinalWrites(t *testing.T) {
	ctx := context.Background()
	backend := newTrackedDocumentBackend()
	if err := prepareDocumentAgentWorkspace(ctx, backend, kb.DocumentAgentRequest{Chunks: []kb.DocumentAgentChunk{{ChunkKey: "a", ContentMd: "不能覆盖的原文"}}}); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		path  string
		child bool
	}{
		{"/document/parts/part-001.md", false}, {"/knowledge-base/existing-pages.json", false}, {"/work/../document/parts/part-001.md", false}, {documentAgentResultPath, true}, {"/etc/passwd", false},
	} {
		args, _ := json.Marshal(map[string]any{"file_path": item.path, "content": "覆盖"})
		if _, err := executeDocumentWorkspaceTool(ctx, backend, piruntime.ToolCall{Name: "write_file", Arguments: string(args)}, item.child); err == nil {
			t.Fatalf("越权写入: %+v", item)
		}
	}
	if backend.unreadCount() != 1 {
		t.Fatal("写入尝试绕过了全文覆盖校验")
	}
	if _, err := executeDocumentWorkspaceTool(ctx, backend, piruntime.ToolCall{Name: "grep", Arguments: `{"pattern":"原文"}`}, false); err != nil {
		t.Fatal(err)
	}
	if backend.unreadCount() != 1 {
		t.Fatal("检索不能算作完整读取")
	}
	for _, tool := range documentPiTools(true) {
		if tool.Name == "task" {
			t.Fatal("子任务获得了递归委派工具")
		}
	}
}

func TestDocumentReadCoverageCountsPaginatedBlankLines(t *testing.T) {
	backend := newTrackedDocumentBackend()
	ctx := context.Background()
	file := "/document/parts/part-001.md"
	if err := backend.Write(ctx, &documentWriteRequest{FilePath: file, Content: "正文\n\n"}); err != nil {
		t.Fatal(err)
	}
	backend.expect(file, "正文\n\n")
	for line := 1; line <= 3; line++ {
		if _, err := backend.Read(ctx, &documentReadRequest{FilePath: file, Offset: line, Limit: 1}); err != nil {
			t.Fatal(err)
		}
	}
	if backend.unreadCount() != 0 {
		t.Fatal("分页读到的空行没有计入覆盖")
	}
}
