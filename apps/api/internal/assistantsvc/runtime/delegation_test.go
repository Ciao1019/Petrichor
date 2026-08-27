package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDelegateManyKeepsPartialSuccessAndStableTaskIDs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		defer request.Body.Close()
		var payload map[string]any
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			http.Error(writer, "bad request", http.StatusBadRequest)
			return
		}
		serialized, _ := json.Marshal(payload["messages"])
		if strings.Contains(string(serialized), "失败主题") {
			http.Error(writer, "upstream failed", http.StatusBadGateway)
			return
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(writer, "data: {\"choices\":[{\"delta\":{\"content\":\"成功结论\"}}]}\n\n")
		_, _ = fmt.Fprint(writer, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\n")
		_, _ = fmt.Fprint(writer, "data: [DONE]\n\n")
	}))
	defer server.Close()

	registry := NewToolRegistry()
	registry.Register(&AgentToolDefinition{
		ID: "knowledge.test", Name: "knowledge_test", Namespace: NamespaceKnowledge,
		Description: "测试只读工具", InputSchema: json.RawMessage(`{"type":"object","properties":{}}`),
		RiskLevel: RiskLow,
		Execute:   func(_ *ToolExecutionContext, input any) (any, error) { return input, nil },
	})
	runtime := &PetrichorAgentRuntime{
		tools: registry, skills: NewSkillRegistry(),
		permissions: NewDefaultPermissionResolver(func(toolID string) *AgentToolDefinition { return registry.Get(toolID) }),
	}
	startedAt := nowMs()
	state := NewAgentStateStore("run-parent", "conversation", "1", "比较两个主题", ComplexityMultiStep, startedAt)
	evidence := NewEvidenceStore()
	trace := NewTraceCollector("run-parent", "conversation", "1", "model", startedAt)
	eventsSeen := []*AgentStreamEvent{}
	events := NewAgentEventEmitter("run-parent", func(event *AgentStreamEvent) { eventsSeen = append(eventsSeen, event) })
	budgetConfig := AgentBudget{MaxIterations: 8, MaxToolCalls: 12, MaxExecutionMs: 30_000, MaxSubAgents: 2}
	budget := NewBudgetTracker(budgetConfig, startedAt)
	stopPolicy := NewStopPolicy(StopPolicyConfig{
		AgentBudget: budgetConfig, MaxDelegationDepth: 2, MaxNoProgressIterations: 3,
	}, budget, NewLoopDetector(4))
	request := &RunRequest{
		ConversationID: "conversation", UserID: 1, SystemRole: "USER", Model: testResolvedModel(server.URL),
		ModelName: "test-model", Goal: "比较两个主题",
	}
	inputs := []DelegateTaskInput{
		{Objective: "成功主题", AllowedToolIDs: []string{"knowledge.test"}},
		{Objective: "失败主题", AllowedToolIDs: []string{"knowledge.test"}},
	}

	results := runtime.delegateMany(context.Background(), request, inputs, state, evidence, trace, events, budget, stopPolicy, 0)
	if len(results) != 2 || results[0].Status != "completed" || results[1].Status != "failed" {
		t.Fatalf("delegation should keep ordered partial results: %+v", results)
	}
	if results[0].TaskID == "" || results[1].TaskID == "" || results[0].TaskID == results[1].TaskID {
		t.Fatalf("task ids must be stable and unique: %+v", results)
	}
	if evidence.Size() != 1 || state.Current().DelegationCount != 2 || budget.SubAgentCount() != 2 {
		t.Fatalf("parent merge/count mismatch: evidence=%d state=%+v budget=%d", evidence.Size(), state.Current(), budget.SubAgentCount())
	}
	if state.Current().TokenUsage.Total != 7 {
		t.Fatalf("successful child usage must merge into parent: %+v", state.Current().TokenUsage)
	}

	startedIDs := map[string]bool{}
	finishedIDs := map[string]bool{}
	for _, event := range eventsSeen {
		var payload map[string]any
		_ = json.Unmarshal(event.Payload, &payload)
		taskID, _ := payload["taskId"].(string)
		switch event.Type {
		case "delegation_started":
			startedIDs[taskID] = true
		case "delegation_completed", "delegation_failed":
			finishedIDs[taskID] = true
		}
	}
	for _, result := range results {
		if !startedIDs[result.TaskID] || !finishedIDs[result.TaskID] {
			t.Fatalf("start/end events must use result task id %q: events=%+v", result.TaskID, eventsSeen)
		}
	}
}

func TestDelegateManyRejectsOverflowWithoutRunningIt(t *testing.T) {
	registry := NewToolRegistry()
	runtime := &PetrichorAgentRuntime{tools: registry, skills: NewSkillRegistry()}
	startedAt := nowMs()
	state := NewAgentStateStore("run-parent", "conversation", "1", "goal", ComplexityMultiStep, startedAt)
	budgetConfig := AgentBudget{MaxIterations: 4, MaxToolCalls: 4, MaxExecutionMs: 30_000, MaxSubAgents: 1}
	budget := NewBudgetTracker(budgetConfig, startedAt)
	stopPolicy := NewStopPolicy(StopPolicyConfig{AgentBudget: budgetConfig, MaxDelegationDepth: 2, MaxNoProgressIterations: 3}, budget, NewLoopDetector(4))
	results := runtime.delegateMany(context.Background(), &RunRequest{}, []DelegateTaskInput{
		{Objective: "first"}, {Objective: "overflow"},
	}, state, NewEvidenceStore(), NewTraceCollector("run", "c", "1", "m", startedAt), NewAgentEventEmitter("run", nil), budget, stopPolicy, 0)
	if len(results) != 2 || !strings.Contains(results[1].Summary, "数量上限") || budget.SubAgentCount() != 1 {
		t.Fatalf("overflow must be rejected without consuming quota: results=%+v count=%d", results, budget.SubAgentCount())
	}
}
