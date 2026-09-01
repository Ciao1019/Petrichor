package assistantsvc

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	rt "petrichor/api/internal/assistantsvc/runtime"
)

func TestOutlineToolRegisteredWithReadOnlyContract(t *testing.T) {
	registry := rt.NewToolRegistry()
	registerOutlineTools(registry)
	tool := registry.Get("knowledge.outline")
	if tool == nil {
		t.Fatal("knowledge.outline 未注册")
	}
	if tool.Name != "read_document_outline" {
		t.Fatalf("对外工具名 = %q", tool.Name)
	}
	if tool.RiskLevel != rt.RiskLow {
		t.Fatalf("risk = %v，只读工具应为 low", tool.RiskLevel)
	}
	var schema map[string]any
	if err := json.Unmarshal(tool.InputSchema, &schema); err != nil {
		t.Fatalf("input schema 不是合法 JSON：%v", err)
	}
	required, _ := schema["required"].([]any)
	if len(required) != 1 || required[0] != "articleId" {
		t.Fatalf("required = %#v，articleId 必填", required)
	}
}

func TestParseHeadingPath(t *testing.T) {
	if got := parseHeadingPath(`["安装", " 快速开始 ", ""]`); !reflect.DeepEqual(got, []string{"安装", "快速开始"}) {
		t.Fatalf("parseHeadingPath = %#v，应去空白并丢弃空项", got)
	}
	if got := parseHeadingPath(""); got != nil {
		t.Fatalf("空串应返回 nil，实际 %#v", got)
	}
	if got := parseHeadingPath("{不是数组"); got != nil {
		t.Fatalf("非法 JSON 应返回 nil，实际 %#v", got)
	}
}

func TestNormalizeOutlineOutputSummaries(t *testing.T) {
	result := normalizeOutlineOutput(map[string]any{
		"title": "小鼹鼠", "source": "wiki_tree", "nodeCount": 12, "truncated": false,
		"nodes": []outlineNode{{NodeKey: "n1", Title: "安装"}},
	}, nil)
	if result.Summary != "《小鼹鼠》目录共 12 节" {
		t.Fatalf("summary = %q", result.Summary)
	}
	if !reflect.DeepEqual(result.SuggestedActions, []string{"knowledge.read_many", "knowledge.read"}) {
		t.Fatalf("拿到目录后应引导深读，实际 %#v", result.SuggestedActions)
	}

	fallback := normalizeOutlineOutput(map[string]any{
		"title": "文档", "source": "chunk_headings", "nodeCount": 200, "truncated": true,
	}, nil)
	if !strings.Contains(fallback.Summary, "来自分片标题") || !strings.Contains(fallback.Summary, "已截断") {
		t.Fatalf("兜底与截断都应在摘要里说明：%q", fallback.Summary)
	}

	empty := normalizeOutlineOutput(map[string]any{"title": "空文档", "source": "none", "nodeCount": 0}, nil)
	if !strings.Contains(empty.Summary, "还没有可用目录") {
		t.Fatalf("无目录时应提示先构建知识：%q", empty.Summary)
	}
	if !reflect.DeepEqual(empty.SuggestedActions, []string{"knowledge.search"}) {
		t.Fatalf("无目录时应回退到检索，实际 %#v", empty.SuggestedActions)
	}
}

func TestLimitStrings(t *testing.T) {
	if got := limitStrings([]string{"a", "b", "c", "d"}, 3); len(got) != 3 {
		t.Fatalf("limitStrings = %#v，应截到 3 项", got)
	}
	if got := limitStrings([]string{"a"}, 3); len(got) != 1 {
		t.Fatalf("不足上限时应原样返回，实际 %#v", got)
	}
	if got := limitStrings(nil, 3); got != nil {
		t.Fatalf("nil 应原样返回，实际 %#v", got)
	}
}
