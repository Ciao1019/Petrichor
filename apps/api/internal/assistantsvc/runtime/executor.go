package runtime

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"

	aicore "petrichor/api/internal/aicore"
)

// ===== 统一工具执行器（对照 tool-executor.ts）=====

// ToolExecutorDeps 执行器依赖。
type ToolExecutorDeps struct {
	Registry     *AgentToolRegistry
	Permissions  PermissionResolver
	Observations *ObservationStore
	Evidence     *EvidenceStore
	State        *AgentStateStore
	Trace        *TraceCollector
	LoopDetector *LoopDetector
	Events       *AgentEventEmitter

	AllowedToolIDs    []string
	ConfirmSideEffect func(tool *AgentToolDefinition, input any) bool
	ClampTimeout      func(desiredMs int64) int64
	OnToolTrace       func(trace AgentToolTrace)
}

// ToolRunOutcome 执行结果 + 观察 + 证据。
type ToolRunOutcome struct {
	OK         bool
	Output     any
	Error      *AgentToolErrorShape
	DurationMs int64
	Retries    int
	ToolID     string

	Observation             AgentObservation
	Evidence                []*AgentEvidence
	EvidenceCitationIndices []int
}

// ToolExecutor 任何工具调用都必须经过这里：
// 权限 → 参数校验 → 副作用确认 → 超时 → 重试 → Trace → Observation → Evidence → 循环登记。
type ToolExecutor struct {
	deps *ToolExecutorDeps
}

// NewToolExecutor 构造。
func NewToolExecutor(deps *ToolExecutorDeps) *ToolExecutor {
	return &ToolExecutor{deps: deps}
}

var callCounter atomic.Int64

func newCallID() string {
	return NewID("call") + itoa(int(callCounter.Add(1))%10000)
}

// Execute 执行一次工具调用。
func (e *ToolExecutor) Execute(ctx context.Context, toolID string, rawInput any, execCtx *ToolExecutionContext) ToolRunOutcome {
	startedAt := nowMs()
	callID := newCallID()
	tool := e.deps.Registry.Get(toolID)

	if tool == nil {
		return e.fail(ctx, callID, &AgentToolDefinition{ID: toolID, Name: toolID, Namespace: NamespaceSystem},
			ValidationError("未注册的工具："+toolID), rawInput, startedAt, 0, "allowed")
	}

	e.deps.Events.Emit("tool_started", map[string]any{
		"callId":    callID,
		"toolId":    tool.ID,
		"namespace": tool.Namespace,
	})

	// 1) 权限：拒绝即不执行、不重试、Trace permission_denied
	decision := e.deps.Permissions.CanUseTool(execCtx.UserID, tool.ID, PermissionContext{
		UserID:          execCtx.UserID,
		SystemRole:      execCtx.SystemRole,
		DelegationDepth: execCtx.DelegationDepth,
		AllowedToolIDs:  e.deps.AllowedToolIDs,
	})
	if !decision.Allowed {
		reason := decision.Reason
		if reason == "" {
			reason = "无权使用工具 " + tool.ID
		}
		return e.fail(ctx, callID, tool, PermissionDenied(reason), rawInput, startedAt, 0, "denied")
	}

	input := rawInput

	// 2) 副作用确认：返回 false 拒绝执行
	if tool.RequiresConfirmation && e.deps.ConfirmSideEffect != nil {
		if !e.deps.ConfirmSideEffect(tool, input) {
			return e.fail(ctx, callID, tool,
				PermissionDenied("操作 "+tool.ID+" 需要用户确认，尚未获得确认"), input, startedAt, 0, "denied")
		}
	}

	// 3) 执行 + 超时 + 有限重试
	maxRetries := tool.MaxRetries
	if maxRetries == 0 {
		maxRetries = ToolDefaultMaxRetries()
	}
	desiredTimeout := tool.TimeoutMs
	if desiredTimeout == 0 {
		desiredTimeout = ToolDefaultTimeoutMs()
	}
	timeoutMs := desiredTimeout
	if e.deps.ClampTimeout != nil {
		timeoutMs = e.deps.ClampTimeout(desiredTimeout)
	}
	if timeoutMs <= 0 {
		timeoutMs = desiredTimeout
	}

	retries := 0
	var lastError *AgentError
	for {
		output, err := runToolWithTimeout(ctx, tool, execCtx, input, timeoutMs)
		if err == nil {
			return e.succeed(callID, tool, input, output, startedAt, retries)
		}
		lastError = NormalizeAgentError(err)
		if !lastError.Retryable || ctx.Err() != nil {
			break
		}
		retries++
		if retries > maxRetries {
			break
		}
		e.deps.Events.Emit("tool_failed", map[string]any{
			"callId": callID, "toolId": tool.ID, "namespace": tool.Namespace,
			"errorCode": lastError.Code, "message": UserFacingMessage(lastError),
			"durationMs": nowMs() - startedAt, "willRetry": true,
		})
	}

	return e.fail(ctx, callID, tool, lastError, input, startedAt, retries, "allowed")
}

func (e *ToolExecutor) succeed(callID string, tool *AgentToolDefinition, input any, output any, startedAt int64, retries int) ToolRunOutcome {
	durationMs := nowMs() - startedAt

	summary := ""
	var data json.RawMessage
	var suggestedActions []string
	var evidenceInputs []EvidenceInput
	progressPtr := (*bool)(nil)

	if tool.Normalize != nil {
		normalized := tool.Normalize(output, input)
		summary = normalized.Summary
		data = normalized.Data
		suggestedActions = normalized.SuggestedActions
		evidenceInputs = normalized.Evidence
		progressPtr = normalized.Progress
	}
	if summary == "" {
		summary = DefaultSummarize(tool.ID, output)
	}

	added := e.deps.Evidence.AddMany(evidenceInputs)
	evidenceIDs := make([]string, 0, len(added))
	citationIndices := make([]int, 0, len(added))
	for _, item := range added {
		evidenceIDs = append(evidenceIDs, item.ID)
		citationIndices = append(citationIndices, e.deps.Evidence.CitationIndex(item.ID))
	}

	observation := e.deps.Observations.Add(CreateObservation(
		strings.ReplaceAll(tool.ID, ".", "_"),
		tool.ID,
		summary,
		data,
		evidenceIDs,
		suggestedActions,
		false,
		nowMs(),
	))

	e.deps.State.AddObservation(observation)
	stateEvidence := make([]AgentEvidence, 0, len(added))
	for _, item := range added {
		stateEvidence = append(stateEvidence, *item)
	}
	e.deps.State.AddEvidence(stateEvidence)
	e.deps.State.IncrementToolCall()

	toolTrace := AgentToolTrace{
		ID:                 callID,
		ToolID:             tool.ID,
		ToolName:           tool.Name,
		Namespace:          string(tool.Namespace),
		Input:              input,
		RawOutput:          output,
		Summary:            summary,
		OK:                 true,
		DurationMs:         durationMs,
		Retries:            retries,
		EvidenceIDs:        evidenceIDs,
		PermissionDecision: "allowed",
		StartedAt:          startedAt,
	}
	e.deps.Trace.RecordToolCall(toolTrace)
	if diag := readRetrievalDiagnostics(tool.ID, output); diag != nil {
		e.deps.Trace.RecordRetrievalDiagnostics(diag)
	}
	if e.deps.OnToolTrace != nil {
		e.deps.OnToolTrace(toolTrace)
	}

	progressed := len(added) > 0
	if progressPtr != nil {
		progressed = *progressPtr
	}
	e.deps.LoopDetector.Record(tool.ID, input, output, progressed)

	e.deps.Events.Emit("tool_completed", map[string]any{
		"callId": callID, "toolId": tool.ID, "namespace": tool.Namespace,
		"summary": summary, "durationMs": durationMs, "evidenceIds": evidenceIDs,
	})
	publicObs := ToPublicObservation(observation)
	e.deps.Events.Emit("observation_created", map[string]any{"observation": publicObs})
	if len(added) > 0 {
		publicList := make([]PublicEvidence, 0, len(added))
		for _, item := range added {
			publicList = append(publicList, ToPublicEvidence(*item))
		}
		e.deps.Events.Emit("evidence_created", map[string]any{"evidence": publicList})
	}

	return ToolRunOutcome{
		OK: true, Output: output, DurationMs: durationMs, Retries: retries, ToolID: tool.ID,
		Observation: observation, Evidence: added, EvidenceCitationIndices: citationIndices,
	}
}

func (e *ToolExecutor) fail(_ context.Context, callID string, tool *AgentToolDefinition, agentErr *AgentError, input any, startedAt int64, retries int, permissionDecision string) ToolRunOutcome {
	durationMs := nowMs() - startedAt
	shape := agentErr.ToShape()
	observation := e.deps.Observations.Add(ErrorObservation(tool.ID, shape))

	e.deps.State.AddObservation(observation)
	// 失败也计入工具预算：否则连续失败会绕过 maxToolCalls 无限重试
	e.deps.State.IncrementToolCall()

	toolTrace := AgentToolTrace{
		ID:                 callID,
		ToolID:             tool.ID,
		ToolName:           tool.Name,
		Namespace:          string(tool.Namespace),
		Input:              input,
		Summary:            shape.Message,
		OK:                 false,
		ErrorCode:          shape.Code,
		DurationMs:         durationMs,
		Retries:            retries,
		EvidenceIDs:        []string{},
		PermissionDecision: permissionDecision,
		StartedAt:          startedAt,
	}
	e.deps.Trace.RecordToolCall(toolTrace)
	if e.deps.OnToolTrace != nil {
		e.deps.OnToolTrace(toolTrace)
	}
	e.deps.LoopDetector.Record(tool.ID, input, nil, false)

	e.deps.Events.Emit("tool_failed", map[string]any{
		"callId": callID, "toolId": tool.ID, "namespace": tool.Namespace,
		"errorCode": shape.Code, "message": UserFacingMessage(agentErr),
		"durationMs": durationMs, "willRetry": false,
	})
	publicObs := ToPublicObservation(observation)
	e.deps.Events.Emit("observation_created", map[string]any{"observation": publicObs})

	return ToolRunOutcome{
		OK: false, Error: &shape, DurationMs: durationMs, Retries: retries, ToolID: tool.ID,
		Observation: observation, Evidence: []*AgentEvidence{}, EvidenceCitationIndices: []int{},
	}
}

func readRetrievalDiagnostics(toolID string, output any) map[string]any {
	if toolID != "knowledge.search" && toolID != "knowledge.lookup" {
		return nil
	}
	record, ok := output.(map[string]any)
	if !ok {
		raw, err := json.Marshal(output)
		if err != nil || json.Unmarshal(raw, &record) != nil {
			return nil
		}
	}
	diag, ok := record["diagnostics"].(map[string]any)
	if !ok {
		return nil
	}
	return diag
}

// ObservationType 工具 id → observation.type。
func ObservationType(toolID string) string { return strings.ReplaceAll(toolID, ".", "_") }

// UserFacingMessage 面向用户的错误文案：不暴露堆栈与内部细节。
func UserFacingMessage(err *AgentError) string {
	switch err.Code {
	case CodeToolTimeout:
		return "该来源响应超时，正在尝试其它方式"
	case CodePermissionDenied:
		return "当前账号没有执行该操作的权限"
	case CodeValidationError:
		return "调用参数不正确，正在修正"
	case CodeToolAborted:
		return "操作已取消"
	case CodeRetrievalFailed:
		return "检索暂时不可用，正在尝试其它召回方式"
	default:
		return "该步骤未能完成，正在尝试其它方式"
	}
}

// runToolWithTimeout 超时 + 外部取消。
func runToolWithTimeout(ctx context.Context, tool *AgentToolDefinition, execCtx *ToolExecutionContext, input any, timeoutMs int64) (any, error) {
	if ctx.Err() != nil {
		return nil, ToolAborted(tool.ID)
	}
	runCtx, cancel := context.WithTimeout(ctx, msDuration(timeoutMs))
	defer cancel()
	type result struct {
		out any
		err error
	}
	ch := make(chan result, 1)
	go func() {
		out, err := tool.Execute(execCtx, input)
		ch <- result{out, err}
	}()
	select {
	case r := <-ch:
		return r.out, r.err
	case <-runCtx.Done():
		if ctx.Err() != nil {
			return nil, ToolAborted(tool.ID)
		}
		return nil, ToolTimeoutErr(tool.ID, timeoutMs)
	}
}

var _ = aicore.Chat // 保持对 aicore 包的显式引用
