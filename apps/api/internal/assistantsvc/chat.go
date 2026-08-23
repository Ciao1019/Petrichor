// chat.go 对照 chat-handler.ts（V2 对外契约）：
// 接收消息 → 持久化 thread/message/run → 调用 CHAT 绑定模型流式补全 →
// 以 assistant-ui UIMessage 流协议（SSE）把增量文本推给前端 → 结束落最终消息与 run 状态。
//
// 内部工具编排（V2 完整 tool loop / 意图路由 / 上下文压缩）按移植约定简化为纯对话补全；
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
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/aicore"
	"petrichor/api/internal/auth"
	httpx "petrichor/api/internal/httpx"
)

// uiMessageStreamHeaders 复刻 ai 包 UI_MESSAGE_STREAM_HEADERS 与业务响应头。
const headerThreadID = "X-Petrichor-Assistant-Thread-Id"

const headerRunID = "X-Petrichor-Assistant-Run-Id"

const streamAbortedCode = "stream_aborted"

const streamErrorCode = "stream_error"

// genericStreamErrorText 与 AI SDK 默认 onError 一致：不向客户端泄露服务端错误细节。
const genericStreamErrorText = "An error occurred."

// errStreamWriteFailed 客户端断开导致帧写入失败，按中断收敛。
var errStreamWriteFailed = errors.New("assistant stream write failed")

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
	if req.QaMode != nil && *req.QaMode != "normal" && *req.QaMode != "wiki" {
		httpx.ErrorJSON(c, 400, "请求参数错误")
		return
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
	})
}

type streamContext struct {
	user     *auth.User
	thread   *assistantThreadRow
	runID    int64
	resolved *aicore.ResolvedModel
	messages []json.RawMessage
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

// streamChatCompletion 执行纯对话补全并把增量文本按协议推给前端。
func streamChatCompletion(c *gin.Context, sc streamContext) {
	w := c.Writer
	header := w.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-cache")
	header.Set("Connection", "keep-alive")
	header.Set("X-Accel-Buffering", "no")
	header.Set("X-Vercel-Ai-Ui-Message-Stream", "v1")
	header.Set(headerThreadID, idStr(sc.thread.ID))
	header.Set(headerRunID, idStr(sc.runID))
	w.WriteHeader(http.StatusOK)

	emitter := &sseEmitter{c: c}
	ctx := c.Request.Context()

	messageID := newStreamID()
	textPartID := newStreamID()
	emitter.chunk(map[string]any{"type": "start", "messageId": messageID})
	emitter.chunk(map[string]any{"type": "start-step"})
	emitter.chunk(map[string]any{"type": "text-start", "id": textPartID})

	modelMessages := buildChatMessages(sc.messages)
	msgs := make([]aicore.ChatMessage, 0, len(modelMessages)+1)
	msgs = append(msgs, aicore.ChatMessage{Role: "system", Content: assistantSystemPrompt()})
	msgs = append(msgs, modelMessages...)

	rt := sc.resolved.Runtime
	rt.Quirks = aicore.ResolveQuirks(rt.ProviderKey, sc.resolved.ModelRef)

	var answer strings.Builder
	chatStartedAt := time.Now()
	result, err := aicore.ChatStream(ctx, rt, sc.resolved.ModelRef, msgs, sc.resolved.Options,
		func(delta string) error {
			answer.WriteString(delta)
			if !emitter.chunk(map[string]any{"type": "text-delta", "id": textPartID, "delta": delta}) {
				return errStreamWriteFailed
			}
			return nil
		})
	streamSettledAt := time.Now()

	status := "COMPLETED"
	errorCode := ""
	if err != nil {
		status = "FAILED"
		if errors.Is(err, context.Canceled) || errors.Is(err, errStreamWriteFailed) {
			errorCode = streamAbortedCode
		} else {
			errorCode = streamErrorCode
		}
	} else {
		emitter.chunk(map[string]any{"type": "text-end", "id": textPartID})
		emitter.chunk(map[string]any{"type": "finish-step"})
		emitter.chunk(map[string]any{"type": "finish"})
	}

	_ = finishAssistantRun(context.Background(), sc.runID, status, errorCode)

	// 落库不阻塞流关闭；失败只记录日志（fail-open）
	answerText := answer.String()
	if answerText != "" {
		content := map[string]any{
			"parts": []map[string]any{{"type": "text", "text": answerText}},
		}
		if result != nil {
			usage := flatUsage(result)
			if usage != nil {
				content["usage"] = usage
			}
			totalStreamTime := maxInt64(0, streamSettledAt.Sub(chatStartedAt).Milliseconds())
			if totalStreamTime > 0 {
				content["totalStreamTime"] = totalStreamTime
				outputTokens := usage["outputTokens"]
				if v, ok := outputTokens.(int64); ok && v > 0 {
					content["tokensPerSecond"] = float64(v) / (float64(totalStreamTime) / 1000)
				}
			}
		}
		if perr := persistAssistantMessage(context.Background(), sc.user.ID, sc.thread.ID, "assistant", content, ""); perr != nil {
			gin.DefaultErrorWriter.Write([]byte("[assistantsvc.chat] persist assistant message: " + perr.Error() + "\n"))
		}
	}

	if err != nil {
		emitter.errorFrame()
	}
	emitter.done()
}

// assistantSystemPrompt 纯对话补全运行时的精简系统提示（对照 buildAssistantSystemPrompt 的公共约束）。
func assistantSystemPrompt() string {
	return strings.Join([]string{
		"你是 Petrichor 的站内助手，以对话方式帮助已登录用户查看和操作系统。",
		"站内事实必须以检索与工具结果为准；检索不到就如实说明，不要编造数据、来源、链接或原文片段。",
		"只使用中文回答，直接、结构清晰。",
	}, "\n")
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

// buildChatMessages 对照 convertToModelMessages：仅保留带文本的 user/assistant/system 消息。
func buildChatMessages(messages []json.RawMessage) []aicore.ChatMessage {
	out := make([]aicore.ChatMessage, 0, len(messages))
	for _, raw := range messages {
		var env uiMessageEnvelope
		if json.Unmarshal(raw, &env) != nil {
			continue
		}
		role := ""
		switch env.Role {
		case "user", "assistant", "system":
			role = env.Role
		default:
			continue
		}
		var str string
		if isJSONString(env.Content) && json.Unmarshal(env.Content, &str) == nil {
			if strings.TrimSpace(str) != "" {
				out = append(out, aicore.ChatMessage{Role: role, Content: str})
			}
			continue
		}
		parts := env.Parts
		if !isJSONArray(parts) {
			parts = env.Content
		}
		if !isJSONArray(parts) {
			continue
		}
		text := strings.Join(filterNonEmpty(collectTextParts(parts)), "\n")
		if strings.TrimSpace(text) == "" {
			continue
		}
		out = append(out, aicore.ChatMessage{Role: role, Content: text})
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

func newStreamID() string {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("go-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// flatUsage 对应 flattenAssistantUsage：压成扁平 token 字段，无有效值时返回 nil。
func flatUsage(result *aicore.ChatResult) map[string]any {
	if result == nil || (result.InputTokens <= 0 && result.OutputTokens <= 0) {
		return nil
	}
	usage := map[string]any{}
	if result.InputTokens > 0 {
		usage["inputTokens"] = result.InputTokens
	}
	if result.OutputTokens > 0 {
		usage["outputTokens"] = result.OutputTokens
	}
	total := result.InputTokens + result.OutputTokens
	if total > 0 {
		usage["totalTokens"] = total
	}
	return usage
}
