package runtime

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

const subagentMaxParallel = 3

var subagentReadNamespaces = map[ToolNamespace]bool{
	NamespaceKnowledge: true,
	NamespaceResearch:  true,
	NamespaceGraph:     true,
	NamespaceDocument:  true,
}

type subagentRunResult struct {
	result     DelegationResult
	toolTraces []AgentToolTrace
	usage      AgentTokenUsage
	llmMs      int64
}

// delegateMany 执行隔离且受限的并行子代理。子代理只拿到目标、必要背景、精选证据与
// 授权工具子集；任何失败都结构化返回，不拖垮主 Agent。
func (r *PetrichorAgentRuntime) delegateMany(
	ctx context.Context,
	request *RunRequest,
	inputs []DelegateTaskInput,
	parentState *AgentStateStore,
	parentEvidence *EvidenceStore,
	parentTrace *TraceCollector,
	parentEvents *AgentEventEmitter,
	budget *BudgetTracker,
	stopPolicy *StopPolicy,
	depth int,
) []DelegationResult {
	if len(inputs) == 0 {
		return []DelegationResult{}
	}
	if decision := stopPolicy.EvaluateBeforeDelegation(depth); decision.Stop {
		return rejectedDelegations(inputs, decision.Detail)
	}

	remaining := budget.Budget.MaxSubAgents - budget.SubAgentCount()
	if remaining < 0 {
		remaining = 0
	}
	acceptedCount := len(inputs)
	if acceptedCount > remaining {
		acceptedCount = remaining
	}
	accepted := inputs[:acceptedCount]
	overflow := inputs[acceptedCount:]
	if len(accepted) == 0 {
		return rejectedDelegations(inputs, "已达子代理数量上限")
	}

	parentToolIDs := r.delegatableToolIDs(request.IsOperator)
	contextEvidence := parentEvidence.TopN(6)
	runs := make([]subagentRunResult, len(accepted))
	taskIDs := make([]string, len(accepted))
	for index, input := range accepted {
		taskIDs[index] = NewID("task")
		budget.CountSubAgent()
		parentState.IncrementDelegation()
		parentEvents.Emit("delegation_started", map[string]any{
			"taskId": taskIDs[index], "objective": input.Objective, "depth": depth + 1,
		})
	}

	workerCount := subagentMaxParallel
	if len(accepted) < workerCount {
		workerCount = len(accepted)
	}
	jobs := make(chan int)
	var wg sync.WaitGroup
	for worker := 0; worker < workerCount; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				runs[index] = r.runSubagent(ctx, request, taskIDs[index], accepted[index], parentToolIDs, contextEvidence, depth+1)
			}
		}()
	}
	for index := range accepted {
		jobs <- index
	}
	close(jobs)
	wg.Wait()

	results := make([]DelegationResult, 0, len(inputs))
	for index := range runs {
		run := runs[index]
		for _, toolTrace := range run.toolTraces {
			parentTrace.RecordToolCall(toolTrace)
			if request.OnToolTrace != nil {
				request.OnToolTrace(toolTrace)
			}
		}
		parentState.AddTokenUsage(run.usage.Input, run.usage.Output)
		parentTrace.AddTokenUsage(run.usage.Input, run.usage.Output)
		parentTrace.AddLlmLatency(run.llmMs)

		plainEvidence := make([]AgentEvidence, 0, len(run.result.Evidence))
		for _, evidence := range run.result.Evidence {
			if evidence != nil {
				plainEvidence = append(plainEvidence, *evidence)
			}
		}
		merged := parentEvidence.Merge(plainEvidence)
		stateEvidence := make([]AgentEvidence, 0, len(merged))
		for _, evidence := range merged {
			stateEvidence = append(stateEvidence, *evidence)
		}
		parentState.AddEvidence(stateEvidence)
		run.result.Evidence = merged

		parentTrace.RecordDelegation(AgentDelegationTrace{
			TaskID: run.result.TaskID, Objective: accepted[index].Objective,
			Status: run.result.Status, Depth: depth + 1, DurationMs: run.result.DurationMs,
			EvidenceCount: len(merged), TraceID: run.result.TraceID,
		})
		eventType := "delegation_completed"
		if run.result.Status == "failed" {
			eventType = "delegation_failed"
		}
		parentEvents.Emit(eventType, map[string]any{
			"taskId": run.result.TaskID, "status": run.result.Status,
			"summary": run.result.Summary, "evidenceCount": len(merged),
			"durationMs": run.result.DurationMs,
		})
		results = append(results, run.result)
	}
	results = append(results, rejectedDelegations(overflow, "已达子代理数量上限")...)
	return results
}

func (r *PetrichorAgentRuntime) runSubagent(
	parent context.Context,
	request *RunRequest,
	taskID string,
	input DelegateTaskInput,
	parentToolIDs []string,
	contextEvidence []AgentEvidence,
	depth int,
) subagentRunResult {
	traceID := NewID("trace")
	startedAt := nowMs()
	toolIDs := r.resolveSubagentToolIDs(input, parentToolIDs)
	if len(toolIDs) == 0 {
		return subagentRunResult{result: DelegationResult{
			TaskID: taskID, Status: "failed", TraceID: traceID,
			Summary:  "没有可用于该子任务的只读工具，请由主 Agent 直接处理。",
			Evidence: []*AgentEvidence{}, DurationMs: nowMs() - startedAt, ErrorCode: CodeSubagentFailed,
		}}
	}

	timeoutMs := SubagentDefaultTimeoutMs()
	if remaining := deadlineRemainingMs(parent); remaining > 0 && remaining < timeoutMs {
		timeoutMs = remaining
	}
	ctx, cancel := context.WithTimeout(parent, msDuration(timeoutMs))
	defer cancel()

	state := NewAgentStateStore(NewRunID(), request.ConversationID, itoa(int(request.UserID)), input.Objective, ComplexityMultiStep, startedAt)
	observations := NewObservationStore()
	evidence := NewEvidenceStore()
	loop := NewLoopDetector(4)
	localEvents := NewAgentEventEmitter(state.Current().RunID, nil)
	localTrace := NewTraceCollector(state.Current().RunID, request.ConversationID, itoa(int(request.UserID)), request.ModelName, startedAt)
	toolTraces := []AgentToolTrace{}
	executor := NewToolExecutor(&ToolExecutorDeps{
		Registry: r.tools, Permissions: r.permissions, Observations: observations, Evidence: evidence,
		State: state, Trace: localTrace, LoopDetector: loop, Events: localEvents,
		AllowedToolIDs: toolIDs,
		OnToolTrace:    func(trace AgentToolTrace) { toolTraces = append(toolTraces, trace) },
		ClampTimeout: func(desired int64) int64 {
			if remaining := deadlineRemainingMs(ctx); remaining > 0 && remaining < desired {
				return remaining
			}
			return desired
		},
	})
	tools := make([]*AgentToolDefinition, 0, len(toolIDs))
	for _, id := range toolIDs {
		if definition := r.tools.Get(id); definition != nil {
			tools = append(tools, definition)
		}
	}
	execCtx := &ToolExecutionContext{
		Context: ctx, RunID: state.Current().RunID, DBRunID: request.DBRunID, UserID: request.UserID,
		ConversationID: request.ConversationID, Focus: request.Focus,
		SystemRole: request.SystemRole, DelegationDepth: depth, State: state.Current(),
		RecordTokenUsage: func(input, output int64) {
			state.AddTokenUsage(input, output)
			localTrace.AddTokenUsage(input, output)
		},
	}
	maxSteps := input.MaxToolCalls
	if maxSteps <= 0 || maxSteps > 12 {
		maxSteps = 8
	}
	segment, err := RunAgentSegment(ctx, &SegmentRequest{
		AgentID: "petrichor-subagent", Model: request.Model,
		Instructions: BuildSubagentInstructions(input, tools, contextEvidence), Prompt: input.Objective,
		Tools: tools, Ctx: execCtx, Executor: executor, MaxSteps: maxSteps,
	}, NewSegmentController())
	if err != nil {
		agentErr := NormalizeAgentError(err)
		return subagentRunResult{
			result: DelegationResult{
				TaskID: taskID, Status: "failed", TraceID: traceID,
				Summary:  "子任务失败：" + UserFacingMessage(agentErr),
				Evidence: evidencePointers(evidence.All()), DurationMs: nowMs() - startedAt, ErrorCode: agentErr.Code,
			},
			toolTraces: toolTraces,
		}
	}
	usage := AgentTokenUsage{}
	llmMs := int64(0)
	text := ""
	toolCalls := 0
	if segment != nil {
		usage, llmMs, text, toolCalls = segment.Usage, segment.LlmMs, trimSpace(segment.Text), segment.ToolCallCount
	}
	if ctx.Err() != nil {
		return subagentRunResult{
			result: DelegationResult{
				TaskID: taskID, Status: "failed", TraceID: traceID,
				Summary: "子任务执行超时，主流程将继续。", Evidence: evidencePointers(evidence.All()),
				DurationMs: nowMs() - startedAt, ErrorCode: CodeAgentTimeout,
			},
			toolTraces: toolTraces, usage: usage, llmMs: llmMs,
		}
	}
	collected := evidencePointers(evidence.All())
	if len(collected) == 0 && text != "" {
		confidence := 0.4
		collected = []*AgentEvidence{{
			ID: NewID("ev"), Source: EvidenceSubagent, Title: truncateText(input.Objective, 80),
			Content: text, Confidence: &confidence, Metadata: map[string]any{"taskId": taskID}, CreatedAt: nowMs(),
		}}
	}
	status := "completed"
	if text == "" {
		status = "stopped"
		text = "子任务未产出可用结论"
	}
	return subagentRunResult{
		result: DelegationResult{
			TaskID: taskID, Status: status, Summary: text, Evidence: collected, TraceID: traceID,
			ToolCallCount: toolCalls, DurationMs: nowMs() - startedAt,
		},
		toolTraces: toolTraces, usage: usage, llmMs: llmMs,
	}
}

func (r *PetrichorAgentRuntime) delegatableToolIDs(isOperator bool) []string {
	filter := &ToolFilter{IsOperator: &isOperator}
	out := []string{}
	for _, tool := range r.tools.List(filter) {
		if tool.Namespace == NamespaceAgent || !tool.AllowsSubAgent() {
			continue
		}
		out = append(out, tool.ID)
	}
	return out
}

func (r *PetrichorAgentRuntime) resolveSubagentToolIDs(input DelegateTaskInput, parentToolIDs []string) []string {
	requested := append([]string{}, input.AllowedToolIDs...)
	if len(requested) == 0 && len(input.SkillIDs) > 0 {
		for _, skillID := range input.SkillIDs {
			for _, skill := range r.skills.ResolveWithDependencies(skillID, nil) {
				requested = appendUnique(requested, skill.ToolIDs...)
			}
		}
	}
	if len(requested) == 0 {
		for _, id := range parentToolIDs {
			if tool := r.tools.Get(id); tool != nil && !tool.SideEffect && subagentReadNamespaces[tool.Namespace] {
				requested = append(requested, id)
			}
		}
	}
	intersected := IntersectToolScope(parentToolIDs, requested, r.tools.IDs())
	out := make([]string, 0, len(intersected))
	for _, id := range intersected {
		tool := r.tools.Get(id)
		if tool == nil || tool.Namespace == NamespaceAgent || !tool.AllowsSubAgent() {
			continue
		}
		// 子代理不持有确认票据，任何副作用能力都由主 Agent 负责。
		if tool.SideEffect || tool.RequiresConfirmation {
			continue
		}
		out = append(out, id)
	}
	return out
}

func BuildSubagentInstructions(input DelegateTaskInput, tools []*AgentToolDefinition, evidence []AgentEvidence) string {
	sections := []string{
		"你是 Petrichor 的研究子代理，只负责一个明确子任务，然后把结论交回主 Agent。",
		"", "## 子任务目标", input.Objective,
	}
	if trimSpace(input.Context) != "" {
		sections = append(sections, "", "## 背景", input.Context)
	}
	if len(evidence) > 0 {
		items := make([]string, 0, len(evidence))
		for index, item := range evidence {
			items = append(items, fmt.Sprintf("[%d] %s\n%s", index+1, firstText(item.Title, "未命名"), truncateText(item.Content, 600)))
		}
		sections = append(sections, "", "## 已有相关证据（可直接使用，不必重复检索）", strings.Join(items, "\n\n"))
	}
	catalog := make([]string, 0, len(tools))
	for _, tool := range tools {
		catalog = append(catalog, "- "+tool.ID+"："+tool.Description)
	}
	sections = append(sections,
		"", "## 可用工具", strings.Join(catalog, "\n"),
		"", "## 要求",
		"- 只做这一个子任务，不扩展范围。",
		"- 结论必须基于工具结果，明确来源；检索不到就如实说明。",
		"- 不得声称执行写入、删除或配置变更。",
	)
	if trimSpace(input.ExpectedOutput) != "" {
		sections = append(sections, "- 期望产出："+input.ExpectedOutput)
	} else {
		sections = append(sections, "- 用中文给出简洁、可直接被引用的结论。")
	}
	return strings.Join(sections, "\n")
}

func rejectedDelegations(inputs []DelegateTaskInput, reason string) []DelegationResult {
	if reason == "" {
		reason = "委派不可用"
	}
	out := make([]DelegationResult, 0, len(inputs))
	for _, input := range inputs {
		out = append(out, DelegationResult{
			TaskID: NewID("rejected"), Status: "failed", TraceID: "", Evidence: []*AgentEvidence{},
			Summary: "未执行子任务（" + reason + "）：" + truncateText(input.Objective, 120),
		})
	}
	return out
}

func evidencePointers(items []AgentEvidence) []*AgentEvidence {
	out := make([]*AgentEvidence, 0, len(items))
	for index := range items {
		item := items[index]
		out = append(out, &item)
	}
	return out
}

func deadlineRemainingMs(ctx context.Context) int64 {
	deadline, ok := ctx.Deadline()
	if !ok {
		return 0
	}
	remaining := deadline.UnixMilli() - nowMs()
	if remaining < 1 {
		return 1
	}
	return remaining
}

func appendUnique(base []string, values ...string) []string {
	for _, value := range values {
		if value != "" && !containsString(base, value) {
			base = append(base, value)
		}
	}
	return base
}

func truncateText(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max]) + "…"
}

func firstText(value, fallback string) string {
	if trimSpace(value) != "" {
		return value
	}
	return fallback
}
