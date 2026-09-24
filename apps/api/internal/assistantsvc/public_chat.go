package assistantsvc

// public_chat.go 前台公开问答入口 POST /api/public/qa/chat。
//
// 与后台助手使用同一套 Runtime 编排（意图、复杂度、计划、上下文、证据与质量门）、
// Agent 事件与 UIMessage 流协议，只换成公开档位：工具仅能读取匿名公开资料。
// 访客匿名且不落库：服务端不保存对话、运行与步骤记录，历史由访客浏览器保存。

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	aicore "petrichor/api/internal/aicore"
	rt "petrichor/api/internal/assistantsvc/runtime"
	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/publicapi"
	"petrichor/api/internal/sitecontent"
)

const (
	publicChatMaxQuestionChars = 8000
	publicChatMaxHistoryChars  = 32000
	publicChatMaxHistoryItems  = 24
	publicChatMaxBodyBytes     = 512 * 1024
	// 匿名入口限定单次运行时长，避免长链路持续占用站长的模型额度。
	publicChatTimeout = 3 * time.Minute
)

type publicChatRequest struct {
	Messages json.RawMessage `json:"messages"`
	Focus    json.RawMessage `json:"focus"`
}

// PublicChatHandler 前置行为：站长关闭 403、参数错误 400、限流 429、站点或模型未就绪 400；随后进入 SSE。
func PublicChatHandler(c *gin.Context) {
	startedAt := time.Now()
	ctx := c.Request.Context()
	if !sitecontent.IsPublicQaEnabled(ctx) {
		httpx.ErrorJSON(c, http.StatusForbidden, "站长已关闭前台问答功能")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, publicChatMaxBodyBytes)
	var req publicChatRequest
	if err := c.ShouldBindJSON(&req); err != nil || !isJSONArray(req.Messages) || jsonArrayLen(req.Messages) < 1 {
		httpx.ErrorJSON(c, http.StatusBadRequest, "请求参数错误")
		return
	}
	messages := jsonArrayItems(req.Messages)
	goal := extractLastUserText(messages)
	if !messageRoleIs(messages[len(messages)-1], "user") || goal == "" || runeLen(goal) > publicChatMaxQuestionChars {
		httpx.ErrorJSON(c, http.StatusBadRequest, "请提供不超过 8000 字的问题")
		return
	}
	knowledgeBaseID, ok := parsePublicChatFocus(req.Focus)
	if !ok {
		httpx.ErrorJSON(c, http.StatusBadRequest, "提问范围无效")
		return
	}
	if knowledgeBaseID > 0 {
		scope, err := publicapi.LoadPublicKnowledgeScope(ctx, knowledgeBaseID)
		if err != nil {
			httpx.HandleError(c, err)
			return
		}
		if len(scope.KnowledgeBases()) == 0 {
			httpx.ErrorJSON(c, http.StatusBadRequest, "该知识库暂无公开资料")
			return
		}
	}

	// 限流：浏览器指纹主键 + IP 兜底。
	quota, err := publicapi.ConsumePublicQaQuota(ctx, publicapi.ResolveFingerprint(c), publicapi.ResolveClientIp(c))
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	ownerID, err := publicapi.SiteOwnerUserID(ctx)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	resolved, err := aicore.ResolveModelForPurpose(ctx, ownerID, aicore.PurposeChat, nil)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	streamPublicChat(c, publicChatStream{
		resolved: resolved, messages: messages, goal: goal, knowledgeBaseID: knowledgeBaseID,
		quotaRemaining: quota.Remaining, quotaLimit: quota.Limit, startedAt: startedAt,
	})
}

// parsePublicChatFocus 只接受 {knowledgeBaseId: string|number|null}；其余范围字段属于后台能力。
func parsePublicChatFocus(raw json.RawMessage) (int64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return 0, true
	}
	var focus map[string]any
	if json.Unmarshal(raw, &focus) != nil {
		return 0, false
	}
	value, exists := focus["knowledgeBaseId"]
	if !exists || value == nil {
		return 0, true
	}
	if id := parseID(value); id > 0 {
		return id, true
	}
	return 0, false
}

// publicChatRuntimeMessages 只保留普通对话文本：匿名客户端的历史不能注入工具结果、确认结果或系统身份。
func publicChatRuntimeMessages(messages []json.RawMessage) []map[string]any {
	out := []map[string]any{}
	remaining := publicChatMaxHistoryChars
	for index := len(messages) - 1; index >= 0 && len(out) < publicChatMaxHistoryItems; index-- {
		var env struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
			Parts   json.RawMessage `json:"parts"`
		}
		if json.Unmarshal(messages[index], &env) != nil || (env.Role != "user" && env.Role != "assistant") {
			continue
		}
		texts := []string{}
		var content string
		if isJSONString(env.Content) && json.Unmarshal(env.Content, &content) == nil {
			texts = append(texts, content)
		} else {
			parts := env.Parts
			if !isJSONArray(parts) {
				parts = env.Content
			}
			texts = append(texts, collectTextParts(parts)...)
		}
		runes := []rune(strings.TrimSpace(strings.Join(filterNonEmpty(texts), "\n")))
		if len(runes) == 0 {
			continue
		}
		if len(runes) > publicChatMaxQuestionChars {
			runes = runes[:publicChatMaxQuestionChars]
		}
		if len(runes) > remaining {
			break
		}
		remaining -= len(runes)
		out = append(out, map[string]any{"role": env.Role, "content": string(runes)})
	}
	for left, right := 0, len(out)-1; left < right; left, right = left+1, right-1 {
		out[left], out[right] = out[right], out[left]
	}
	return out
}

type publicChatStream struct {
	resolved        *aicore.ResolvedModel
	messages        []json.RawMessage
	goal            string
	knowledgeBaseID int64
	quotaRemaining  int64
	quotaLimit      int64
	startedAt       time.Time
}

func streamPublicChat(c *gin.Context, params publicChatStream) {
	header := c.Writer.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-store")
	header.Set("Connection", "keep-alive")
	header.Set("X-Accel-Buffering", "no")
	header.Set("Content-Encoding", "identity")
	header.Set("X-Vercel-Ai-Ui-Message-Stream", "v1")
	header.Set("X-Petrichor-Qa-Remaining", strconv.FormatInt(params.quotaRemaining, 10))
	header.Set("X-Petrichor-Qa-Limit", strconv.FormatInt(params.quotaLimit, 10))
	c.Writer.WriteHeader(http.StatusOK)

	emitter := &sseEmitter{c: c}
	ctx, cancel := context.WithTimeout(c.Request.Context(), publicChatTimeout)
	defer cancel()
	messageID := newStreamMessageID()
	parts := newAssistantStreamParts()
	bridge := newAssistantEventBridge(emitter.chunk, parts)
	emitter.chunk(map[string]any{"type": "start", "messageId": messageID})

	var focus map[string]any
	if params.knowledgeBaseID > 0 {
		focus = map[string]any{"knowledgeBaseId": strconv.FormatInt(params.knowledgeBaseID, 10)}
	}
	// 公开档位只有知识域，意图固定为知识库；复杂度仍由 Runtime 按问题本身判定。
	routingHint := &rt.RoutingHint{Domains: []string{"knowledge"}, Confidence: 0.8, Reasoning: "public:knowledge"}
	emitAssistantDataPart(emitter, parts, intentRoutePartType, messageID+":intent", map[string]any{
		"status": "done", "domains": routingHint.Domains,
	})

	resolved := params.resolved
	runKey := rt.NewRunID()
	result, runErr := rt.NewRuntimeWithProfile(publicQaRuntimeProfile()).Run(ctx, &rt.RunRequest{
		RunKey:         runKey,
		ConversationID: "public-" + runKey,
		Goal:           params.goal,
		Focus:          focus,
		Messages:       publicChatRuntimeMessages(params.messages),
		Model: &rt.ResolvedModelHandle{
			Runtime: resolved.Runtime, ModelID: resolved.ModelRef, Options: resolved.Options,
		},
		ModelName:         resolved.ModelRef,
		StartedAt:         params.startedAt.UnixMilli(),
		TurnCount:         len(params.messages),
		RoutingHint:       routingHint,
		InjectionGuard:    &struct{ ProviderKey, ModelID string }{ProviderKey: resolved.ProviderKey, ModelID: resolved.ModelRef},
		ContextTokenLimit: assistantContextTokenLimit(resolved.ContextWindow),
		OnEvent: func(event *rt.AgentStreamEvent) {
			if !bridge.onEvent(event) {
				cancel()
			}
		},
		OnToolTrace: func(trace rt.AgentToolTrace) {
			if _, _, emitted := emitAssistantToolTraceChunks(emitter, parts, trace); !emitted {
				cancel()
			}
		},
	})
	if runErr != nil && !errors.Is(runErr, context.Canceled) {
		slog.Error("公开问答运行失败", "agentRunId", runKey, "provider", resolved.ProviderKey,
			"model", resolved.ModelRef, "status", publicChatRunStatus(result), "err", runErr)
	}
	if runErr != nil {
		emitter.errorFrame()
	}
	emitter.chunk(map[string]any{"type": "finish"})
	emitter.done()
	if streamErr := emitter.Err(); streamErr != nil {
		slog.Warn("公开问答 SSE 输出失败", "agentRunId", runKey, "err", streamErr)
	}
}

func publicChatRunStatus(result *rt.RunResult) string {
	if result == nil || result.State == nil {
		return ""
	}
	return string(result.State.Status)
}
