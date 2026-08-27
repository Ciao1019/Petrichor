package kb

import (
	"reflect"
	"sort"
	"testing"
)

func TestExtractS4ObjectKeysFromArticleContent(t *testing.T) {
	contentJSON := `{"type":"doc","content":[{"attrs":{"src":"s4key:uploads/7/json.png"}},{"text":"附件 s4key:uploads/7/file.pdf"},{"text":"s4key:uploads/8/foreign.png"}]}`
	keys := ExtractS4ObjectKeysFromArticleContent(&contentJSON,
		`![正文](s4key:uploads/7/markdown.png) 重复 s4key:uploads/7/json.png`, 7)
	sort.Strings(keys)
	want := []string{"uploads/7/file.pdf", "uploads/7/json.png", "uploads/7/markdown.png"}
	if !reflect.DeepEqual(keys, want) {
		t.Fatalf("keys = %#v, want %#v", keys, want)
	}
}

func TestExtractS4ObjectKeysFallsBackToRawInvalidJSON(t *testing.T) {
	contentJSON := `{"broken":"s4key:uploads/3/fallback.png"`
	keys := ExtractS4ObjectKeysFromArticleContent(&contentJSON, "", 3)
	if len(keys) != 1 || keys[0] != "uploads/3/fallback.png" {
		t.Fatalf("keys = %#v", keys)
	}
}

func TestRemovedS4ObjectKeys(t *testing.T) {
	removed := RemovedS4ObjectKeys(
		[]string{"uploads/1/keep.png", "uploads/1/remove.png"},
		[]string{"uploads/1/keep.png", "uploads/1/new.png"},
	)
	if len(removed) != 1 || removed[0] != "uploads/1/remove.png" {
		t.Fatalf("removed = %#v", removed)
	}
}
