package kb

import (
	"strings"
	"testing"
)

func TestInboxValidation(t *testing.T) {
	for _, raw := range []map[string]any{
		{"contentMd": "  "}, {"contentMd": 42}, {"contentMd": strings.Repeat("字", 20001)},
		{"contentMd": "正文", "tags": "tag"}, {"contentMd": "正文", "tags": []any{1}},
		{"contentMd": "正文", "tags": []any{strings.Repeat("字", 81)}},
	} {
		if _, _, err := parseInboxContent(raw); err == nil {
			t.Fatalf("应拒绝输入: %#v", raw)
		}
	}
	content, tags, err := parseInboxContent(map[string]any{"contentMd": "  # 想法\n\n正文  ", "tags": []any{" 阅读 ", "阅读", ""}})
	if err != nil || content != "# 想法\n\n正文" || len(tags) != 1 || tags[0] != "阅读" {
		t.Fatal(content, tags, err)
	}
	if _, err := parseInboxList(map[string]any{"status": "deleted"}); err == nil {
		t.Fatal("应拒绝未知状态")
	}
	if _, err := parseInboxList(map[string]any{"pageNum": -1}); err == nil {
		t.Fatal("应拒绝负数页码")
	}
	in, err := parseInboxList(map[string]any{"pageSize": float64(1000)})
	if err != nil || in.Size != 50 || in.Page != 1 {
		t.Fatal(in, err)
	}
}

func TestInboxArchiveValidatesDestination(t *testing.T) {
	base := map[string]any{"id": "1", "version": float64(1), "knowledgeBaseId": "2", "title": "想法"}
	for _, value := range []any{"bad", float64(-1), []any{1}} {
		base["parentId"] = value
		if _, err := parseInboxArchive(base); err == nil {
			t.Fatalf("应拒绝文件夹 ID: %#v", value)
		}
	}
	base["parentId"] = nil
	in, err := parseInboxArchive(base)
	if err != nil || in.ParentID != nil || in.KnowledgeBaseID != 2 {
		t.Fatal(in, err)
	}
}

func TestInboxRichContent(t *testing.T) {
	content, meta, err := parseInboxRichContent(map[string]any{
		"contentJson":     `[{"type":"p", "children":[{"text":"随笔", "color":"red"}]}]`,
		"contentMetaJson": `{"discussions":[],"users":{}}`,
	})
	if err != nil || content == nil || meta == nil {
		t.Fatal(content, meta, err)
	}
	equivalent, _, err := parseInboxRichContent(map[string]any{"contentJson": `[{"children":[{"color":"red","text":"随笔"}],"type":"p"}]`})
	if err != nil || !equalInboxJSON(content, equivalent) {
		t.Fatal("重试必须忽略 JSON 键序和空白差异", err)
	}
	for _, raw := range []map[string]any{
		{"contentJson": "broken"}, {"contentJson": "{}"}, {"contentJson": 42},
		{"contentJson": "null"}, {"contentMetaJson": "[]"}, {"contentJson": strings.Repeat("x", 2*1024*1024+1)},
	} {
		if _, _, err := parseInboxRichContent(raw); err == nil {
			t.Fatal("应拒绝无效富文本数据")
		}
	}
	content, meta, err = parseInboxRichContent(map[string]any{})
	if err != nil || content != nil || meta != nil {
		t.Fatal("旧 Markdown 随笔必须继续可用", err)
	}
}
