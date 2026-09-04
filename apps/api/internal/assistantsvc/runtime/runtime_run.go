package runtime

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
)

type synthesizeFinalAnswerInput struct {
	Request         *RunRequest
	State           *AgentStateStore
	Evidence        *EvidenceStore
	Observations    *ObservationStore
	StopReason      AgentStopReason
	Events          *AgentEventEmitter
	Trace           *TraceCollector
	ReplacePrevious bool
}

// synthesizeFinalAnswer 强制收敛：无工具的一次生成，只基于证据作答。
func (r *PetrichorAgentRuntime) synthesizeFinalAnswer(ctx context.Context, input *synthesizeFinalAnswerInput) (string, error) {
	evidenceAll := input.Evidence.All()
	pointers := make([]*AgentEvidence, 0, len(evidenceAll))
	for i := range evidenceAll {
		pointers = append(pointers, &evidenceAll[i])
	}
	finalCtx := BuildFinalAnswerContext(struct {
		State        *AgentState
		Evidence     []*AgentEvidence
		CitationIdx  func(id string) int
		Observations *ObservationStore
		Limitations  []string
	}{
		State:        input.State.Current(),
		Evidence:     pointers,
		CitationIdx:  input.Evidence.CitationIndex,
		Observations: input.Observations,
	})

	stopGuidance := ""
	switch input.StopReason {
	case StopMaxIterations:
		stopGuidance = "\n已达到最大推理轮数，请基于现有信息直接给出结论。"
	case StopMaxToolCalls, StopLoopDetected, StopNoProgress:
		stopGuidance = "\n无法继续获取新信息，请基于现有信息回答并说明局限。"
	case StopCancelled:
		stopGuidance = "\n任务已被取消。"
	}

	instructions := finalCtx + "\n\n## 最终作答要求\n基于以上证据与观察，直接回答用户目标。" +
		BuildAnswerQualityGuidance(input.Request.Goal) + stopGuidance

	controller := NewSegmentController()
	started := false
	segment, err := RunAgentSegment(ctx, &SegmentRequest{
		AgentID:      "petrichor-agent-final",
		Model:        input.Request.Model,
		Instructions: instructions,
		Prompt:       input.Request.Goal,
		Tools:        nil,
		Ctx: &ToolExecutionContext{
			RunID:          input.State.Current().RunID,
			UserID:         input.Request.UserID,
			ConversationID: input.Request.ConversationID,
			State:          input.State.Current(),
		},
		Executor: nil,
		MaxSteps: 1,
		OnTextDelta: func(delta string) {
			if !started {
				started = true
				EmitWikiMentionTargets(input.Events, input.Observations, input.Evidence)
				payload := map[string]any{}
				if input.ReplacePrevious {
					payload["replace"] = true
				}
				input.Events.Emit("final_answer_started", payload)
				input.Trace.MarkFirstToken()
			}
			input.Events.Emit("final_answer_delta", map[string]any{"delta": delta})
		},
	}, controller)
	if err != nil {
		return "", err
	}

	input.State.AddTokenUsage(segment.Usage.Input, segment.Usage.Output)
	input.Trace.AddTokenUsage(segment.Usage.Input, segment.Usage.Output)
	input.Trace.AddLlmLatency(segment.LlmMs)
	return trimSpace(segment.Text), nil
}

// Run 执行一次完整的 Agentic Run。
func (r *PetrichorAgentRuntime) Run(ctx context.Context, request *RunRequest) (*RunResult, error) {
	if request == nil || request.Model == nil {
		return nil, errors.New("缺少 Agent 运行参数或模型")
	}
	runID := trimSpace(request.RunKey)
	if runID == "" {
		runID = NewRunID()
	}
	flags := ReadAgentFeatureFlags()
	startedAt := request.StartedAt
	if startedAt <= 0 {
		startedAt = nowMs()
	}

	events := NewAgentEventEmitter(runID, request.OnEvent)
	trace := NewTraceCollector(runID, request.ConversationID, itoa(int(request.UserID)), request.ModelName, startedAt)
	trace.Event("run_started", map[string]any{"goal": request.Goal})
	events.Emit("agent_started", map[string]any{
		"goal": request.Goal, "model": request.ModelName, "conversationId": request.ConversationID,
	})

	// Router 只作提示，失败不影响主流程
	routingHint := (*RoutingHint)(nil)
	if flags.SoftRouter && request.RoutingHint != nil {
		routingHint = request.RoutingHint
		trace.SetRoutingHint(*routingHint)
	}
	actionableHint := (*RoutingHint)(nil)
	if routingHint.Actionable() {
		actionableHint = routingHint
	}

	complexityDecision := DetectComplexity(ComplexityInput{
		Goal: request.Goal, RoutingHint: actionableHint,
		TurnCount: request.TurnCount, HasFocus: request.Focus != nil,
	})
	complexity := complexityDecision.Complexity
	trace.SetComplexity(complexity, complexityDecision.Reason)
	hintPayload := map[string]any{"complexity": complexity, "reason": complexityDecision.Reason}
	if routingHint != nil {
		hintPayload["routingHint"] = routingHint
	}
	events.Emit("complexity_detected", hintPayload)

	state := NewAgentStateStore(runID, request.ConversationID, itoa(int(request.UserID)), request.Goal, complexity, startedAt)
	observations := NewObservationStore()
	evidenceStore := NewEvidenceStore()
	budget := NewBudgetTracker(ResolveBudget(complexity), startedAt)
	stopConfig := ResolveStopPolicyConfig(complexity)
	loopDetector := NewLoopDetector(stopConfig.MaxNoProgressIterations + 1)
	stopPolicy := NewStopPolicy(stopConfig, budget, loopDetector)
	contextManager := NewContextManager(ResolveContextBudget(request.ContextTokenLimit))

	executor := NewToolExecutor(&ToolExecutorDeps{
		Registry: r.tools, Permissions: r.permissions,
		Observations: observations, Evidence: evidenceStore,
		State: state, Trace: trace, LoopDetector: loopDetector, Events: events,
		ClampTimeout: func(desired int64) int64 { return budget.ClampToolTimeout(desired) },
		OnToolTrace:  request.OnToolTrace,
	})

	skillLoader := NewSkillLoader(r.skills, r.permissions, state, trace, events)

	budgetNotifier := &stepBudgetNotifier{}
	var segmentRestartReason atomicValue
	services := &RuntimeServices{
		Runtime: r, Flags: flags, State: state, SkillLoader: skillLoader, Complexity: complexity,
		Budget: budget, StopPolicy: stopPolicy,
		RequestRestart: func(reason string) { segmentRestartReason.set(reason) },
	}
	if !flags.Delegation {
		services.DelegationDisabled = "委派能力已关闭"
	} else if !AllowsDelegation(complexity) {
		services.DelegationDisabled = "当前任务复杂度不需要委派"
	} else {
		services.DelegateFn = func(inputs []DelegateTaskInput) []DelegationResult {
			return r.delegateMany(
				ctx,
				request,
				inputs,
				state,
				evidenceStore,
				trace,
				events,
				budget,
				stopPolicy,
				0,
			)
		}
	}

	buildCtx := func() *ToolExecutionContext {
		return &ToolExecutionContext{
			RunID: runID, DBRunID: request.DBRunID, ThreadID: request.ThreadID, UserID: request.UserID, ConversationID: request.ConversationID,
			Focus: request.Focus, SystemRole: request.SystemRole,
			DelegationDepth: 0, State: state.Current(), Services: services,
			RecordTokenUsage: func(input, output int64) {
				state.AddTokenUsage(input, output)
				trace.AddTokenUsage(input, output)
			},
		}
	}

	// 预加载：Router hint 只用于预热
	if flags.DynamicSkills && actionableHint != nil && len(actionableHint.Domains) > 0 {
		skillLoader.Preload(MapDomainsToSkills(actionableHint.Domains, r.skills.IDs()))
	}

	// 计划
	if ShouldCreatePlan(complexity) {
		steps := state.SetPlan(DraftPlan(request.Goal))
		trace.Event("plan_created", map[string]any{"steps": steps})
		events.Emit("plan_created", map[string]any{"steps": steps})
	}

	answer := ""
	segments := 0
	var fatalErr *AgentError
	stopReason := AgentStopReason("")
	stopDetail := ""
	if request.InjectionGuard != nil && IsPromptInjectionAttempt(request.Goal) {
		fatalErr = PermissionDenied("检测到试图覆盖系统指令的输入，已阻止工具执行")
		stopReason = StopPermissionDenied
		trace.Event("prompt_injection_blocked", map[string]any{"lastMessageOnly": true})
	}

	for fatalErr == nil && segments < MaxSegments {
		if ctx.Err() != nil {
			stopReason = StopCancelled
			break
		}
		before := stopPolicy.EvaluateBeforeIteration(state.Current())
		if before.Stop {
			stopReason = before.Reason
			stopDetail = before.Detail
			break
		}

		segments++
		state.IncrementIteration()

		segmentRestartReason.reset()
		segmentController := NewSegmentController()
		services.RequestRestart = func(reason string) {
			segmentRestartReason.set(reason)
			segmentController.Request(reason)
		}

		activeTools := r.resolveActiveTools(skillLoader, complexity, request.IsOperator)
		built := contextManager.Build(ContextBuildInput{
			State: state.Current(), Observations: observations, Evidence: evidenceStore,
			SkillInstructions: skillLoader.LoadedInstructions(), SkillCatalog: r.skills.List(),
			Tools: activeTools, RecentMessages: request.Messages,
			ConversationSummary:    request.ConversationSummary,
			ConversationBackground: request.ConversationBackground,
			RoutingHint:            actionableHint,
			RemainingToolCalls:     stopPolicy.RemainingToolCalls(state.Current()),
		})

		trimmedMessages := request.Messages
		if len(request.Messages) > 0 {
			trimmedMessages = contextManager.TrimConversation(request.Messages)
		} else {
			trimmedMessages = nil
		}

		answerStarted := false
		maxSteps := stopPolicy.RemainingToolCalls(state.Current())
		if maxSteps < 1 {
			maxSteps = 1
		}

		segment, segmentErr := RunAgentSegment(ctx, &SegmentRequest{
			AgentID: "petrichor-agent", Model: request.Model,
			Instructions: built.Instructions,
			Messages:     trimmedMessages, Prompt: request.Goal,
			Tools: activeTools, Ctx: buildCtx(), Executor: executor,
			MaxSteps: maxSteps,
			OnTextDelta: func(delta string) {
				if !answerStarted {
					answerStarted = true
					EmitWikiMentionTargets(events, observations, evidenceStore)
					events.Emit("final_answer_started", map[string]any{})
					trace.MarkFirstToken()
				}
				events.Emit("final_answer_delta", map[string]any{"delta": delta})
			},
			OnAnswerReset: func() {
				if !answerStarted {
					return
				}
				answerStarted = false
				events.Emit("final_answer_started", map[string]any{})
			},
			OnToolOutcome: func(outcome *ToolRunOutcome) {
				decision := stopPolicy.EvaluateAfterToolCall(state.Current())
				if decision.Stop {
					stopReason = decision.Reason
					stopDetail = decision.Detail
					segmentController.Request("stop_policy:" + string(decision.Reason))
				}
				budgetNotifier.observe(events, stopPolicy.RemainingToolCalls(state.Current()))
			},
		}, segmentController)
		if segmentErr != nil {
			fatalErr = NormalizeAgentError(segmentErr)
			logRuntimeFailure(request, runID, "agent_segment", segments, fatalErr, segmentErr)
			stopReason = StopFatalError
			trace.Event("error", map[string]any{"code": fatalErr.Code, "message": fatalErr.Message})
			break
		}

		state.AddTokenUsage(segment.Usage.Input, segment.Usage.Output)
		trace.AddTokenUsage(segment.Usage.Input, segment.Usage.Output)
		trace.AddLlmLatency(segment.LlmMs)

		if segment.Aborted {
			stopReason = StopCancelled
			if trimSpace(segment.Text) != "" {
				answer = trimSpace(segment.Text)
			}
			break
		}

		if segment.Stopped == nil {
			answer = trimSpace(segment.Text)
			if answer != "" {
				if stopReason == "" {
					stopReason = StopGoalCompleted
				}
				break
			}
			if stopReason == "" {
				stopReason = StopEnoughEvidence
			}
			break
		}

		if strings.HasPrefix(segment.Stopped.Reason, "stop_policy:") {
			break
		}
		// 因加载技能中止 → 带着新能力继续下一段
		answer = ""

		if reason := segmentRestartReason.get(); reason != "" {
			_ = reason
		}
	}

	if segments >= MaxSegments && answer == "" && stopReason == "" {
		stopReason = StopMaxIterations
		stopDetail = "已达最大推理段数"
	}

	// 已作答但内容明显草率 → 质量门重写
	if answer != "" && evidenceStore.Size() > 0 && (stopReason == StopGoalCompleted || stopReason == StopEnoughEvidence) {
		quality := AssessAnswerQuality(request.Goal, answer, evidenceStore.All())
		trace.Event("answer_quality_checked", map[string]any{
			"adequate": quality.Adequate, "depth": quality.Depth,
			"answerChars": quality.AnswerChars, "contentUnits": quality.ContentUnits,
			"evidenceChars": quality.EvidenceChars, "reasons": quality.Reasons,
		})
		if !quality.Adequate {
			original := answer
			rewritten, synthErr := r.synthesizeFinalAnswer(ctx, &synthesizeFinalAnswerInput{
				Request: request, State: state, Evidence: evidenceStore, Observations: observations,
				StopReason: stopReason, Events: events, Trace: trace, ReplacePrevious: true,
			})
			if synthErr != nil {
				fatalErr = NormalizeAgentError(synthErr)
				logRuntimeFailure(request, runID, "quality_rewrite", segments, fatalErr, synthErr)
				stopReason = StopFatalError
				trace.Event("error", map[string]any{"code": fatalErr.Code, "message": fatalErr.Message})
				answer = original
			} else {
				answer = trimSpace(rewritten)
			}
			if answer == "" {
				answer = original
			}
		}
	}

	// 强制收敛作答
	if answer == "" && fatalErr == nil && stopReason != StopCancelled {
		synthesized, synthErr := r.synthesizeFinalAnswer(ctx, &synthesizeFinalAnswerInput{
			Request: request, State: state, Evidence: evidenceStore, Observations: observations,
			StopReason: stopReason, Events: events, Trace: trace, ReplacePrevious: false,
		})
		if synthErr != nil {
			fatalErr = NormalizeAgentError(synthErr)
			logRuntimeFailure(request, runID, "final_synthesis", segments, fatalErr, synthErr)
			stopReason = StopFatalError
			trace.Event("error", map[string]any{"code": fatalErr.Code, "message": fatalErr.Message})
		} else {
			answer = trimSpace(synthesized)
		}
	}

	if answer != "" {
		answer = DedupeRepeatedAnswer(answer)
		answer = AnnotateNormalQaWikiMentions(answer, CollectWikiMentionTargets(observations, evidenceStore))
	}

	metrics := AgentRunMetrics{
		DurationMs: nowMs() - startedAt, ToolCalls: state.Current().ToolCallCount,
		EvidenceCount: evidenceStore.Size(), SubAgentCount: budget.SubAgentCount(),
		Iterations: state.Current().Iteration,
	}

	if stopReason == StopCancelled {
		state.Finish(StatusCancelled, StopCancelled)
		events.Emit("agent_cancelled", map[string]any{"metrics": metrics})
	} else if fatalErr != nil {
		state.Finish(StatusFailed, stopReason)
		events.Emit("agent_error", map[string]any{"message": "执行过程中出现问题", "errorCode": fatalErr.Code})
	} else if stopReason != "" && stopReason != StopGoalCompleted && stopReason != StopEnoughEvidence {
		state.Finish(StatusStopped, stopReason)
		message := stopDetail
		if message == "" {
			message = "任务已停止"
		}
		events.Emit("agent_stopped", map[string]any{"stopReason": stopReason, "message": message, "metrics": metrics})
	} else {
		finalReason := stopReason
		if finalReason == "" {
			finalReason = StopGoalCompleted
		}
		state.Finish(StatusCompleted, finalReason)
	}

	if stopReason == StopMaxToolCalls {
		budgetNotifier.exhaust(events)
	} else {
		// 预算告警只是运行中的状态；任务以其他原因收尾时立即覆盖为 resolved，
		// 避免已经完成的回答仍提示用户“继续发消息”。
		budgetNotifier.resolve(events, stopPolicy.RemainingToolCalls(state.Current()))
	}
	if answer != "" {
		events.Emit("final_answer_completed", map[string]any{"text": answer})
	}
	completedPayload := map[string]any{"status": state.Current().Status, "metrics": metrics}
	if state.Current().StopReason != "" {
		completedPayload["stopReason"] = state.Current().StopReason
	}
	events.Emit("agent_completed", completedPayload)

	evidenceIDs := make([]string, 0, evidenceStore.Size())
	for _, item := range evidenceStore.All() {
		evidenceIDs = append(evidenceIDs, item.ID)
	}
	trace.RecordEvidenceIDs(evidenceIDs)
	trace.Event("final_answer", map[string]any{"length": len([]rune(answer))})
	trace.Finish(state.Current().StopReason)

	finalState := state.Snapshot()
	finalTrace := trace.Build()

	return &RunResult{
		RunID: runID, Answer: answer, State: finalState, Trace: finalTrace,
		Evaluation: EvaluateRun(finalState, finalTrace, answer),
	}, nil
}

func logRuntimeFailure(request *RunRequest, runID, phase string, segment int, normalized *AgentError, err error) {
	fields := []any{
		"phase", phase,
		"agentRunId", runID,
		"segment", segment,
		"err", err,
	}
	if normalized != nil {
		fields = append(fields, "errorCode", normalized.Code, "retryable", normalized.Retryable)
	}
	if request != nil {
		fields = append(fields,
			"dbRunId", request.DBRunID,
			"threadId", request.ThreadID,
			"userId", request.UserID,
			"model", request.ModelName,
		)
		if request.Model != nil {
			fields = append(fields, "provider", request.Model.Runtime.ProviderKey)
		}
	}
	slog.Error("Agent Runtime 执行失败", fields...)
}

// IsPromptInjectionAttempt 是模型防护前的高精度本地门。
// 教学/分析类提问允许通过；明确要求覆盖系统/开发者指令时阻止任何工具能力。
func IsPromptInjectionAttempt(text string) bool {
	text = trimSpace(text)
	if text == "" || promptInjectionStudyPattern.MatchString(text) {
		return false
	}
	return promptInjectionPattern.MatchString(text)
}

// stepBudgetWarnRemaining 剩余工具调用降到这个数就提前告知用户。
// 取 2 是因为再少就来不及了：一次检索 + 一次深读就是 2 步。
const stepBudgetWarnRemaining = 2

// stepBudgetNotifier 步数预算播报。
//
// 每档只播一次：预算是单调递减的，同一档反复发只会让前端把同一条提示刷屏。
// 只在真的被步数卡住时才发 exhausted——因证据够了而提前收敛不算"用尽"，
// 那种情况告诉用户"步数用尽"是误导。
type stepBudgetNotifier struct {
	warned    bool
	exhausted bool
	resolved  bool
}

func (n *stepBudgetNotifier) observe(events *AgentEventEmitter, remaining int) {
	if n.warned || n.exhausted || n.resolved || remaining > stepBudgetWarnRemaining || remaining <= 0 {
		return
	}
	n.warned = true
	events.Emit("step_budget", map[string]any{
		"status":    "warning",
		"remaining": remaining,
		"label":     "本轮还可调用 " + itoa(remaining) + " 次工具，当前任务仍在继续",
	})
}

func (n *stepBudgetNotifier) resolve(events *AgentEventEmitter, remaining int) {
	if !n.warned || n.exhausted || n.resolved {
		return
	}
	n.resolved = true
	events.Emit("step_budget", map[string]any{
		"status":    "resolved",
		"remaining": remaining,
	})
}

func (n *stepBudgetNotifier) exhaust(events *AgentEventEmitter) {
	if n.exhausted || n.resolved {
		return
	}
	n.exhausted = true
	events.Emit("step_budget", map[string]any{
		"status":    "exhausted",
		"remaining": 0,
		"label":     "本轮工具调用预算已用尽；如答案不完整，可继续发送消息",
	})
}

type atomicValue struct {
	mu sync.RWMutex
	v  string
}

func (a *atomicValue) set(v string) {
	a.mu.Lock()
	a.v = v
	a.mu.Unlock()
}
func (a *atomicValue) get() string {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.v
}
func (a *atomicValue) reset() {
	a.mu.Lock()
	a.v = ""
	a.mu.Unlock()
}
