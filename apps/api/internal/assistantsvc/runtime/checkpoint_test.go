package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"petrichor/api/internal/piruntime"
)

func TestRestoreCheckpointPreservesEvidenceIdentityAndBudget(t *testing.T) {
	saved := NewAgentStateStore("old", "thread", "user", "任务", ComplexitySimple, 1).Snapshot()
	saved.Evidence = []AgentEvidence{{ID: "ev-fixed", Source: EvidenceKnowledge, SourceID: "source", Content: "证据"}}
	saved.Observations = []AgentObservation{{ID: "ob-fixed", Type: "read", EvidenceIDs: []string{"ev-fixed"}}}
	saved.ToolCallCount = 4
	saved.TokenUsage.Input = 100
	saved.LoadedSkills = []string{"knowledge"}
	state := NewAgentStateStore("new", "thread", "user", "任务", ComplexitySimple, 2)
	observations, evidence := NewObservationStore(), NewEvidenceStore()
	restoreRunState(state, saved, observations, evidence)
	if state.Current().RunID != "new" || state.Current().ToolCallCount != 4 || evidence.Get("ev-fixed") == nil || observations.All()[0].EvidenceIDs[0] != "ev-fixed" {
		t.Fatal("检查点恢复丢失身份或预算")
	}
	state.state.Goal = "changed"
	if saved.Goal == "changed" {
		t.Fatal("恢复状态与源快照共享内存")
	}
}

func TestRuntimeResumesWithStoredObservationsAndSkillInstructions(t *testing.T) {
	server := newOpenAIStreamServer(t, func(call int, request map[string]any) []string {
		if call == 1 {
			messages, _ := json.Marshal(request["messages"])
			if !strings.Contains(string(messages), "已读取并保存的事实") || !strings.Contains(string(messages), "文件技能的规则") {
				t.Errorf("未恢复观察或技能: %s", messages)
			}
		}
		return []string{`{"choices":[{"delta":{"content":"已基于保存的资料完成整理。"}}]}`, `{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}`}
	})
	defer server.Close()
	skills, tools := NewSkillRegistry(), NewToolRegistry()
	skills.Register(AgentSkill{ID: "custom", Instructions: "文件技能的规则"})
	runtime := &PetrichorAgentRuntime{tools: tools, skills: skills, permissions: NewDefaultPermissionResolver(tools.Get)}
	saved := NewAgentStateStore("old", "thread", "1", "整理保存的资料", ComplexitySimple, 1).Snapshot()
	saved.LoadedSkills = []string{"custom"}
	saved.ToolCallCount = 2
	saved.Observations = []AgentObservation{{ID: "old-observation", Type: "tool_result", Summary: "已读取并保存的事实", Data: json.RawMessage(`{"saved":true}`)}}
	checkpoints := 0
	result, err := runtime.Run(context.Background(), &RunRequest{RunKey: "resumed", ConversationID: "thread", UserID: 1, Goal: saved.Goal, Model: testResolvedModel(server.URL), ResumeState: saved, Checkpoint: func(state *AgentState, pending *PendingTool) error { checkpoints++; return nil }})
	if err != nil || result.State.ToolCallCount != 2 || result.State.Status != StatusCompleted || checkpoints < 2 {
		t.Fatalf("恢复运行失败: %+v %v checkpoints=%d", result, err, checkpoints)
	}
}

func TestSteeringReplacesIntermediateAnswer(t *testing.T) {
	server := newOpenAIStreamServer(t, func(call int, request map[string]any) []string {
		return []string{fmt.Sprintf(`{"choices":[{"delta":{"content":"回答%d"}}]}`, call)}
	})
	defer server.Close()
	polls := 0
	result, err := RunAgentSegment(context.Background(), &SegmentRequest{Model: testResolvedModel(server.URL), Prompt: "任务", MaxSteps: 4,
		Controls: func(context.Context) ([]piruntime.Control, error) {
			polls++
			if polls == 1 {
				return []piruntime.Control{{Sequence: 1, Mode: "steer", Text: "即时补充"}, {Sequence: 2, Mode: "follow_up", Text: "后续补充"}}, nil
			}
			return nil, nil
		},
	}, NewSegmentController())
	if err != nil || result.Text != "回答3" {
		t.Fatalf("拼接了旧回答: %+v %v", result, err)
	}
}

func TestControlsPersistBeforeReturningToPi(t *testing.T) {
	state := NewAgentStateStore("run", "thread", "user", "任务", ComplexitySimple, 1)
	saved := false
	request := &RunRequest{Controls: func(context.Context, int64) ([]piruntime.Control, error) {
		return []piruntime.Control{{Sequence: 1, Mode: "steer", Text: "补充"}}, nil
	}, Checkpoint: func(s *AgentState, p *PendingTool) error {
		saved = s.ControlSequence == 1 && s.Goal == "任务\n\n用户补充要求：\n补充"
		return nil
	}}
	out, err := pollRunControls(context.Background(), request, state, NewAgentEventEmitter("run", nil))
	if err != nil || len(out) != 1 || !saved {
		t.Fatalf("未先持久化补充: %v", err)
	}
}
