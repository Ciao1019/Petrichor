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
	"sync/atomic"
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

var stepCounter atomic.Int64

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

	runID, err := createAssistantRun(ctx, thread.ID, resolved.ModelID)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	streamChatCompletion(c, streamContext{
		user:     user,
		thread:   thread,
		runID:    runID,
		resolved: resolved,
		messages: messages,
		goal:     goal,
		qaMode:   qaMode,
	})
}

type streamContext struct {
	user     *auth.User
	thread   *assistantThreadRow
	runID    int64
	resolved *aicore.ResolvedModel
	messages []json.RawMessage
	goal     string
	qaMode   string
}

// createAssistantRun 对应 createAssistantRun：status RUNNING、意图域先置空数组。
func createAssistantRun(ctx context.Context, threadID, modelConfigID int64) (int64, error) {
	var runID int64
	err := dbPool().QueryRow(ctx,
		`INSERT INTO petrichor_assistant_run (thread_id, status, model_config_id, intent_domains_json)
		 VALUES ($1, 'RUNNING', $2, $3) RETURNING id`,
		threadID, modelConfigID, "[]").Scan(&runID)
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
	c *gin.Context
}

func (s *sseEmitter) chunk(v any) bool {
	raw, err := json.Marshal(v)
	if err != nil {
		return true
	}
	if _, werr := s.c.Writer.Write(append([]byte("data: "), append(raw, '\n', '\n')...)); werr != nil {
		return false
	}
	s.c.Writer.Flush()
	return true
}

func (s *sseEmitter) done() {
	_, _ = s.c.Writer.Write([]byte("data: [DONE]\n\n"))
	s.c.Writer.Flush()
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
	ctx := c.Request.Context()
	startedAt := time.Now()

	// 对齐 TS chat-bridge：最终答案只在 final_answer_completed 时写一段标准 text；
	// 过程话绝不提前写进聊天消息（标准 text 不能撤回）。
	agentAnswerWritten := false
	messageID := newStreamMessageID()

	// createUIMessageStream 会在流首尾自动补 start/finish 帧，这里显式对齐
	emitter.chunk(map[string]any{"type": "start", "messageId": messageID})

	runtime := rt.NewRuntime()
	resolved := sc.resolved
	modelHandle := &rt.ResolvedModelHandle{
		Runtime: resolved.Runtime,
		ModelID: resolved.ModelRef,
		Options: resolved.Options,
	}

	runRequest := &rt.RunRequest{
		ConversationID: idStr(sc.thread.ID),
		UserID:         sc.user.ID,
		DBRunID:        sc.runID,
		ThreadID:       sc.thread.ID,
		SystemRole:     sc.user.SystemRole,
		Goal:           sc.goal,
		Messages:       uiMessagesToRuntime(sc.messages),
		Model:          modelHandle,
		ModelName:      resolved.ModelRef,
		StartedAt:      startedAt.UnixMilli(),
		TurnCount:      len(sc.messages),
		QaMode:         sc.qaMode,
		OnEvent: func(event *rt.AgentStreamEvent) {
			var payloadMap map[string]any
			if len(event.Payload) > 0 {
				if err := json.Unmarshal(event.Payload, &payloadMap); err != nil {
					payloadMap = map[string]any{}
				}
			}

			switch event.Type {
			case "final_answer_started":
				// 服务端只把最后一段当作最终答案：这里跟着重置兜底缓冲。
				if payloadMap == nil {
					payloadMap = map[string]any{}
				}
			case "final_answer_delta":
				_ = payloadMap
			case "final_answer_completed":
				text := ""
				if t, ok := payloadMap["text"].(string); ok && strings.TrimSpace(t) != "" {
					text = t
				}
				if text != "" && !agentAnswerWritten {
					agentAnswerWritten = true
					emitter.chunk(map[string]any{"type": "text-start", "id": agentAnswerTextID})
					emitter.chunk(map[string]any{"type": "text-delta", "id": agentAnswerTextID, "delta": text})
					emitter.chunk(map[string]any{"type": "text-end", "id": agentAnswerTextID})
				}
			case "agent_stopped":
				// 停止原因转成面向用户的安全文案，内部策略名不外泄
				if reason, ok := payloadMap["stopReason"].(string); ok {
					if safe := rt.DescribeStopReasonForUser(rt.AgentStopReason(reason)); safe != "" {
						payloadMap["message"] = safe
					}
				}
			case "agent_completed", "agent_cancelled", "agent_error":
			default:
			}

			emitter.chunk(map[string]any{
				"type": agentEventPartType,
				"id":   dataPartID(event),
				"data": map[string]any{
					"runId":     event.RunID,
					"sequence":  event.Sequence,
					"type":      event.Type,
					"timestamp": event.Timestamp,
					"payload":   payloadMap,
				},
			})
		},
		OnToolTrace: func(trace rt.AgentToolTrace) {
			// 对齐 TS onToolTrace → assistant_step 表
			inputJSON, _ := json.Marshal(trace.Input)
			var outputPayload any = map[string]any{"summary": trace.Summary}
			if trace.OK && trace.RawOutput != nil {
				outputPayload = trace.RawOutput
			} else if !trace.OK {
				outputPayload = map[string]any{"error": trace.Summary, "errorCode": trace.ErrorCode}
			}
			outputJSON, _ := json.Marshal(outputPayload)
			_, _ = dbPool().Exec(context.Background(),
				`INSERT INTO petrichor_assistant_step
				 (run_id, step_index, tool_name, input_json, output_json, status, error_code, duration_ms)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
				sc.runID, int(stepCounter.Add(1))-1, trace.ToolName,
				string(inputJSON), string(outputJSON),
				stepStatus(trace.OK), nullableErrCode(trace.ErrorCode), trace.DurationMs)
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
	case result != nil && result.State.Status == rt.StatusCancelled:
		status, errorCode = "FAILED", streamAbortedCode
	default:
		emitter.chunk(map[string]any{"type": "finish"})
	}

	_ = finishAssistantRun(context.Background(), sc.runID, status, errorCode)

	// 落库不阻塞流关闭；失败只记录日志（fail-open）
	if result != nil && result.Answer != "" {
		content := buildAssistantPersistContent(result, startedAt)
		if perr := persistAssistantMessage(context.Background(), sc.user.ID, sc.thread.ID, "assistant", content, ""); perr != nil {
			gin.DefaultErrorWriter.Write([]byte("[assistantsvc.chat] persist assistant message: " + perr.Error() + "\n"))
		}
	}

	if runErr != nil || (result != nil && result.State.Status == rt.StatusFailed) {
		emitter.errorFrame()
	}
	emitter.done()
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

// buildAssistantPersistContent 组装落库 content（对齐 TS 的 parts + agentRunId + usage）。
func buildAssistantPersistContent(result *rt.RunResult, startedAt time.Time) json.RawMessage {
	content := map[string]any{
		"parts": []map[string]any{{"type": "text", "text": result.Answer}},
	}
	if result.RunID != "" {
		content["agentRunId"] = result.RunID
	}
	usage := map[string]any{}
	if tu := result.State.TokenUsage; tu.Input > 0 || tu.Output > 0 {
		if tu.Input > 0 {
			usage["inputTokens"] = tu.Input
		}
		if tu.Output > 0 {
			usage["outputTokens"] = tu.Output
		}
		if tu.Total > 0 {
			usage["totalTokens"] = tu.Total
		}
		content["usage"] = usage
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
		return json.RawMessage(`{"parts":[{"type":"text","text":""}]}`)
	}
	return raw
}

// uiMessagesToRuntime 把 UIMessage 数组转成 Runtime 消息（role+content 文本）。
func uiMessagesToRuntime(messages []json.RawMessage) []map[string]any {
	out := make([]map[string]any, 0, len(messages))
	for _, raw := range messages {
		var env struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
			Parts   json.RawMessage `json:"parts"`
		}
		if json.Unmarshal(raw, &env) != nil {
			continue
		}
		text := ""
		var str string
		if isJSONString(env.Content) && json.Unmarshal(env.Content, &str) == nil {
			text = str
		} else {
			parts := env.Parts
			if !isJSONArray(parts) {
				parts = env.Content
			}
			text = strings.Join(filterNonEmpty(collectTextParts(parts)), "\n")
		}
		if strings.TrimSpace(text) == "" {
			continue
		}
		out = append(out, map[string]any{"role": env.Role, "content": text})
	}
	return out
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
