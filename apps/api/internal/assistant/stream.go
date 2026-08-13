package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cloudwego/eino/callbacks"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/flow/agent"
	"github.com/cloudwego/eino/flow/agent/react"
	"github.com/cloudwego/eino/schema"
	callbacksTemplate "github.com/cloudwego/eino/utils/callbacks"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantmessage"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/uistream"
)

type chatUIMessage struct {
	Role    string              `json:"role"`
	Content any                 `json:"content"`
	Parts   []chatUIMessagePart `json:"parts"`
	raw     json.RawMessage
}

type chatUIMessagePart struct {
	Type           string         `json:"type"`
	Text           string         `json:"text"`
	ToolName       string         `json:"toolName"`
	ToolCallID     string         `json:"toolCallId"`
	State          string         `json:"state"`
	Result         any            `json:"result"`
	Output         any            `json:"output"`
	Args           any            `json:"args"`
	Input          any            `json:"input"`
	ToolInvocation map[string]any `json:"toolInvocation"`
}

func (message *chatUIMessage) UnmarshalJSON(data []byte) error {
	type alias chatUIMessage
	var decoded alias
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*message = chatUIMessage(decoded)
	message.raw = append(message.raw[:0], data...)
	return nil
}

type pendingConfirmation struct {
	ConfirmationID string
	Confirmed      bool
	AllowForThread bool
}

type streamEmitter struct {
	w             *uistream.Writer
	toolCallCount atomic.Int32
	maxSteps      int
	warned        atomic.Bool
	mu            sync.Mutex
	toolParts     []map[string]any
	toolPartIndex map[string]int
}

func (e *streamEmitter) onToolStart(toolCallID, toolName string, input any) {
	e.w.ToolInputStart(toolCallID, toolName)
	if input != nil {
		raw, _ := json.Marshal(input)
		e.w.ToolInputDelta(toolCallID, string(raw))
		e.w.ToolInputAvailable(toolCallID, toolName, input)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.toolPartIndex == nil {
		e.toolPartIndex = map[string]int{}
	}
	e.toolPartIndex[toolCallID] = len(e.toolParts)
	e.toolParts = append(e.toolParts, map[string]any{
		"type":       "tool-" + toolName,
		"toolCallId": toolCallID,
		"state":      "input-available",
		"input":      input,
	})
}

func (e *streamEmitter) onToolEnd(toolCallID string, output any) {
	e.w.ToolOutputAvailable(toolCallID, output)
	e.updateToolPart(toolCallID, "output-available", output, "")
	e.bumpToolBudget()
}

func (e *streamEmitter) onToolError(toolCallID string, err error) {
	message := "工具执行失败"
	if err != nil && strings.TrimSpace(err.Error()) != "" {
		message = err.Error()
	}
	e.w.ToolOutputError(toolCallID, message)
	e.updateToolPart(toolCallID, "output-error", nil, message)
	e.bumpToolBudget()
}

func (e *streamEmitter) updateToolPart(toolCallID, state string, output any, errorText string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	index, ok := e.toolPartIndex[toolCallID]
	if !ok || index < 0 || index >= len(e.toolParts) {
		return
	}
	part := e.toolParts[index]
	part["state"] = state
	if output != nil {
		part["output"] = output
	}
	if errorText != "" {
		part["errorText"] = errorText
	}
}

func (e *streamEmitter) bumpToolBudget() {
	count := int(e.toolCallCount.Add(1))
	if count >= e.maxSteps-1 && e.warned.CompareAndSwap(false, true) {
		e.w.Data(StepBudgetPartType, StepBudgetPartData{
			Status: "warning",
			Used:   count,
			Limit:  e.maxSteps,
			Label:  fmt.Sprintf("本轮步数将尽（%d/%d），复杂任务可分多轮继续", count, e.maxSteps),
		}, uistream.DataOptions{ID: "step-budget"})
	}
}

func (e *streamEmitter) persistedParts(content string, route IntentRouteResult) []map[string]any {
	e.mu.Lock()
	toolParts := make([]map[string]any, len(e.toolParts))
	for i, part := range e.toolParts {
		toolParts[i] = make(map[string]any, len(part))
		for key, value := range part {
			toolParts[i][key] = value
		}
	}
	e.mu.Unlock()

	parts := make([]map[string]any, 0, len(toolParts)+2)
	parts = append(parts, map[string]any{
		"type": "data-intent-route",
		"id":   "intent-route",
		"data": ToIntentRoutePartData(route, "done"),
	})
	parts = append(parts, toolParts...)
	if content != "" {
		parts = append(parts, map[string]any{"type": "text", "text": content})
	}
	return parts
}

// Chat 输出 UIMessageStream，兼容前端 /api/assistant/chat。
func (r *Runtime) Chat(c *gin.Context) {
	var req struct {
		Messages []chatUIMessage `json:"messages"`
		ThreadID *assistantID    `json:"threadId"`
		ModelID  *assistantID    `json:"modelId"`
		ConfigID *assistantID    `json:"configId"`
		Focus    *AssistantFocus `json:"focus"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || len(req.Messages) == 0 {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	u := auth.MustUser(c)
	ctx := c.Request.Context()
	threadID, err := parseOptionalChatID(req.ThreadID, "threadId")
	if err != nil {
		response.Fail(c, response.BadRequest(err.Error()))
		return
	}
	modelID, err := resolveRequestedChatModelID(req.ModelID, req.ConfigID)
	if err != nil {
		response.Fail(c, response.BadRequest(err.Error()))
		return
	}
	if err := r.assertAssistantFocusOwnership(ctx, u.ID, req.Focus); err != nil {
		response.Fail(c, err)
		return
	}

	userText := extractLatestUserText(req.Messages)
	shouldPersistUser := userText != "" && strings.EqualFold(req.Messages[len(req.Messages)-1].Role, "user")
	pending := findPendingConfirmation(req.Messages)
	isConfirmationResume := pending != nil && !shouldPersistUser
	if userText == "" && !isConfirmationResume {
		response.Fail(c, response.BadRequest("缺少用户消息"))
		return
	}

	thread, err := r.ensureAssistantChatThread(ctx, u.ID, threadID, userText, req.Focus)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if shouldPersistUser {
		if _, err := r.truncateAssistantThreadMessages(ctx, thread.ID, len(req.Messages)-1); err != nil {
			response.Fail(c, err)
			return
		}
		lastMessage := req.Messages[len(req.Messages)-1]
		if err := r.persistAssistantChatMessage(
			ctx,
			u.ID,
			thread.ID,
			"user",
			chatMessagePersistedValue(lastMessage),
			userText,
		); err != nil {
			response.Fail(c, err)
			return
		}
	}

	cfg, err := r.resolveChatModelConfig(ctx, u.ID, modelID)
	if err != nil {
		response.Fail(c, toAssistantChatModelError(err))
		return
	}

	databaseTools, recentDomains, err := r.listRecentAssistantSignals(ctx, thread.ID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	recentTools := mergeRecentToolNames(databaseTools, listRecentToolNamesFromMessages(req.Messages))
	rulesRoute := RouteAssistantIntent(userText, req.Focus, recentTools, recentDomains)
	runRow, err := r.createAssistantRun(ctx, thread.ID, cfg.ID, rulesRoute.Domains)
	if err != nil {
		response.Fail(c, err)
		return
	}

	stepIndex := &atomic.Int32{}
	var confirmationOutcome map[string]any
	if pending != nil {
		confirmCtx := withToolContext(ctx, ToolContext{
			UserID:     u.ID,
			ThreadID:   thread.ID,
			RunID:      runRow.ID,
			Focus:      req.Focus,
			SystemRole: u.SystemRole,
		}, r.client, r.cfg)
		action, outcome, consumeErr := consumeConfirmedAction(confirmCtx, r.client, u.ID, thread.ID, pending.ConfirmationID)
		if consumeErr != nil {
			r.log.Warn("consume confirmation failed", zap.Error(consumeErr))
			confirmationOutcome = map[string]any{"error": consumeErr.Error()}
			_ = r.recordAssistantStep(context.WithoutCancel(ctx), assistantStepRecord{
				RunID: runRow.ID, StepIndex: int(stepIndex.Add(1) - 1),
				ToolName: "request_user_confirmation",
				Input:    map[string]any{"confirmationId": pending.ConfirmationID},
				Output:   confirmationOutcome, Status: "FAILED", ErrorCode: "tool_error",
			})
		} else {
			confirmationOutcome = outcome
			_ = r.recordAssistantStep(context.WithoutCancel(ctx), assistantStepRecord{
				RunID: runRow.ID, StepIndex: int(stepIndex.Add(1) - 1),
				ToolName: action.ToolName, Input: action.Input, Output: outcome, Status: "COMPLETED",
			})
			if pending.AllowForThread {
				if allowErr := addToolToThreadDangerAllowlist(ctx, r.client, thread.ID, u.ID, action.ToolName); allowErr != nil {
					r.log.Warn("update confirmation allowlist failed", zap.Error(allowErr))
				}
			}
		}
	}
	if userText == "" {
		userText = buildConfirmationResumePrompt(confirmationOutcome)
	}

	messageCount, err := r.client.AssistantMessage.Query().Where(assistantmessage.ThreadIDEQ(thread.ID)).Count(ctx)
	if err != nil {
		_ = r.finishAssistantRun(context.WithoutCancel(ctx), runRow.ID, "FAILED", "context_error")
		response.Fail(c, err)
		return
	}

	c.Header("X-Petrichor-Assistant-Thread-Id", fmt.Sprintf("%d", thread.ID))
	c.Header("X-Petrichor-Assistant-Run-Id", fmt.Sprintf("%d", runRow.ID))
	w := uistream.Start(c)
	emitter := &streamEmitter{w: w, maxSteps: AssistantMaxStepsRead}

	if !isConfirmationResume && NeedsIntentLLM(rulesRoute) {
		w.Data(IntentRoutePartType, IntentRoutePartData{Status: "running", Label: "正在识别意图…"}, uistream.DataOptions{ID: "intent-route", Transient: true})
	}

	route := rulesRoute
	var pack contextPack
	var group sync.WaitGroup
	group.Add(2)
	go func() {
		defer group.Done()
		if !isConfirmationResume {
			route = RouteAssistantIntentWithLLM(ctx, r.gen, cfg, userText, req.Focus, recentTools, recentDomains, &rulesRoute)
		}
	}()
	go func() {
		defer group.Done()
		pack = buildContextPack(ctx, r.client, r.recallDeps(), struct {
			UserID            int64
			ThreadID          int64
			Messages          []chatUIMessage
			TokenBudget       int
			PersistedCount    int
			SkipRefresh       bool
			UserText          string
			ExcludeMessageIDs []int64
		}{
			UserID: u.ID, ThreadID: thread.ID, Messages: req.Messages,
			TokenBudget: maxContextTokens, PersistedCount: messageCount,
			SkipRefresh: isConfirmationResume, UserText: userText,
		})
	}()
	group.Wait()

	toolDomains := ResolveToolLoadDomains(route.Domains)
	maxSteps := ResolveAssistantMaxSteps(route.Domains)
	emitter.maxSteps = maxSteps
	if !domainsEqual(route.Domains, rulesRoute.Domains) {
		if err := r.updateAssistantRunIntent(ctx, runRow.ID, route.Domains); err != nil {
			r.log.Warn("update assistant run intent failed", zap.Error(err))
		}
	}
	w.Data(IntentRoutePartType, ToIntentRoutePartData(route, "done"), uistream.DataOptions{ID: "intent-route"})

	if !isConfirmationResume && (pack.Status == "done" || pack.Status == "failed") {
		w.Data(ContextCompressPartType, ContextCompressPartData{Status: "running", Label: "正在整理对话上下文…"}, uistream.DataOptions{ID: "context-compress"})
		label := "上下文已整理"
		if pack.Status == "failed" {
			label = "上下文整理未完成，继续回答"
		}
		w.Data(ContextCompressPartType, ContextCompressPartData{Status: pack.Status, Label: label}, uistream.DataOptions{ID: "context-compress"})
	}

	basePrompt := buildAssistantSystemPrompt(toolDomains, isOperator(u.SystemRole))
	if isOperator(u.SystemRole) {
		if operatorSkillLines, skillErr := r.listOperatorSkillPromptLines(ctx, u.ID, toolDomains); skillErr != nil {
			r.log.Warn("load operator skill catalog failed", zap.Error(skillErr))
		} else if len(operatorSkillLines) > 0 {
			basePrompt += "\n可用操作员 skill（用 load_skill 加载全文）：\n" + strings.Join(operatorSkillLines, "\n")
		}
	}
	if memorySection, memoryErr := r.loadOperatorMemoryPromptSection(ctx, u.ID, thread.ID, isOperator(u.SystemRole)); memoryErr != nil {
		r.log.Warn("load operator memory failed", zap.Error(memoryErr))
	} else if memorySection != "" {
		basePrompt = memorySection + "\n\n" + basePrompt
	}
	systemPrompt := buildInstructionsWithContext(
		basePrompt,
		pack.SummaryMd,
		pack.RecalledSnippets,
	)
	if pending != nil && confirmationOutcome != nil {
		raw, _ := json.Marshal(confirmationOutcome)
		systemPrompt += "\n\n用户已确认操作，执行结果：" + string(raw)
	}

	modelMessages := chatMessagesForModel(pack.RecentMessages)
	if len(modelMessages) == 0 {
		modelMessages = []*schema.Message{schema.UserMessage(userText)}
	}
	content, streamed, runErr := r.runAgentStream(ctx, runConfig{
		user:          u,
		threadID:      thread.ID,
		runID:         runRow.ID,
		cfg:           cfg,
		userText:      userText,
		modelMessages: modelMessages,
		systemPrompt:  systemPrompt,
		toolDomains:   toolDomains,
		focus:         req.Focus,
		emitter:       emitter,
		stepIndex:     stepIndex,
	})

	if !streamed {
		for _, chunk := range chunkTextByRunes(content, 32) {
			w.TextDelta(chunk)
		}
	}
	finalizeCtx, cancelFinalize := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancelFinalize()
	if runErr != nil {
		errorCode := "stream_error"
		if errors.Is(runErr, context.Canceled) || errors.Is(runErr, context.DeadlineExceeded) {
			errorCode = "stream_aborted"
		}
		_ = r.finishAssistantRun(finalizeCtx, runRow.ID, "FAILED", errorCode)
		w.Error("助手响应失败，请稍后重试")
		return
	}

	if int(emitter.toolCallCount.Load()) >= emitter.maxSteps {
		w.Data(StepBudgetPartType, StepBudgetPartData{
			Status: "exhausted",
			Used:   int(emitter.toolCallCount.Load()),
			Limit:  emitter.maxSteps,
			Label:  "本轮步数已用尽，可发送「继续」开始新一轮",
		}, uistream.DataOptions{ID: "step-budget"})
	}

	assistantContent := map[string]any{"parts": emitter.persistedParts(content, route)}
	if err := r.persistAssistantChatMessage(finalizeCtx, u.ID, thread.ID, "assistant", assistantContent, ""); err != nil {
		_ = r.finishAssistantRun(finalizeCtx, runRow.ID, "FAILED", "persist_error")
		w.Error("回复已生成，但保存失败")
		return
	}
	if err := r.finishAssistantRun(finalizeCtx, runRow.ID, "COMPLETED", ""); err != nil {
		r.log.Error("finish assistant run failed", zap.Error(err), zap.Int64("runId", runRow.ID))
	}
	w.Finish()
}

func parseOptionalChatID(raw *assistantID, label string) (*int64, error) {
	if raw == nil {
		return nil, nil
	}
	id, err := parsePositiveID(string(*raw), label)
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func resolveRequestedChatModelID(modelRaw, configRaw *assistantID) (*int64, error) {
	modelID, err := parseOptionalChatID(modelRaw, "modelId")
	if err != nil {
		return nil, err
	}
	configID, err := parseOptionalChatID(configRaw, "configId")
	if err != nil {
		return nil, err
	}
	if modelID != nil && configID != nil && *modelID != *configID {
		return nil, fmt.Errorf("modelId 与 configId 不能指向不同配置")
	}
	if configID != nil {
		return configID, nil
	}
	return modelID, nil
}

func toAssistantChatModelError(err error) error {
	var httpErr *response.HTTPError
	if errors.As(err, &httpErr) && (httpErr.Status == 400 || httpErr.Status == 404) {
		return response.Conflict(httpErr.Message)
	}
	return err
}

func domainsEqual(left, right []AgentDomainId) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func chunkTextByRunes(text string, size int) []string {
	if text == "" || size <= 0 {
		return nil
	}
	runes := []rune(text)
	chunks := make([]string, 0, (len(runes)+size-1)/size)
	for start := 0; start < len(runes); start += size {
		end := start + size
		if end > len(runes) {
			end = len(runes)
		}
		chunks = append(chunks, string(runes[start:end]))
	}
	return chunks
}

type runConfig struct {
	user          *ent.User
	threadID      int64
	runID         int64
	cfg           *ent.AIModelConfig
	userText      string
	modelMessages []*schema.Message
	systemPrompt  string
	toolDomains   []AgentDomainId
	focus         *AssistantFocus
	emitter       *streamEmitter
	stepIndex     *atomic.Int32
}

type toolCallAudit struct {
	ID        string
	Name      string
	Input     any
	StartedAt time.Time
}

func (r *Runtime) runAgentStream(ctx context.Context, rc runConfig) (string, bool, error) {
	chatModel, err := r.buildChatModel(ctx, rc.cfg)
	if err != nil {
		r.log.Debug("build chat model failed", zap.Error(err))
		content, fallbackErr := r.fallbackChat(ctx, rc)
		return content, false, fallbackErr
	}

	tools := buildBusinessTools(rc.toolDomains, isOperator(rc.user.SystemRole))
	toolCtx := withToolContext(ctx, ToolContext{
		UserID:     rc.user.ID,
		ThreadID:   rc.threadID,
		RunID:      rc.runID,
		Focus:      rc.focus,
		SystemRole: rc.user.SystemRole,
	}, r.client, r.cfg)
	toolCtx = context.WithValue(toolCtx, ctxKeyRuntime{}, r)

	cb := react.BuildAgentCallback(&callbacksTemplate.ModelCallbackHandler{}, &callbacksTemplate.ToolCallbackHandler{
		OnStart: func(ctx context.Context, info *callbacks.RunInfo, input *tool.CallbackInput) context.Context {
			if input == nil {
				return ctx
			}
			audit := toolCallAudit{
				ID: "call_" + uuid.NewString(), Name: assistantRunInfoName(info),
				Input: parseToolJSON(input.ArgumentsInJSON), StartedAt: time.Now(),
			}
			if rc.emitter != nil {
				rc.emitter.onToolStart(audit.ID, audit.Name, audit.Input)
			}
			return context.WithValue(ctx, ctxKeyToolCallAudit{}, audit)
		},
		OnEnd: func(ctx context.Context, info *callbacks.RunInfo, output *tool.CallbackOutput) context.Context {
			audit := toolAuditFromContext(ctx, info)
			var parsed any
			if output != nil {
				parsed = parseToolJSON(output.Response)
			}
			if rc.emitter != nil {
				rc.emitter.onToolEnd(audit.ID, parsed)
			}
			duration := int(time.Since(audit.StartedAt).Milliseconds())
			if err := r.recordAssistantStep(context.WithoutCancel(ctx), assistantStepRecord{
				RunID: rc.runID, StepIndex: nextAssistantStepIndex(rc.stepIndex),
				ToolName: audit.Name, Input: audit.Input, Output: parsed,
				Status: "COMPLETED", DurationMs: &duration,
			}); err != nil {
				r.log.Warn("record assistant tool step failed", zap.Error(err), zap.String("tool", audit.Name))
			}
			return ctx
		},
		OnError: func(ctx context.Context, info *callbacks.RunInfo, toolErr error) context.Context {
			audit := toolAuditFromContext(ctx, info)
			if rc.emitter != nil {
				rc.emitter.onToolError(audit.ID, toolErr)
			}
			duration := int(time.Since(audit.StartedAt).Milliseconds())
			output := map[string]any{"error": "工具执行失败", "errorCode": "tool_error"}
			if toolErr != nil {
				output["error"] = toolErr.Error()
			}
			if err := r.recordAssistantStep(context.WithoutCancel(ctx), assistantStepRecord{
				RunID: rc.runID, StepIndex: nextAssistantStepIndex(rc.stepIndex),
				ToolName: audit.Name, Input: audit.Input, Output: output,
				Status: "FAILED", ErrorCode: "tool_error", DurationMs: &duration,
			}); err != nil {
				r.log.Warn("record failed assistant tool step failed", zap.Error(err), zap.String("tool", audit.Name))
			}
			return ctx
		},
	})

	agentInst, err := react.NewAgent(ctx, &react.AgentConfig{
		ToolCallingModel: chatModel,
		ToolsConfig:      compose.ToolsNodeConfig{Tools: tools},
		MaxStep:          rc.emitter.maxSteps,
		MessageModifier:  react.NewPersonaModifier(rc.systemPrompt),
	})
	if err != nil {
		content, fallbackErr := r.fallbackChat(ctx, rc)
		return content, false, fallbackErr
	}

	stream, err := agentInst.Stream(toolCtx, rc.modelMessages, agent.WithComposeOptions(compose.WithCallbacks(cb)))
	if err != nil {
		r.log.Debug("react stream failed", zap.Error(err))
		content, fallbackErr := r.fallbackChat(ctx, rc)
		return content, false, fallbackErr
	}
	defer stream.Close()

	var content strings.Builder
	for {
		msg, receiveErr := stream.Recv()
		if errors.Is(receiveErr, io.EOF) {
			break
		}
		if receiveErr != nil {
			return strings.TrimSpace(content.String()), true, receiveErr
		}
		if msg != nil && msg.Content != "" {
			if rc.emitter != nil {
				rc.emitter.w.TextDelta(msg.Content)
			}
			content.WriteString(msg.Content)
		}
	}
	return strings.TrimSpace(content.String()), true, nil
}

func (r *Runtime) fallbackChat(ctx context.Context, rc runConfig) (string, error) {
	messages := make([]ai.ChatMessage, 0, len(rc.modelMessages)+1)
	messages = append(messages, ai.ChatMessage{Role: "system", Content: rc.systemPrompt})
	for _, message := range rc.modelMessages {
		if message == nil || strings.TrimSpace(message.Content) == "" {
			continue
		}
		if message.Role != schema.User && message.Role != schema.Assistant {
			continue
		}
		messages = append(messages, ai.ChatMessage{Role: string(message.Role), Content: message.Content})
	}
	if len(messages) == 1 {
		messages = append(messages, ai.ChatMessage{Role: "user", Content: rc.userText})
	}
	result, err := r.gen.Chat(ctx, rc.cfg, messages)
	if err != nil {
		return "", err
	}
	return result.Content, nil
}

func assistantRunInfoName(info *callbacks.RunInfo) string {
	if info == nil || strings.TrimSpace(info.Name) == "" {
		return "unknown_tool"
	}
	return info.Name
}

func parseToolJSON(raw string) any {
	if strings.TrimSpace(raw) == "" {
		return map[string]any{}
	}
	var parsed any
	if json.Unmarshal([]byte(raw), &parsed) == nil {
		return parsed
	}
	return raw
}

func toolAuditFromContext(ctx context.Context, info *callbacks.RunInfo) toolCallAudit {
	if audit, ok := ctx.Value(ctxKeyToolCallAudit{}).(toolCallAudit); ok {
		return audit
	}
	return toolCallAudit{
		ID: "call_" + uuid.NewString(), Name: assistantRunInfoName(info),
		Input: map[string]any{}, StartedAt: time.Now(),
	}
}

func nextAssistantStepIndex(index *atomic.Int32) int {
	if index == nil {
		return 0
	}
	return int(index.Add(1) - 1)
}

type ctxKeyToolCallAudit struct{}
type ctxKeyRuntime struct{}

func buildAssistantSystemPrompt(domains []AgentDomainId, isOp bool) string {
	active := make(map[AgentDomainId]struct{}, len(domains))
	for _, domain := range domains {
		active[domain] = struct{}{}
	}
	names := listToolNamesForDomains(domains, isOp)
	guidance := make([]string, 0, 12)
	if _, ok := active[DomainSystem]; ok {
		guidance = append(guidance,
			"系统元信息用 list_system_overview。多步任务用 show_progress / upsert_plan（侧栏展示，正文不重复罗列）。可复用结果才用 save_answer_artifact。",
			"跨库或多步核验可用 spawn_research_subagent；多路子问题用 spawn_research_fanout（tasks≤3）。根据 summary/citations/results 作答，不编造来源。",
		)
		if isOp {
			guidance = append(guidance, "可用 memory_manage / search_operator_history：记忆写入只影响新线程；历史回忆请用 search_operator_history。")
		}
	}
	if skillText := assistantSkillCatalogText(domains); skillText != "" {
		guidance = append(guidance, "可用 skill 目录（复杂业务先 load_skill 加载全文，再按 playbook 调工具）：\n"+skillText)
	}
	if _, ok := active[DomainKnowledge]; ok {
		guidance = append(guidance,
			"图片/图表：答案中直接输出 Markdown 图片，src 使用 media.src 原值，禁止声称无法展示。",
			"计数与清单优先 list_system_overview / list_knowledge_bases；跨库内容检索优先一次 search_knowledge，不要逐库重复同类 query。",
			"跨库检索后读取全文时，把命中项的 knowledgeBaseId 一并传给 read_knowledge_node；读取报错时按提示补参重试。",
			"文件问题优先使用 search_knowledge 命中的 documentId/chunkIndex，再用 read_knowledge_node 展开相邻分片。",
		)
	}
	_, hasKnowledge := active[DomainKnowledge]
	if _, hasSystem := active[DomainSystem]; hasSystem && hasKnowledge {
		guidance = append(guidance, "最终答案基于工具结果，并调用 show_citations；引用字段不得改写或编造。")
	}
	if _, ok := active[DomainContentWrite]; ok {
		guidance = append(guidance,
			"内容写入工具仅在用户明确要求写改、移动或分享时使用，纯问答不要主动改数据。",
			"跨知识库或同库移动文章用 move_article（必填 targetKnowledgeBaseId）。两步及以上写改必须 upsert_plan 并逐步更新。",
			"大段改写正文先 preview_article_update，再 update_article 落库。",
		)
	}
	if _, hasWrite := active[DomainContentWrite]; hasWrite {
		guidance = append(guidance, "危险操作必须 request_user_confirmation，禁止假装已执行。")
	} else if _, hasAdmin := active[DomainAdmin]; hasAdmin {
		guidance = append(guidance, "危险操作必须 request_user_confirmation，禁止假装已执行。")
	}
	return strings.Join(append([]string{
		"你是 Petrichor 的站内助手，以对话方式帮助已登录用户查看和操作系统。",
		"本轮装载域：" + strings.Join(agentDomainStrings(domains), ", ") + "。只调用本轮实际提供的工具；没有对应工具时，不要假装已经执行。",
	}, append(guidance,
		"站内事实必须以工具结果为准；检索不到就如实说明，不要编造数据、来源、链接或原文片段。",
		"若工具返回 ok:false 且带 errorCode 与 message，按 action 换招或降级说明；不要反复调用同一已失败工具。",
		"只使用中文回答，直接、结构清晰。",
		"可用工具："+strings.Join(names, ", "),
	)...), "\n")
}

func assistantSkillCatalogText(domains []AgentDomainId) string {
	active := make(map[AgentDomainId]struct{}, len(domains))
	for _, domain := range domains {
		active[domain] = struct{}{}
	}
	lines := make([]string, 0, len(builtinSkills))
	if _, ok := active[DomainKnowledge]; ok {
		if skill, exists := builtinSkills["knowledge-qa"]; exists {
			lines = append(lines, "- "+skill.Name+"："+skill.Description)
		}
	}
	if _, ok := active[DomainContentWrite]; ok {
		if skill, exists := builtinSkills["article-write"]; exists {
			lines = append(lines, "- "+skill.Name+"："+skill.Description)
		}
	}
	if _, ok := active[DomainAdmin]; ok {
		if skill, exists := builtinSkills["admin-ops"]; exists {
			lines = append(lines, "- "+skill.Name+"："+skill.Description)
		}
	}
	return strings.Join(lines, "\n")
}

func agentDomainStrings(domains []AgentDomainId) []string {
	out := make([]string, len(domains))
	for i, domain := range domains {
		out[i] = string(domain)
	}
	return out
}

func listToolNamesForDomains(domains []AgentDomainId, isOperator bool) []string {
	wanted := map[AgentDomainId]struct{}{}
	for _, d := range domains {
		wanted[d] = struct{}{}
	}
	names := make([]string, 0, 32)
	for name, reg := range toolRegistry {
		if _, ok := wanted[reg.Domain]; !ok {
			continue
		}
		if reg.Risk == RiskDangerous {
			continue
		}
		if reg.RequiresOperator && !isOperator {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func mustJSON(v any) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}

func summarizeThreadTitle(text string) string {
	t := strings.Join(strings.Fields(text), " ")
	if t == "" {
		return "新对话"
	}
	runes := []rune(t)
	if len(runes) > 40 {
		return string(runes[:40]) + "…"
	}
	return t
}

func buildConfirmationResumePrompt(outcome map[string]any) string {
	if outcome == nil {
		return "请根据刚才的确认执行结果继续。"
	}
	raw, _ := json.Marshal(outcome)
	return "用户已确认操作。执行结果：" + string(raw) + "。请据此继续回答。"
}

func extractConfirmedToolName(messages []chatUIMessage, confirmationID string) string {
	for i := len(messages) - 1; i >= 0; i-- {
		for _, p := range messages[i].Parts {
			if chatPartToolName(p) != "request_user_confirmation" {
				continue
			}
			args := chatPartInput(p)
			if m, ok := args.(map[string]any); ok {
				if id, _ := m["id"].(string); id == confirmationID {
					if action, ok := m["action"].(map[string]any); ok {
						if name, _ := action["toolName"].(string); name != "" {
							return name
						}
					}
				}
			}
		}
	}
	return ""
}

func listRecentToolNamesFromMessages(messages []chatUIMessage) []string {
	names := []string{}
	for i := len(messages) - 1; i >= 0 && len(names) < 8; i-- {
		for _, p := range messages[i].Parts {
			name := chatPartToolName(p)
			if name != "" {
				names = append(names, name)
			}
		}
	}
	return names
}

func extractLatestUserText(messages []chatUIMessage) string {
	for i := len(messages) - 1; i >= 0; i-- {
		m := messages[i]
		if !strings.EqualFold(m.Role, "user") {
			continue
		}
		for _, p := range m.Parts {
			if p.Type == "text" && strings.TrimSpace(p.Text) != "" {
				return strings.TrimSpace(p.Text)
			}
		}
		if s, ok := m.Content.(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

func findPendingConfirmation(messages []chatUIMessage) *pendingConfirmation {
	for i := len(messages) - 1; i >= 0; i-- {
		m := messages[i]
		if !strings.EqualFold(m.Role, "assistant") {
			continue
		}
		for _, p := range m.Parts {
			if chatPartToolName(p) != "request_user_confirmation" {
				continue
			}
			result := chatPartOutput(p)
			parsed := parseConfirmationResult(result)
			if parsed != nil && parsed.Confirmed && parsed.ConfirmationID != "" {
				if hasExecutionOutcome(result) {
					return nil
				}
				input, ok := chatPartInput(p).(map[string]any)
				if !ok {
					continue
				}
				inputID, _ := input["id"].(string)
				action, _ := input["action"].(map[string]any)
				toolName, _ := action["toolName"].(string)
				if strings.TrimSpace(inputID) != parsed.ConfirmationID || strings.TrimSpace(toolName) == "" {
					continue
				}
				return parsed
			}
		}
	}
	return nil
}

func chatPartToolName(part chatUIMessagePart) string {
	if strings.TrimSpace(part.ToolName) != "" {
		return strings.TrimSpace(part.ToolName)
	}
	if strings.HasPrefix(part.Type, "tool-") && part.Type != "tool-call" && part.Type != "tool-invocation" {
		return strings.TrimSpace(strings.TrimPrefix(part.Type, "tool-"))
	}
	if part.ToolInvocation != nil {
		if name, _ := part.ToolInvocation["toolName"].(string); strings.TrimSpace(name) != "" {
			return strings.TrimSpace(name)
		}
	}
	return ""
}

func chatPartInput(part chatUIMessagePart) any {
	if part.Args != nil {
		return part.Args
	}
	if part.Input != nil {
		return part.Input
	}
	if part.ToolInvocation != nil {
		if value := part.ToolInvocation["args"]; value != nil {
			return value
		}
		return part.ToolInvocation["input"]
	}
	return nil
}

func chatPartOutput(part chatUIMessagePart) any {
	if part.Result != nil {
		return part.Result
	}
	if part.Output != nil {
		return part.Output
	}
	if part.ToolInvocation != nil {
		if value := part.ToolInvocation["result"]; value != nil {
			return value
		}
		return part.ToolInvocation["output"]
	}
	return nil
}

func hasExecutionOutcome(raw any) bool {
	switch v := raw.(type) {
	case map[string]any:
		return v["executionOutcome"] != nil
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return false
		}
		var obj map[string]any
		if json.Unmarshal(b, &obj) != nil {
			return false
		}
		return obj["executionOutcome"] != nil
	}
}

func parseConfirmationResult(raw any) *pendingConfirmation {
	switch v := raw.(type) {
	case map[string]any:
		confirmed, _ := v["confirmed"].(bool)
		id, _ := v["confirmationId"].(string)
		if id == "" {
			id, _ = v["id"].(string)
		}
		allow, _ := v["allowForThread"].(bool)
		if confirmed && strings.TrimSpace(id) != "" {
			return &pendingConfirmation{ConfirmationID: strings.TrimSpace(id), Confirmed: true, AllowForThread: allow}
		}
	case string:
		var obj map[string]any
		if json.Unmarshal([]byte(v), &obj) == nil {
			return parseConfirmationResult(obj)
		}
	default:
		b, err := json.Marshal(v)
		if err == nil {
			var obj map[string]any
			if json.Unmarshal(b, &obj) == nil {
				return parseConfirmationResult(obj)
			}
		}
	}
	return nil
}

// ChatJSON 保留 JSON 调试入口。
func (r *Runtime) ChatJSON(c *gin.Context) {
	var req chatRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	u := auth.MustUser(c)
	cfg, err := r.resolveChatModelConfig(c.Request.Context(), u.ID, req.ModelID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	out, err := r.gen.Chat(c.Request.Context(), cfg, []ai.ChatMessage{
		{Role: "system", Content: "你是 Petrichor 站内助手。"},
		{Role: "user", Content: strings.TrimSpace(req.Message)},
	})
	if err != nil {
		response.Fail(c, response.BadRequest("模型调用失败"))
		return
	}
	response.OK(c, chatResponse{Reply: out.Content, Runtime: "go-ui-stream", Tools: listRegisteredToolNames()})
}
