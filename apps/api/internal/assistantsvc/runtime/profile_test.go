package runtime

import (
	"strings"
	"testing"
)

// 场景约束紧跟基础指令进入系统提示；默认 Runtime 不附加任何额外约束。
func TestRuntimeProfileInstructionsFollowBasePrompt(t *testing.T) {
	state := NewAgentStateStore("run", "conversation", "0", "目标", ComplexitySimple, 0)
	build := func(extra string) string {
		return NewContextManager(ResolveContextBudget(0)).Build(ContextBuildInput{
			State: state.Current(), Observations: NewObservationStore(), Evidence: NewEvidenceStore(),
			ProfileInstructions: extra,
		}).Instructions
	}
	withProfile := build("## 公开问答边界\n- 只读公开资料")
	base := strings.Index(withProfile, "你是 Petrichor 站内的主 Agent")
	profile := strings.Index(withProfile, "## 公开问答边界")
	if base != 0 || profile <= base {
		t.Fatalf("场景约束应紧跟基础指令：base=%d profile=%d", base, profile)
	}
	if strings.Contains(build(""), "公开问答边界") {
		t.Fatal("默认 Runtime 不应带公开约束")
	}
}

// 档位 Runtime 只认自己的注册表：默认注册表中的工具不可见。
func TestRuntimeProfileUsesOwnRegistry(t *testing.T) {
	tools := NewToolRegistry()
	tools.Register(&AgentToolDefinition{ID: "knowledge.lookup", Name: "lookup_knowledge", Namespace: NamespaceKnowledge, Core: true})
	runtime := NewRuntimeWithProfile(RuntimeProfile{Tools: tools, Instructions: "  约束  "})
	if runtime.tools != tools || runtime.instructions != "约束" {
		t.Fatal("档位未生效")
	}
	if runtime.permissions == nil {
		t.Fatal("档位缺少权限解析")
	}
	if NewRuntimeWithProfile(RuntimeProfile{}).tools.Has("knowledge.lookup") {
		t.Fatal("空档位不应继承默认注册表")
	}
}
