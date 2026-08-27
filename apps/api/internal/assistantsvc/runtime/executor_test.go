package runtime

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestToolExecutorValidatesJSONSchemaBeforeExecution(t *testing.T) {
	executions := 0
	tool := &AgentToolDefinition{
		ID: "test.validated", Name: "validated", Namespace: NamespaceSystem,
		InputSchema: json.RawMessage(`{"type":"object","properties":{"query":{"type":"string","minLength":1},"limit":{"type":"integer","minimum":1,"maximum":3}},"required":["query"]}`),
		RiskLevel:   RiskLow,
		Execute: func(_ *ToolExecutionContext, input any) (any, error) {
			executions++
			return input, nil
		},
	}
	executor, execCtx := testExecutorForDefinition(tool, nil)

	outcome := executor.Execute(context.Background(), tool.ID, map[string]any{"query": "", "limit": float64(8)}, execCtx)
	if outcome.OK || outcome.Error == nil || outcome.Error.Code != CodeValidationError {
		t.Fatalf("invalid input must return validation error: %+v", outcome)
	}
	if executions != 0 {
		t.Fatalf("tool executed despite invalid input: %d", executions)
	}
	if !strings.Contains(outcome.Error.Message, "query") && !strings.Contains(outcome.Error.Message, "limit") {
		t.Fatalf("validation error should help the model repair arguments: %q", outcome.Error.Message)
	}

	outcome = executor.Execute(context.Background(), tool.ID, map[string]any{"query": "ok", "limit": float64(2)}, execCtx)
	if !outcome.OK || executions != 1 {
		t.Fatalf("valid input should execute once: outcome=%+v executions=%d", outcome, executions)
	}
}

func TestToolExecutorRejectsUnconfirmedToolWithoutConfirmationCallback(t *testing.T) {
	executed := false
	tool := &AgentToolDefinition{
		ID: "test.dangerous", Name: "dangerous", Namespace: NamespaceSystem,
		InputSchema: json.RawMessage(`{"type":"object","properties":{}}`),
		RiskLevel:   RiskHigh, SideEffect: true, RequiresConfirmation: true,
		Execute: func(_ *ToolExecutionContext, input any) (any, error) {
			executed = true
			return input, nil
		},
	}
	executor, execCtx := testExecutorForDefinition(tool, nil)
	outcome := executor.Execute(context.Background(), tool.ID, map[string]any{}, execCtx)
	if outcome.OK || outcome.Error == nil || outcome.Error.Code != CodePermissionDenied {
		t.Fatalf("missing confirmation callback must fail closed: %+v", outcome)
	}
	if executed {
		t.Fatal("confirmation-required tool was executed without a confirmation callback")
	}
}

func TestToolExecutorRunsConfirmedTool(t *testing.T) {
	executed := false
	tool := &AgentToolDefinition{
		ID: "test.confirmed", Name: "confirmed", Namespace: NamespaceSystem,
		InputSchema: json.RawMessage(`{"type":"object","properties":{}}`),
		RiskLevel:   RiskHigh, SideEffect: true, RequiresConfirmation: true,
		Execute: func(_ *ToolExecutionContext, input any) (any, error) {
			executed = true
			return input, nil
		},
	}
	executor, execCtx := testExecutorForDefinition(tool, func(*AgentToolDefinition, any) bool { return true })
	outcome := executor.Execute(context.Background(), tool.ID, map[string]any{}, execCtx)
	if !outcome.OK || !executed {
		t.Fatalf("confirmed tool should execute: %+v", outcome)
	}
}

func TestToolExecutorEmitsHumanReadableStartedTitle(t *testing.T) {
	tool := &AgentToolDefinition{
		ID: "knowledge.lookup", Name: "lookup_knowledge", Namespace: NamespaceKnowledge,
		InputSchema: json.RawMessage(`{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}`),
		RiskLevel:   RiskLow,
		Execute: func(_ *ToolExecutionContext, input any) (any, error) {
			return input, nil
		},
	}
	var started *AgentStreamEvent
	executor, execCtx := testExecutorForDefinitionWithSink(tool, nil, func(event *AgentStreamEvent) {
		if event.Type == "tool_started" {
			started = event
		}
	})
	outcome := executor.Execute(context.Background(), tool.ID, map[string]any{"query": "小鼹鼠是什么"}, execCtx)
	if !outcome.OK || started == nil {
		t.Fatalf("tool_started event missing: outcome=%+v event=%#v", outcome, started)
	}
	var payload struct {
		CallID    string `json:"callId"`
		ToolID    string `json:"toolId"`
		Namespace string `json:"namespace"`
		Title     string `json:"title"`
	}
	if err := json.Unmarshal(started.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.CallID == "" || payload.ToolID != tool.ID || payload.Namespace != string(NamespaceKnowledge) || payload.Title != "正在检索并阅读知识库：小鼹鼠是什么" {
		t.Fatalf("tool_started payload does not match TS contract: %#v", payload)
	}
}

func testExecutorForDefinition(tool *AgentToolDefinition, confirm func(*AgentToolDefinition, any) bool) (*ToolExecutor, *ToolExecutionContext) {
	return testExecutorForDefinitionWithSink(tool, confirm, nil)
}

func testExecutorForDefinitionWithSink(
	tool *AgentToolDefinition,
	confirm func(*AgentToolDefinition, any) bool,
	sink EventSink,
) (*ToolExecutor, *ToolExecutionContext) {
	registry := NewToolRegistry()
	registry.Register(tool)
	state := NewAgentStateStore("run-executor", "conversation", "1", "goal", ComplexitySimple, nowMs())
	executor := NewToolExecutor(&ToolExecutorDeps{
		Registry: registry,
		Permissions: NewDefaultPermissionResolver(func(toolID string) *AgentToolDefinition {
			return registry.Get(toolID)
		}),
		Observations: NewObservationStore(), Evidence: NewEvidenceStore(), State: state,
		Trace:        NewTraceCollector("run-executor", "conversation", "1", "model", nowMs()),
		LoopDetector: NewLoopDetector(4), Events: NewAgentEventEmitter("run-executor", sink),
		ConfirmSideEffect: confirm,
	})
	return executor, &ToolExecutionContext{
		Context: context.Background(), RunID: "run-executor", UserID: 1,
		ConversationID: "conversation", SystemRole: "USER", State: state.Current(),
	}
}
