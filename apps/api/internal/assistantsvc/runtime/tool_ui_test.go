package runtime

import "testing"

func TestToolActivityTitleMatchesStreamingContract(t *testing.T) {
	got := toolActivityTitle("knowledge.lookup", map[string]any{"query": "小鼹鼠是什么"})
	if got != "正在检索并阅读知识库：小鼹鼠是什么" {
		t.Fatalf("unexpected tool activity title: %q", got)
	}
	if fallback := toolActivityTitle("unknown.tool", nil); fallback != "正在处理" {
		t.Fatalf("unknown tools must have a stable fallback: %q", fallback)
	}
}
