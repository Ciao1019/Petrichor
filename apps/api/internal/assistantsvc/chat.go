// chat.go 对照 chat-handler.ts（V2 对外契约）：
// 接收消息 → 持久化 thread/message/run → PetrichorAgentRuntime 完整编排 →
// 以 assistant-ui UIMessage 流协议（SSE）把事件推给前端 → 结束落最终消息与 run 状态。
//
// Runtime 移植：意图路由提示、复杂度判定、计划、上下文组装、工具循环
// （knowledge/wiki 检索）、证据收集、质量门与强制收敛均对齐 TS V2 行为；
// 协议、落库结构与「未配置对话模型 → 409」语义保持一致。
package assistantsvc

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	aicore "petrichor/api/internal/aicore"
	rt "petrichor/api/internal/assistantsvc/runtime"
	"petrichor/api/internal/auth"
	httpx "petrichor/api/internal/httpx"
)

var toolsOnce sync.Once

func ensureToolsRegistered() {
	toolsOnce.Do(func() {
		RegisterAssistantTools(rt.DefaultToolRegistry(), rt.DefaultSkills())
	})
}

// uiMessageStreamHeaders 复刻 ai 包 UI_MESSAGE_STREAM_HEADERS 与业务响应头。
const headerThreadID = "X-Petrichor-Assistant-Thread-Id"

const headerRunID = "X-Petrichor-Assistant-Run-Id"

const streamAbortedCode = "stream_aborted"

const streamErrorCode = "stream_error"

// genericStreamErrorText 与 AI SDK 默认 onError 一致：不向客户端泄露服务端错误细节。
const genericStreamErrorText = "An error occurred."

type chatRequest struct {
	ThreadID     optFlexID       `json:"threadId"`
	Messages     json.RawMessage `json:"messages"`
	ConfigID     optFlexID       `json:"configId"`
	Focus        json.RawMessage `json:"focus"`
	QaMode       *string         `json:"qaMode"`
	RetryOfRunID *string         `json:"retryOfRunId"`
}

// AssistantChatHandler POST /api/assistant/chat。
func AssistantChatHandler(c *gin.Context) {
	requestStartedAt := time.Now()
	var req chatRequest
	if err := readBodyStrict(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	if !isJSONArray(req.Messages) || jsonArrayLen(req.Messages) < 1 {
		httpx.ErrorJSON(c, 400, "请求参数错误")
		return
	}
	qaMode := ""
	if req.QaMode != nil {
		if *req.QaMode != "normal" && *req.QaMode != "wiki" {
			httpx.ErrorJSON(c, 400, "请求参数错误")
			return
		}
		qaMode = *req.QaMode
	}
	if req.RetryOfRunID != nil {
		t := strings.TrimSpace(*req.RetryOfRunID)
		if t == "" || runeLen(t) > 64 {
			httpx.ErrorJSON(c, 400, "请求参数错误")
			return
		}
	}
	messages := jsonArrayItems(req.Messages)

	focus, err := parseFocusInput(req.Focus)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	user := currentUserOf(c)
	ctx := c.Request.Context()
	if err := assertFocusOwnership(ctx, user.ID, focus); err != nil {
		httpx.HandleError(c, err)
		return
	}

	lastMessage := messages[len(messages)-1]
	goal := extractLastUserText(messages)
	shouldPersistUser := goal != "" && messageRoleIs(lastMessage, "user")

	thread, err := ensureAssistantThread(ctx, user.ID, req.ThreadID.Int64(), req.ThreadID.Present, goal, focus)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	if shouldPersistUser {
		// 编辑重提时客户端会截断后续消息：先对齐库中历史，再写入本轮 user
		if _, err := truncateAssistantThreadMessages(ctx, thread.ID, len(messages)-1); err != nil {
			httpx.HandleError(c, err)
			return
		}
		if err := persistAssistantMessage(ctx, user.ID, thread.ID, "user", json.RawMessage(lastMessage), goal); err != nil {
			httpx.HandleError(c, err)
			return
		}
	}

	// 模型解析失败在流开始前返回；未配置对话模型类 BadRequest/NotFound 转 409 Conflict
	var configRef *int64
	if req.ConfigID.Present {
		configRef = new(int64)
		*configRef = req.ConfigID.Int64()
	}
	resolved, err := aicore.ResolveModelForPurpose(ctx, user.ID, aicore.PurposeChat, configRef)
	if err != nil {
		if he, ok := err.(*httpx.HttpError); ok && (he.Status == http.StatusBadRequest || he.Status == http.StatusNotFound) {
			err = httpx.Conflict(he.Message)
		}
		httpx.HandleError(c, err)
		return
	}

	routingHint := resolveAssistantRoutingHint(ctx, thread.ID, goal, focus)
	complexity := rt.DetectComplexity(rt.ComplexityInput{
		Goal: goal, RoutingHint: routingHint, TurnCount: len(messages), HasFocus: focus != nil,
	}).Complexity
	runID, err := createAssistantRun(ctx, thread.ID, resolved.ModelID, routingDomains(routingHint))
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	// 危险操作确认回传：客户端只提供 confirmationId；真正的 tool/input 从服务端
	// 原子票据读取并消费，防止伪造、篡改和重放。执行结果回填给模型及持久化消息。
	if decisionResult := findPendingConfirmationDecision(messages); decisionResult != nil {
		ensureToolsRegistered()
		execCtx := &rt.ToolExecutionContext{
			Context: ctx, DBRunID: runID, ThreadID: thread.ID, UserID: user.ID,
			ConversationID: idStr(thread.ID), Focus: assistantFocusMap(focus), QaMode: qaMode,
			SystemRole: user.SystemRole,
		}
		decision := map[string]any{
			"confirmed": decisionResult.Confirmed, "confirmationId": decisionResult.ConfirmationID,
			"allowForThread": decisionResult.AllowForThread,
		}
		var outcome any
		var confirmErr error
		if !decisionResult.Confirmed {
			confirmErr = cancelAssistantConfirmation(execCtx, thread.ID, decisionResult.ConfirmationID)
			outcome = map[string]any{"cancelled": true}
		} else {
			var serverAction *storedConfirmationAction
			serverAction, confirmErr = consumeAssistantConfirmation(execCtx, thread.ID, decisionResult.ConfirmationID)
			if confirmErr == nil && decisionResult.AllowForThread {
				confirmErr = addToolToThreadDangerAllowlist(execCtx, thread.ID, serverAction.ToolName)
			}
			if confirmErr == nil {
				outcome, confirmErr = executeConfirmedDangerousAction(execCtx, serverAction.ToolName, serverAction.Input)
			}
		}
		if confirmErr != nil {
			normalized := rt.NormalizeAgentError(confirmErr)
			message := "危险操作执行失败"
			if normalized.Code == rt.CodeValidationError || normalized.Code == rt.CodePermissionDenied {
				message = normalized.Message
			}
			outcome = map[string]any{"error": message, "errorCode": normalized.Code}
		}
		messages = patchConfirmationExecutionOutcome(messages, decisionResult.ConfirmationID, outcome)
		persistConfirmationExecutionOutcome(execCtx, thread.ID, decisionResult.ConfirmationID, decision, outcome)
	}

	streamChatCompletion(c, streamContext{
		user:         user,
		thread:       thread,
		runID:        runID,
		resolved:     resolved,
		messages:     messages,
		goal:         goal,
		qaMode:       qaMode,
		focus:        focus,
		startedAt:    requestStartedAt,
		retryOfRunID: strings.TrimSpace(derefOrEmpty(req.RetryOfRunID)),
		routingHint:  routingHint,
		complexity:   complexity,
	})
}

type streamContext struct {
	user         *auth.User
	thread       *assistantThreadRow
	runID        int64
	resolved     *aicore.ResolvedModel
	messages     []json.RawMessage
	goal         string
	qaMode       string
	focus        *assistantFocus
	startedAt    time.Time
	retryOfRunID string
	routingHint  *rt.RoutingHint
	complexity   rt.TaskComplexity
}

// createAssistantRun 对应 createAssistantRun：status RUNNING、意图域先置空数组。
func createAssistantRun(ctx context.Context, threadID, modelConfigID int64, intentDomains []string) (int64, error) {
	var runID int64
	domainsJSON, _ := json.Marshal(intentDomains)
	err := dbPool().QueryRow(ctx,
		`INSERT INTO petrichor_assistant_run (thread_id, status, model_config_id, intent_domains_json)
		 VALUES ($1, 'RUNNING', $2, $3) RETURNING id`,
		threadID, modelConfigID, string(domainsJSON)).Scan(&runID)
	return runID, err
}

// finishAssistantRun 对应 finishAssistantRun：只收敛一次由调用方保证。
func finishAssistantRun(ctx context.Context, runID int64, status, errorCode string) error {
	if errorCode != "" {
		_, err := dbPool().Exec(ctx,
			`UPDATE petrichor_assistant_run SET status = $1, error_code = $2, finished_at = $3
			 WHERE id = $4`, status, errorCode, time.Now(), runID)
		return err
	}
	_, err := dbPool().Exec(ctx,
		`UPDATE petrichor_assistant_run SET status = $1, error_code = NULL, finished_at = $2
		 WHERE id = $3`, status, time.Now(), runID)
	return err
}

// ===== 流式输出 =====

// sseEmitter 按 UIMessage 流协议写帧：data: <json>\n\n … data: [DONE]\n\n。
type sseEmitter struct {
	c       *gin.Context
	writeFn func([]byte) (int, error)
	flushFn func()
	mu      sync.Mutex
}

func (s *sseEmitter) chunk(v any) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := json.Marshal(v)
	if err != nil {
		return false
	}
	frame := append([]byte("data: "), append(raw, '\n', '\n')...)
	if _, werr := s.write(frame); werr != nil {
		return false
	}
	s.flush()
	return true
}

func (s *sseEmitter) done() {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.write([]byte("data: [DONE]\n\n"))
	s.flush()
}

func (s *sseEmitter) write(payload []byte) (int, error) {
	if s.writeFn != nil {
		return s.writeFn(payload)
	}
	return s.c.Writer.Write(payload)
}

func (s *sseEmitter) flush() {
	if s.flushFn != nil {
		s.flushFn()
		return
	}
	if s.c != nil {
		s.c.Writer.Flush()
	}
}

func (s *sseEmitter) errorFrame() {
	s.chunk(map[string]any{"type": "error", "errorText": genericStreamErrorText})
}

// streamChatCompletion 执行 Runtime 编排并把事件按协议推给前端。
func streamChatCompletion(c *gin.Context, sc streamContext) {
	ensureToolsRegistered()

	w := c.Writer
	header := w.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-cache")
	header.Set("Connection", "keep-alive")
	header.Set("X-Accel-Buffering", "no")
	// 关键：显式声明 identity，Next.js 反代层的压缩中间件看到已有
	// Content-Encoding 会跳过 gzip——否则 SSE 帧被缓冲到响应结束一次性下发，
	// 浏览器端表现为"没有流式效果"。
	header.Set("Content-Encoding", "identity")
	header.Set("X-Vercel-Ai-Ui-Message-Stream", "v1")
	header.Set(headerThreadID, idStr(sc.thread.ID))
	header.Set(headerRunID, idStr(sc.runID))
	w.WriteHeader(http.StatusOK)

	emitter := &sseEmitter{c: c}
	ctx, cancel := context.WithCancel(c.Request.Context())
	defer cancel()
	startedAt := sc.startedAt
	if startedAt.IsZero() {
		startedAt = time.Now()
	}

	messageID := newStreamMessageID()
	persistedParts := newAssistantStreamParts()
	bridge := newAssistantEventBridge(emitter.chunk, persistedParts)

	// createUIMessageStream 会在流首尾自动补 start/finish 帧，这里显式对齐
	emitter.chunk(map[string]any{"type": "start", "messageId": messageID})

	runtime := rt.NewRuntime()
	resolved := sc.resolved
	modelHandle := &rt.ResolvedModelHandle{
		Runtime: resolved.Runtime,
		ModelID: resolved.ModelRef,
		Options: resolved.Options,
	}
	contextLimit := assistantContextTokenLimit(resolved.ContextWindow)
	contextPack := buildAssistantContextPack(
		ctx, sc.user.ID, sc.thread.ID, sc.user.SystemRole,
		uiMessagesToRuntime(sc.messages), contextLimit, resolved,
	)

	runKey := rt.NewRunID()
	createAgentRunRecordBestEffort(context.Background(), agentRunCreateInput{
		RunKey: runKey, ConversationID: idStr(sc.thread.ID), ThreadID: sc.thread.ID,
		UserID: sc.user.ID, RetryOfRunKey: sc.retryOfRunID, Model: resolved.ModelRef,
		Goal: sc.goal, Complexity: sc.complexity,
	})

	stepIndex := 0
	runRequest := &rt.RunRequest{
		RunKey:                 runKey,
		ConversationID:         idStr(sc.thread.ID),
		UserID:                 sc.user.ID,
		DBRunID:                sc.runID,
		ThreadID:               sc.thread.ID,
		SystemRole:             sc.user.SystemRole,
		Goal:                   sc.goal,
		Focus:                  assistantFocusMap(sc.focus),
		Messages:               contextPack.Messages,
		ConversationBackground: contextPack.Background,
		Model:                  modelHandle,
		ModelName:              resolved.ModelRef,
		StartedAt:              startedAt.UnixMilli(),
		TurnCount:              len(sc.messages),
		QaMode:                 sc.qaMode,
		RoutingHint:            sc.routingHint,
		InjectionGuard:         &struct{ ProviderKey, ModelID string }{ProviderKey: resolved.ProviderKey, ModelID: resolved.ModelRef},
		IsOperator:             rt.IsAssistantOperator(sc.user.SystemRole),
		ContextTokenLimit:      contextLimit,
		OnEvent: func(event *rt.AgentStreamEvent) {
			if !bridge.onEvent(event) {
				cancel()
			}
		},
		OnToolTrace: func(trace rt.AgentToolTrace) {
			// 标准 AI SDK tool chunks 与结构化 agent events 并行输出：前者驱动
			// 既有 Tool UI/确认卡，后者驱动 Agent Run 时间线。落库保留终态 tool part。
			publicToolInput, toolOutput, emitted := emitAssistantToolTraceChunks(emitter, persistedParts, trace)
			if !emitted {
				cancel()
			}

			// 对齐 TS onToolTrace → assistant_step 表
			inputJSON, _ := json.Marshal(publicToolInput)
			var outputPayload any = map[string]any{"summary": trace.Summary}
			if trace.OK && toolOutput != nil {
				outputPayload = toolOutput
			} else if !trace.OK {
				outputPayload = map[string]any{"error": trace.Summary, "errorCode": trace.ErrorCode}
			}
			outputJSON, _ := json.Marshal(outputPayload)
			_, _ = dbPool().Exec(context.Background(),
				`INSERT INTO petrichor_assistant_step
				 (run_id, step_index, tool_name, input_json, output_json, status, error_code, duration_ms)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
				sc.runID, stepIndex, trace.ToolName,
				string(inputJSON), string(outputJSON),
				stepStatus(trace.OK), nullableErrCode(trace.ErrorCode), trace.DurationMs)
			stepIndex++
		},
	}

	result, runErr := runtime.Run(ctx, runRequest)

	status := "COMPLETED"
	errorCode := ""
	switch {
	case runErr != nil:
		if errors.Is(runErr, context.Canceled) {
			status, errorCode = "FAILED", streamAbortedCode
		} else {
			status, errorCode = "FAILED", streamErrorCode
		}
	case result != nil && result.State != nil && result.State.Status == rt.StatusCancelled:
		status, errorCode = "FAILED", streamAbortedCode
	case result != nil && result.State != nil && result.State.Status == rt.StatusFailed:
		// Runtime 已把异常收敛为 agent_error 事件；数据库 Run 仍必须标记失败，
		// 但不额外写标准 UI error 帧，避免前端同时显示两份错误。
		status, errorCode = "FAILED", "agent_runtime_error"
	}
	// UIMessage 流的终止帧在成功、取消和异常路径上都必须完整。Runtime 抛错时
	// 先发通用 error（不泄露内部信息），再统一发 finish；[DONE] 始终最后发送。
	if runErr != nil {
		emitter.errorFrame()
	}
	emitter.chunk(map[string]any{"type": "finish"})

	_ = finishAssistantRun(context.Background(), sc.runID, status, errorCode)
	if result != nil {
		persistAgentRunBestEffort(context.Background(), result)
	}

	// 落库不阻塞流关闭；失败只记录日志（fail-open）
	if result != nil || persistedParts.len() > 0 {
		content := buildAssistantPersistContent(result, runKey, persistedParts.all(), startedAt)
		if perr := persistAssistantMessage(context.Background(), sc.user.ID, sc.thread.ID, "assistant", content, ""); perr != nil {
			gin.DefaultErrorWriter.Write([]byte("[assistantsvc.chat] persist assistant message: " + perr.Error() + "\n"))
		}
	}

	emitter.done()
}

// emitAssistantToolTraceChunks 同时维护 AI SDK tool chunks 与落库终态 part。
// 输入输出在离开进程前统一脱敏；确认票据中的原始 action 只保存在加密票据里。
func emitAssistantToolTraceChunks(emitter *sseEmitter, parts *assistantStreamParts, trace rt.AgentToolTrace) (any, any, bool) {
	publicToolInput := rt.Redact(trace.Input)
	toolOutput := rt.Redact(trace.RawOutput)
	if !trace.OK {
		toolOutput = map[string]any{"error": trace.Summary, "errorCode": trace.ErrorCode}
	}
	emitted := emitter.chunk(map[string]any{"type": "tool-input-start", "toolCallId": trace.ID, "toolName": trace.ToolName}) &&
		emitter.chunk(map[string]any{"type": "tool-input-available", "toolCallId": trace.ID, "toolName": trace.ToolName, "input": publicToolInput}) &&
		emitter.chunk(map[string]any{"type": "tool-output-available", "toolCallId": trace.ID, "output": toolOutput})
	parts.addTool(trace.ID, trace.ToolName, publicToolInput, toolOutput)
	return publicToolInput, toolOutput, emitted
}

func publicAgentEvent(event *rt.AgentStreamEvent) map[string]any {
	payload := map[string]any{}
	if event != nil && len(event.Payload) > 0 {
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			payload = map[string]any{}
		}
	}
	if event != nil && event.Type == "agent_stopped" {
		if reason, ok := payload["stopReason"].(string); ok {
			if safe := rt.DescribeStopReasonForUser(rt.AgentStopReason(reason)); safe != "" {
				payload["message"] = safe
			}
		}
	}
	if event == nil {
		return map[string]any{"runId": "", "sequence": 0, "type": "", "timestamp": int64(0), "payload": payload}
	}
	return map[string]any{
		"runId": event.RunID, "sequence": event.Sequence, "type": event.Type,
		"timestamp": event.Timestamp, "payload": payload,
	}
}

func stepStatus(ok bool) string {
	if ok {
		return "COMPLETED"
	}
	return "FAILED"
}

func nullableErrCode(code rt.AgentToolErrorCode) any {
	if code == "" {
		return nil
	}
	return string(code)
}

// agentEventPartType 与 agentAnswerTextID 对照 chat-bridge.ts 的 AGENT_EVENT_PART_TYPE / AGENT_ANSWER_TEXT_ID。
const (
	agentEventPartType = "data-agent-event"
	agentAnswerTextID  = "agent-answer"
)

// dataPartID 高频 delta 复用同一个 data part，其余按 sequence 唯一。
func dataPartID(event *rt.AgentStreamEvent) string {
	if event.Type == "final_answer_delta" {
		return event.RunID + ":answer-delta"
	}
	return event.RunID + ":" + strconv.FormatInt(int64(event.Sequence), 10)
}

// newStreamMessageID 生成流首帧的 messageId（对应 AI SDK 自动生成的 id 形状）。
func newStreamMessageID() string {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("go-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

type assistantStreamParts struct {
	mu    sync.Mutex
	parts []map[string]any
	byID  map[string]int
	text  bool
}

func newAssistantStreamParts() *assistantStreamParts {
	return &assistantStreamParts{parts: []map[string]any{}, byID: map[string]int{}}
}

// addData 复刻 AI SDK data part 的 id 更新语义：相同 id 原位覆盖，所以高频 delta
// 在落库消息里只保留最后一帧，其余事件仍按首次出现顺序可重放。
func (p *assistantStreamParts) addData(id string, data map[string]any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	part := map[string]any{"type": agentEventPartType, "id": id, "data": data}
	if index, exists := p.byID[id]; exists {
		p.parts[index] = part
		return
	}
	p.byID[id] = len(p.parts)
	p.parts = append(p.parts, part)
}

func (p *assistantStreamParts) addText(text string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.text || text == "" {
		return
	}
	p.text = true
	p.parts = append(p.parts, map[string]any{"type": "text", "text": text})
}

func (p *assistantStreamParts) addTool(id, name string, input, output any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	part := map[string]any{
		"type": "tool-" + name, "toolCallId": id, "state": "output-available",
		"input": input, "output": output,
	}
	if index, exists := p.byID[id]; exists {
		p.parts[index] = part
		return
	}
	p.byID[id] = len(p.parts)
	p.parts = append(p.parts, part)
}

func (p *assistantStreamParts) all() []map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]map[string]any{}, p.parts...)
}

func (p *assistantStreamParts) len() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.parts)
}

// assistantEventBridge 对齐 TS createAgentEventWriter：过程 delta 只进入结构化
// data part；final_answer_completed 才落唯一一段标准 text。completed 未携带 text
// 时使用本段 delta 缓冲兜底，且新的 final_answer_started 会丢弃旧段缓冲。
type assistantEventBridge struct {
	emit             func(any) bool
	parts            *assistantStreamParts
	answerBuffer     string
	finalTextWritten bool
}

func newAssistantEventBridge(emit func(any) bool, parts *assistantStreamParts) *assistantEventBridge {
	return &assistantEventBridge{emit: emit, parts: parts}
}

func (b *assistantEventBridge) onEvent(event *rt.AgentStreamEvent) bool {
	publicEvent := publicAgentEvent(event)
	payload, _ := publicEvent["payload"].(map[string]any)
	if payload == nil {
		payload = map[string]any{}
	}

	switch event.Type {
	case "final_answer_started":
		b.answerBuffer = ""
	case "final_answer_delta":
		if delta, ok := payload["delta"].(string); ok {
			b.answerBuffer += delta
		}
	case "final_answer_completed":
		text, exists := payload["text"].(string)
		if !exists {
			text = b.answerBuffer
		}
		b.answerBuffer = text
		if text != "" && !b.finalTextWritten {
			b.finalTextWritten = true
			b.parts.addText(text)
			if !b.emit(map[string]any{"type": "text-start", "id": agentAnswerTextID}) {
				return false
			}
			if !b.emit(map[string]any{"type": "text-delta", "id": agentAnswerTextID, "delta": text}) {
				return false
			}
			if !b.emit(map[string]any{"type": "text-end", "id": agentAnswerTextID}) {
				return false
			}
		}
	}

	partID := dataPartID(event)
	b.parts.addData(partID, publicEvent)
	return b.emit(map[string]any{"type": agentEventPartType, "id": partID, "data": publicEvent})
}

// buildAssistantPersistContent 组装落库 content（对齐 TS 的完整 parts + agentRunId + usage）。
func buildAssistantPersistContent(result *rt.RunResult, runKey string, parts []map[string]any, startedAt time.Time) json.RawMessage {
	content := map[string]any{
		"parts": parts,
	}
	if runKey != "" {
		content["agentRunId"] = runKey
	}
	usage := map[string]any{}
	if result != nil && result.State != nil {
		tu := result.State.TokenUsage
		if tu.Input > 0 {
			usage["inputTokens"] = tu.Input
		}
		if tu.Output > 0 {
			usage["outputTokens"] = tu.Output
		}
		if tu.Total > 0 {
			usage["totalTokens"] = tu.Total
		}
		if len(usage) > 0 {
			content["usage"] = usage
		}
	}
	totalMs := time.Since(startedAt).Milliseconds()
	if totalMs > 0 {
		content["totalStreamTime"] = totalMs
		if out, ok := usage["outputTokens"].(int64); ok && out > 0 {
			content["tokensPerSecond"] = float64(out) / (float64(totalMs) / 1000)
		}
	}
	raw, err := json.Marshal(content)
	if err != nil {
		return json.RawMessage(`{"parts":[]}`)
	}
	return raw
}

// uiMessagesToRuntime 把 UIMessage 转成 Runtime 消息。除标准 text 外，还保留
// 已完成的历史工具调用/结果（含确认卡 executionOutcome）；否则后续轮次会忘记
// 已执行的操作，甚至再次请求确认。未完成的工具调用不进入模型，避免构造出
// 没有对应 tool result 的非法供应商消息。
func uiMessagesToRuntime(messages []json.RawMessage) []map[string]any {
	out := make([]map[string]any, 0, len(messages)*2)
	for messageIndex, raw := range messages {
		var env struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
			Parts   json.RawMessage `json:"parts"`
		}
		if json.Unmarshal(raw, &env) != nil {
			continue
		}
		texts := []string{}
		var str string
		if isJSONString(env.Content) && json.Unmarshal(env.Content, &str) == nil {
			texts = append(texts, str)
		} else {
			parts := env.Parts
			if !isJSONArray(parts) {
				parts = env.Content
			}
			texts = append(texts, collectTextParts(parts)...)
		}
		text := strings.Join(filterNonEmpty(texts), "\n")

		parts := env.Parts
		if !isJSONArray(parts) {
			parts = env.Content
		}
		toolPairs := collectHistoricalToolPairs(parts, messageIndex)
		if env.Role == "assistant" && len(toolPairs) > 0 {
			calls := make([]map[string]any, 0, len(toolPairs))
			for _, pair := range toolPairs {
				calls = append(calls, map[string]any{
					"id": pair.ID, "name": pair.Name, "argsJSON": pair.ArgsJSON,
				})
			}
			out = append(out, map[string]any{"role": "assistant", "content": text, "toolCalls": calls})
			for _, pair := range toolPairs {
				out = append(out, map[string]any{
					"role": "tool", "content": pair.ResultJSON,
					"toolCallId": pair.ID, "toolName": pair.Name,
				})
			}
			continue
		}
		if strings.TrimSpace(text) != "" {
			out = append(out, map[string]any{"role": env.Role, "content": text})
		}
	}
	return out
}

type historicalToolPair struct {
	ID         string
	Name       string
	ArgsJSON   string
	ResultJSON string
}

func collectHistoricalToolPairs(parts json.RawMessage, messageIndex int) []historicalToolPair {
	var items []map[string]any
	if json.Unmarshal(parts, &items) != nil {
		return nil
	}
	out := []historicalToolPair{}
	for partIndex, part := range items {
		name := historicalToolName(part)
		if name == "" {
			continue
		}
		input := firstHistoricalPartValue(part, "input", "args")
		result := firstHistoricalPartValue(part, "output", "result")
		if invocation, ok := part["toolInvocation"].(map[string]any); ok {
			if input == nil {
				input = firstHistoricalPartValue(invocation, "input", "args")
			}
			if result == nil {
				result = firstHistoricalPartValue(invocation, "output", "result")
			}
		}
		if result == nil {
			if errorText, ok := part["errorText"].(string); ok && errorText != "" {
				result = map[string]any{"error": errorText}
			} else {
				// 只保留完整 call/result 对，所有原生协议都要求严格配对。
				continue
			}
		}
		id, _ := part["toolCallId"].(string)
		if id == "" {
			if invocation, ok := part["toolInvocation"].(map[string]any); ok {
				id, _ = invocation["toolCallId"].(string)
			}
		}
		if id == "" {
			id = fmt.Sprintf("history-%d-%d", messageIndex, partIndex)
		}
		if input == nil {
			input = map[string]any{}
		}
		argsJSON, argsErr := json.Marshal(input)
		resultJSON, resultErr := json.Marshal(result)
		if argsErr != nil || resultErr != nil {
			continue
		}
		out = append(out, historicalToolPair{ID: id, Name: name, ArgsJSON: string(argsJSON), ResultJSON: string(resultJSON)})
	}
	return out
}

func historicalToolName(part map[string]any) string {
	if name, ok := part["toolName"].(string); ok && name != "" {
		return name
	}
	if invocation, ok := part["toolInvocation"].(map[string]any); ok {
		if name, ok := invocation["toolName"].(string); ok && name != "" {
			return name
		}
	}
	typeName, _ := part["type"].(string)
	if strings.HasPrefix(typeName, "tool-") && typeName != "tool-call" && typeName != "tool-invocation" {
		return strings.TrimPrefix(typeName, "tool-")
	}
	return ""
}

func firstHistoricalPartValue(part map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, exists := part[key]; exists && value != nil {
			return value
		}
	}
	return nil
}

// ===== 消息转换 =====

type uiMessageEnvelope struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
	Parts   json.RawMessage `json:"parts"`
}

func messageRoleIs(raw json.RawMessage, role string) bool {
	var env uiMessageEnvelope
	if json.Unmarshal(raw, &env) != nil {
		return false
	}
	return env.Role == role
}

// extractLastUserText 对照 chat-handler.ts extractLastUserText：
// 从后往前找第一条有文本的 user 消息；文本取 content 字符串或 text parts 以 \n 连接。
func extractLastUserText(messages []json.RawMessage) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if !messageRoleIs(messages[i], "user") {
			continue
		}
		var env uiMessageEnvelope
		if json.Unmarshal(messages[i], &env) != nil {
			continue
		}
		var str string
		if isJSONString(env.Content) && json.Unmarshal(env.Content, &str) == nil && strings.TrimSpace(str) != "" {
			return strings.TrimSpace(str)
		}
		parts := env.Parts
		if !isJSONArray(parts) {
			parts = env.Content
		}
		if !isJSONArray(parts) {
			continue
		}
		joined := strings.Join(filterNonEmpty(collectTextParts(parts)), "\n")
		if strings.TrimSpace(joined) != "" {
			return strings.TrimSpace(joined)
		}
	}
	return ""
}

// collectTextParts 提取 parts 数组里 type=="text" 的 text 字段。
func collectTextParts(parts json.RawMessage) []string {
	var items []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(parts, &items) != nil {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if item.Type == "text" {
			out = append(out, item.Text)
		}
	}
	return out
}

// ===== 小工具 =====

func filterNonEmpty(in []string) []string {
	out := make([]string, 0, len(in))
	for _, v := range in {
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}

func jsonArrayLen(raw json.RawMessage) int { return len(jsonArrayItems(raw)) }

func jsonArrayItems(raw json.RawMessage) []json.RawMessage {
	if !isJSONArray(raw) {
		return nil
	}
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil {
		return nil
	}
	return items
}
