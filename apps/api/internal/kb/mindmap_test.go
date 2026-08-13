package kb

import (
	"encoding/json"
	"testing"
)

func TestExtractJSONObjectText(t *testing.T) {
	got, err := ExtractJSONObjectText("```json\n{\"nodeData\":{\"topic\":\"根\"}}\n```")
	if err != nil {
		t.Fatal(err)
	}
	if got != `{"nodeData":{"topic":"根"}}` {
		t.Fatalf("unexpected json text: %q", got)
	}

	got, err = ExtractJSONObjectText("说明文字 {\"a\":1} 尾部")
	if err != nil {
		t.Fatal(err)
	}
	if got != `{"a":1}` {
		t.Fatalf("unexpected extracted object: %q", got)
	}

	if _, err := ExtractJSONObjectText("not json"); err == nil {
		t.Fatal("expected error for invalid json text")
	}
}

func TestNormalizeMindmapModelOutputOutline(t *testing.T) {
	raw := map[string]any{
		"nodeData": map[string]any{
			"topic": "根主题",
			"children": []any{
				map[string]any{"topic": "子主题 A"},
				map[string]any{"topic": "子主题 B"},
			},
		},
	}
	data := NormalizeMindmapModelOutput(raw, "备用标题", MindmapModeOutline)
	if data.NodeData.ID != "root" {
		t.Fatalf("expected root id, got %q", data.NodeData.ID)
	}
	if data.NodeData.Topic != "根主题" {
		t.Fatalf("unexpected root topic: %q", data.NodeData.Topic)
	}
	if len(data.NodeData.Children) != 2 {
		t.Fatalf("expected 2 children, got %d", len(data.NodeData.Children))
	}
	if data.NodeData.Children[0].ID != "n1" {
		t.Fatalf("expected n1, got %q", data.NodeData.Children[0].ID)
	}
}

func TestBuildSimpleMindmapDataFromHeadings(t *testing.T) {
	content := "## A\n\n### A1\n\n## B\n"
	data := BuildSimpleMindmapData("文章", content, MindmapModeOutline)
	if len(data.NodeData.Children) != 2 {
		t.Fatalf("expected 2 top-level headings, got %d", len(data.NodeData.Children))
	}
	if data.NodeData.Children[0].Topic != "A" {
		t.Fatalf("unexpected first child topic: %q", data.NodeData.Children[0].Topic)
	}
	if len(data.NodeData.Children[0].Children) != 1 || data.NodeData.Children[0].Children[0].Topic != "A1" {
		t.Fatalf("unexpected nested heading structure: %+v", data.NodeData.Children[0].Children)
	}
}

func TestParseJSONOrNull(t *testing.T) {
	if ParseJSONOrNull("") != nil {
		t.Fatal("expected nil for empty string")
	}
	if ParseJSONOrNull("{bad") != nil {
		t.Fatal("expected nil for invalid json")
	}
	parsed := ParseJSONOrNull(`{"ok":true}`)
	obj, ok := parsed.(map[string]any)
	if !ok || obj["ok"] != true {
		t.Fatalf("unexpected parsed value: %#v", parsed)
	}
}

func TestMindmapDataJSONRoundTrip(t *testing.T) {
	data := BuildSimpleMindmapData("标题", "## 章节", MindmapModeOutline)
	b, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	var decoded MindmapData
	if err := json.Unmarshal(b, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.NodeData.Topic != data.NodeData.Topic {
		t.Fatalf("round trip topic mismatch: %q vs %q", decoded.NodeData.Topic, data.NodeData.Topic)
	}
}
