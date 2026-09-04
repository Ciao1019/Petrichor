package aicore

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/adk/filesystem"
	"github.com/cloudwego/eino/schema"

	"petrichor/api/internal/kb"
)

func TestPrepareDocumentAgentWorkspaceKeepsWholeDocumentAndTracksReads(t *testing.T) {
	request := kb.DocumentAgentRequest{
		Chunks: []kb.DocumentAgentChunk{
			{ChunkKey: "chunk-001", HeadingPath: []string{"开始"}, ContentMd: strings.Repeat("甲", 10_000)},
			{ChunkKey: "chunk-002", HeadingPath: []string{"中间"}, ContentMd: strings.Repeat("乙", 10_000)},
			{ChunkKey: "chunk-003", HeadingPath: []string{"结束"}, ContentMd: strings.Repeat("丙", 10_000)},
		},
		ExistingPages: []kb.DocumentAgentExistingPage{{
			PageKey: "concept-existing", Kind: "concept", Title: "既有概念",
		}},
	}
	progress := []string{}
	backend := newTrackedDocumentBackend(func(completed, total int) {
		progress = append(progress, fmt.Sprintf("%d/%d", completed, total))
	})
	if err := prepareDocumentAgentWorkspace(context.Background(), backend, request); err != nil {
		t.Fatal(err)
	}
	if backend.unreadCount() != 3 {
		t.Fatalf("未读正文分卷=%d，期望 3", backend.unreadCount())
	}
	if _, err := backend.Read(context.Background(), &filesystem.ReadRequest{
		FilePath: "/document/parts/part-001.md", Limit: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if backend.unreadCount() != 3 {
		t.Fatal("只读取正文分卷第一行不能算作完整覆盖")
	}

	manifest, err := backend.Read(context.Background(), &filesystem.ReadRequest{FilePath: "/document/manifest.md"})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"chunk-001", "chunk-002", "chunk-003"} {
		if !strings.Contains(manifest.Content, key) {
			t.Fatalf("manifest 遗漏 %s", key)
		}
	}
	paths := []string{
		"/document/parts/part-001.md", "/document/parts/part-002.md", "/document/parts/part-003.md",
	}
	markers := []string{"甲", "乙", "丙"}
	for index, path := range paths {
		content, readErr := backend.Read(context.Background(), &filesystem.ReadRequest{FilePath: path})
		if readErr != nil {
			t.Fatal(readErr)
		}
		if !strings.Contains(content.Content, markers[index]) {
			t.Fatalf("%s 正文不完整", path)
		}
	}
	if backend.unreadCount() != 0 {
		t.Fatalf("全部读取后仍有 %d 个未读分卷", backend.unreadCount())
	}
	if strings.Join(progress, ",") != "1/3,2/3,3/3" {
		t.Fatalf("分卷读取进度=%v", progress)
	}

	existing, err := backend.Read(context.Background(), &filesystem.ReadRequest{FilePath: "/knowledge-base/existing-pages.json"})
	if err != nil || !strings.Contains(existing.Content, `"pageKey": "concept-existing"`) {
		t.Fatalf("既有页面目录异常：content=%q err=%v", existing.Content, err)
	}
}

func TestDocumentAgentActivityTrackerReportsToolsWithoutLeakingArguments(t *testing.T) {
	activities := []kb.DocumentAgentActivity{}
	tracker := newDocumentAgentActivityTracker(kb.DocumentAgentRequest{
		Activity: func(activity kb.DocumentAgentActivity) {
			activities = append(activities, activity)
		},
	})
	tracker.handle(&adk.AgentEvent{
		AgentName: "knowledge-document-extractor",
		Output: &adk.AgentOutput{MessageOutput: &adk.MessageVariant{Message: &schema.Message{
			Role: schema.Assistant,
			ToolCalls: []schema.ToolCall{{ID: "call-read", Function: schema.FunctionCall{
				Name: "read_file", Arguments: `{"file_path":"/document/parts/part-002.md","offset":100,"limit":50}`,
			}}},
		}}},
	})
	tracker.handle(&adk.AgentEvent{
		AgentName: "knowledge-document-extractor",
		Output: &adk.AgentOutput{MessageOutput: &adk.MessageVariant{Message: &schema.Message{
			Role: schema.Tool, ToolCallID: "call-read", ToolName: "read_file", Content: "机密正文",
		}}},
	})

	if len(activities) != 2 {
		t.Fatalf("activities=%#v", activities)
	}
	if activities[0].Status != "running" || activities[1].Status != "completed" || activities[0].ID != activities[1].ID {
		t.Fatalf("工具状态未按 call ID 更新：%#v", activities)
	}
	if activities[0].Title != "阅读正文分卷" || !strings.Contains(activities[0].Detail, "part-002.md") {
		t.Fatalf("读取动作描述异常：%#v", activities[0])
	}
	if strings.Contains(fmt.Sprintf("%#v", activities), "机密正文") {
		t.Fatal("活动事件泄露了工具结果")
	}

	for _, test := range []struct {
		name string
		args string
	}{
		{name: "grep", args: `{"pattern":"不可泄露的检索词","path":"/knowledge-base/existing-pages.json"}`},
		{name: "write_file", args: `{"file_path":"/work/notes.json","content":"不可泄露的阶段内容"}`},
		{name: "task", args: `{"subagent_type":"general-purpose","description":"不可泄露的委派提示"}`},
	} {
		activity := describeDocumentAgentTool(test.name, test.args)
		serialized := fmt.Sprintf("%#v", activity)
		if strings.Contains(serialized, "不可泄露") {
			t.Fatalf("%s 活动泄露参数：%s", test.name, serialized)
		}
	}
}

func TestDocumentAgentSummaryTokenLimitUsesModelContextWindow(t *testing.T) {
	cases := []struct {
		contextWindow int64
		want          int
	}{
		{contextWindow: 0, want: 64_000},
		{contextWindow: 60_000, want: 40_000},
		{contextWindow: 1_000_000, want: 120_000},
		{contextWindow: 6_000, want: 8_000},
	}
	for _, current := range cases {
		if got := documentAgentSummaryTokenLimit(current.contextWindow); got != current.want {
			t.Fatalf("contextWindow=%d got=%d want=%d", current.contextWindow, got, current.want)
		}
	}
}

func TestDocumentAgentInstructionRequiresGlobalCoverageAndGrounding(t *testing.T) {
	instruction := documentAgentInstruction(kb.DocumentAgentRequest{
		MaxCandidates: 36,
		CompileGuide:  "术语必须使用中文全称。",
	})
	for _, expected := range []string{
		"读取每一个正文分卷", "跨分卷去重", "sourceChunkKeys", "最多 36 个",
		"/output/result.json", "术语必须使用中文全称。",
	} {
		if !strings.Contains(instruction, expected) {
			t.Fatalf("Agent 指令缺少 %q", expected)
		}
	}
}

func TestSplitDocumentAgentPartsDoesNotDropOversizedChunk(t *testing.T) {
	chunks := []kb.DocumentAgentChunk{
		{ChunkKey: "chunk-001", ContentMd: strings.Repeat("甲", documentAgentPartMaxChars+1)},
		{ChunkKey: "chunk-002", ContentMd: "尾部标记"},
	}
	parts := splitDocumentAgentParts(chunks)
	if len(parts) != 2 || len(parts[0].chunks) != 1 || len(parts[1].chunks) != 1 {
		t.Fatalf("parts=%#v", parts)
	}
	if parts[1].chunks[0].ChunkKey != "chunk-002" {
		t.Fatal("超大切片后的尾部内容被丢失")
	}
}
