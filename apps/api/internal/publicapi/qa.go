// qa.go 前台公开问答：限流（visitor-id 主键 + IP 兜底）→ 最多 8 步只读工具循环 →
// CHAT 模型流式补全，以 assistant-ui UIMessage 流协议（SSE）输出。
package publicapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/aicore"
	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/sitecontent"
)

// 单浏览器（visitor-id）每小时提问上限——面向真实用户的主限流键。
const PublicQaVisitorHourlyLimit = 10

// 单 IP 每小时提问兜底上限——防止清除 visitor-id 后无限刷量。
const PublicQaIPHourlyLimit = 60

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// ResolveClientIp 只接受 Gin 根据 server.trusted_proxies 解析后的地址。
func ResolveClientIp(c *gin.Context) string {
	return strings.TrimSpace(c.ClientIP())
}

// ResolveVisitorId 读取并校验客户端 visitor-id（localStorage 里的 UUID）；非法返回空串。
func ResolveVisitorId(c *gin.Context) string {
	raw := strings.TrimSpace(c.GetHeader("X-Petrichor-Visitor-Id"))
	if raw == "" || !uuidPattern.MatchString(raw) {
		return ""
	}
	return strings.ToLower(raw)
}

// hourBucket 当前小时的窗口标识（UTC），形如 2026061013。
func hourBucket(now time.Time) string {
	t := now.UTC()
	year := strconv.Itoa(t.Year())
	month := pad2(int(t.Month()))
	day := pad2(t.Day())
	hour := pad2(t.Hour())
	return year + month + day + hour
}

func pad2(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

// bumpBucket 原子自增某个计数桶并返回自增后的计数。
func bumpBucket(ctx context.Context, bucketKey string, now time.Time) (int64, error) {
	var count int64
	err := pool().QueryRow(ctx,
		`INSERT INTO petrichor_public_qa_rate_limit (bucket_key, count, window_started_at, updated_at)
		 VALUES ($1, 1, $2, $2)
		 ON CONFLICT (bucket_key) DO UPDATE SET count = petrichor_public_qa_rate_limit.count + 1,
		   updated_at = $2
		 RETURNING count`, bucketKey, now).Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}

type publicQaQuotaResult struct {
	Remaining int64
	Limit     int64
}

// ConsumePublicQaQuota 复合键限流：visitor-id 主键（10/h）+ IP 兜底（60/h）。
// 任一桶超限抛 429。无 visitor-id 时退化为「以 IP 作主键、按 10/h」。
func ConsumePublicQaQuota(ctx context.Context, visitorID, ip string) (*publicQaQuotaResult, error) {
	now := timeNow()
	bucket := hourBucket(now)
	var ipKey string
	if ip != "" {
		ipKey = "ip:" + ip + ":" + bucket
	}

	primaryKey := ipKey
	if visitorID != "" {
		primaryKey = "visitor:" + visitorID + ":" + bucket
	}
	primaryLimit := int64(PublicQaVisitorHourlyLimit)

	// 兜底：仅在主键是 visitor 时，额外按 IP 设更高上限（两者是不同维度）。
	backstopKey := ""
	if visitorID != "" {
		backstopKey = ipKey
	}

	remaining := primaryLimit
	if primaryKey != "" {
		primaryCount, err := bumpBucket(ctx, primaryKey, now)
		if err != nil {
			return nil, err
		}
		remaining = primaryLimit - primaryCount
		if remaining < 0 {
			remaining = 0
		}
		if primaryCount > primaryLimit {
			return nil, httpx.TooManyRequests(
				"本小时提问已达上限（" + strconvItoa(int(primaryLimit)) + " 次），请稍后再试")
		}
	}
	if backstopKey != "" {
		ipCount, err := bumpBucket(ctx, backstopKey, now)
		if err != nil {
			return nil, err
		}
		if ipCount > int64(PublicQaIPHourlyLimit) {
			return nil, httpx.TooManyRequests("当前网络访问过于频繁，请稍后再试")
		}
	}

	return &publicQaQuotaResult{Remaining: remaining, Limit: primaryLimit}, nil
}

// ===== QaChat POST /api/public/qa/chat =====

const (
	qaModeNormal = "normal"
	qaModeWiki   = "wiki"

	qaContextChars = 1600 // 单篇文章送入提示词的正文长度上限
)

type qaChatRequest struct {
	Messages []json.RawMessage `json:"messages"`
}

type qaUIMessageEnvelope struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
	Parts   json.RawMessage `json:"parts"`
}

// QaChat 前置行为保持 TS 契约：站长关闭 403、参数错误 400、限流 429、
// 站点未初始化/模型未配置 400；随后进入 SSE 流式回答。
func QaChat(c *gin.Context) {
	ctx := c.Request.Context()

	// 站长关闭前台问答时按 TS 契约返回 403。
	if !sitecontent.IsPublicQaEnabled(ctx) {
		httpx.ErrorJSON(c, http.StatusForbidden, "站长已关闭前台问答功能")
		return
	}

	var req qaChatRequest
	if err := c.ShouldBindJSON(&req); err != nil || len(req.Messages) < 1 {
		httpx.ErrorJSON(c, http.StatusBadRequest, "请求参数错误")
		return
	}

	// 限流：visitor-id 主键（10/h）+ IP 兜底（60/h）。
	quota, err := ConsumePublicQaQuota(ctx, ResolveVisitorId(c), ResolveClientIp(c))
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	ownerUserID, err := loadSiteOwnerUserID(ctx)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	resolved, err := aicore.ResolveModelForPurpose(ctx, ownerUserID, aicore.PurposeChat, nil)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	mode := qaModeNormal
	if strings.EqualFold(strings.TrimSpace(c.GetHeader("X-Petrichor-Qa-Mode")), qaModeWiki) {
		mode = qaModeWiki
	}

	scope, err := loadPublicArticleScope(ctx)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	tools := buildPublicQaTools(scope, mode)

	streamPublicQaAnswer(c, streamPublicQaParams{
		resolved:       resolved,
		messages:       req.Messages,
		systemPrompt:   buildPublicQaSystemPrompt(mode),
		tools:          tools,
		quotaRemaining: quota.Remaining,
		quotaLimit:     quota.Limit,
	})
}

// loadSiteOwnerUserID 对应 getSiteOwnerUserId：首个 SUPER_ADMIN 即站点所有者。
func loadSiteOwnerUserID(ctx context.Context) (int64, error) {
	var id int64
	err := pool().QueryRow(ctx,
		`SELECT id FROM petrichor_user WHERE system_role = 'SUPER_ADMIN' ORDER BY id ASC LIMIT 1`).
		Scan(&id)
	if err != nil {
		return 0, badReq("公开问答暂不可用：站点尚未初始化站长账号")
	}
	return id, nil
}

// ===== 消息转换（对照 convertToModelMessages 的文本子集）=====

// qaBuildModelMessages 仅保留带文本的 user/assistant/system 消息。
func qaBuildModelMessages(messages []json.RawMessage) []aicore.ChatMessage {
	out := make([]aicore.ChatMessage, 0, len(messages))
	for _, raw := range messages {
		text := qaMessageText(raw, "")
		if text == "" {
			continue
		}
		var env qaUIMessageEnvelope
		if json.Unmarshal(raw, &env) != nil {
			continue
		}
		out = append(out, aicore.ChatMessage{Role: env.Role, Content: text})
	}
	return out
}

func qaMessageText(raw json.RawMessage, roleFilter string) string {
	var env qaUIMessageEnvelope
	if json.Unmarshal(raw, &env) != nil {
		return ""
	}
	if roleFilter != "" && env.Role != roleFilter {
		return ""
	}
	switch env.Role {
	case "user", "assistant", "system":
	default:
		return ""
	}
	var str string
	if len(env.Content) > 0 && json.Unmarshal(env.Content, &str) == nil {
		return strings.TrimSpace(str)
	}
	parts := env.Parts
	if !isQaJSONArray(parts) {
		parts = env.Content
	}
	if !isQaJSONArray(parts) {
		return ""
	}
	var items []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(parts, &items) != nil {
		return ""
	}
	texts := []string{}
	for _, item := range items {
		if item.Type == "text" && strings.TrimSpace(item.Text) != "" {
			texts = append(texts, strings.TrimSpace(item.Text))
		}
	}
	return strings.Join(texts, "\n")
}

func isQaJSONArray(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	return strings.HasPrefix(trimmed, "[")
}

// ===== 公开文章/Wiki 工具的只读检索基础 =====

type qaArticleHit struct {
	articleID int64
	title     string
	shareCode string
	excerpt   string
	contentMd string
}

type qaWikiHit struct {
	pageKey   string
	title     string
	kind      string
	summary   string
	contentMd string
}

// publicShareVisibilityWhere 公开可见性条件（永久分享已启用、未撤销、无密码、未过期），
// 与 loadPublicArticleScope 保持一致。
const publicShareVisibilityWhere = `s.enabled = true AND s.revoked_at IS NULL
	AND (s.password_hash IS NULL OR btrim(s.password_hash) = '')
	AND (s.expires_at IS NULL OR s.expires_at > now())`

// searchPublicQaArticles 对照 ArticleSearch 的相似度排序，但只取无密码有效分享的文章。
func searchPublicQaArticles(ctx context.Context, query string, limit int64) ([]qaArticleHit, error) {
	likePattern := "%" + escapeLikePattern(query) + "%"
	rows, err := pool().Query(ctx,
		`SELECT a.id, a.title, s.share_code,
			coalesce(a.public_excerpt, coalesce(a.ai_summary, '')), a.content_md,
			(similarity(a.title, $2) * 4
			 + similarity(coalesce(a.public_excerpt, ''), $2) * 2
			 + similarity(coalesce(a.content_md, ''), $2)) AS score
		 FROM petrichor_kb_article_share s
		 JOIN petrichor_kb_article a ON a.id = s.article_id
		 WHERE `+publicShareVisibilityWhere+`
		   AND (a.title ILIKE $1
		     OR coalesce(a.public_excerpt, '') ILIKE $1
		     OR coalesce(a.ai_summary, '') ILIKE $1
		     OR coalesce(a.content_md, '') ILIKE $1)
		 ORDER BY score DESC, a.updated_at DESC
		 LIMIT $3`,
		likePattern, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hits := []qaArticleHit{}
	for rows.Next() {
		var hit qaArticleHit
		var score float64
		if serr := rows.Scan(&hit.articleID, &hit.title, &hit.shareCode, &hit.excerpt, &hit.contentMd, &score); serr != nil {
			return nil, serr
		}
		hits = append(hits, hit)
	}
	return hits, rows.Err()
}

// searchPublicQaWikiPages Wiki 页面检索：页面经由 source_ref 关联到公开文章才可达
// （与 resolveAccessiblePage 的可见性边界一致）。
func searchPublicQaWikiPages(ctx context.Context, query string, limit int64) ([]qaWikiHit, error) {
	likePattern := "%" + escapeLikePattern(query) + "%"
	rows, err := pool().Query(ctx,
		`SELECT DISTINCT p.id, p.page_key, p.title, p.kind,
			coalesce(p.summary, ''), p.content_md,
			(similarity(p.title, $2) * 4 + similarity(p.content_md, $2)) AS score
		 FROM petrichor_kb_wiki_page p
		 JOIN petrichor_kb_wiki_source_ref r ON r.page_id = p.id
		 JOIN petrichor_kb_article_share s ON s.article_id = r.article_id
		 WHERE `+publicShareVisibilityWhere+`
		   AND p.archived_at IS NULL AND p.kind NOT IN ('source', 'index', 'log')
		   AND (p.title ILIKE $1 OR coalesce(p.summary, '') ILIKE $1 OR p.content_md ILIKE $1)
		 ORDER BY score DESC
		 LIMIT $3`,
		likePattern, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hits := []qaWikiHit{}
	seen := map[int64]struct{}{}
	for rows.Next() {
		var id int64
		var hit qaWikiHit
		var score float64
		if serr := rows.Scan(&id, &hit.pageKey, &hit.title, &hit.kind, &hit.summary, &hit.contentMd, &score); serr != nil {
			return nil, serr
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		hits = append(hits, hit)
	}
	return hits, rows.Err()
}

func clipQaText(text string, max int) string {
	flat := spaceRe.ReplaceAllString(fenceRe.ReplaceAllString(text, " "), " ")
	runes := []rune(strings.TrimSpace(flat))
	if len(runes) <= max {
		return strings.TrimSpace(flat)
	}
	return strings.TrimSpace(string(runes[:max])) + "…"
}

// ===== 提示词（对照 TS buildPublicQaSystemPrompt / buildWikiQaSystemPrompt）=====

func buildPublicQaSystemPrompt(mode string) string {
	if mode == qaModeWiki {
		return strings.Join([]string{
			"你是本站的公开 Wiki 问答助手，面向未登录的访客，知识范围严格限定在本站公开 Wiki 页面之内。",
			"内容型问题先调用 wiki_overview 掌握全貌，再用 search_wiki_pages 传入多个同义词定位页面，并对最相关页面调用 read_wiki_page_detail。",
			"需要多跳推理时可继续读取 links/inLinks 中相关页面。答案正文必须用 [[pageKey|页面标题]] 内联引用真实页面。",
			"结尾调用 show_citations：Wiki href 写 #wiki-page=<pageKey>，来源文章 href 写 /p/<shareCode>。",
			"严禁编造或使用公开 Wiki 之外的知识；检索不到就如实回答本站 Wiki 暂无相关资料。",
			"自我介绍、寒暄等元问题直接简短回答，不调用检索工具。只使用中文，答案直接、结构清晰。",
		}, "\n")
	}
	return strings.Join([]string{
		"你是本站的公开文档问答助手，面向未登录的访客，知识范围严格限定在本站公开分享的文章之内。",
		"自我介绍、能力说明、寒暄等元问题直接简短回答，不调用检索或 UI 工具。",
		"公开文章目录问题调用 list_public_articles；关联型问题优先 search_knowledge_graph；具体内容问题用 search_public_articles 定位文章。",
		"命中文章后用 search_document_tree 定位章节，片段不足再调用 read_tree_node、read_wiki_page 或 read_source_article 核验原文。",
		"严禁编造或使用公开文章之外的知识；检索不到就如实回答本站暂无相关的公开资料。",
		"回答具体内容必须调用 show_citations，href 只能使用工具返回的 /p/<shareCode>，并在正文中用 Markdown 链接标注来源。",
		"多步任务可用 show_agent_plan/show_progress；结构化对比可用 show_data_table。只使用中文，答案直接、结构清晰。",
	}, "\n")
}

// ===== UIMessage 流式输出（帧格式对照 internal/assistantsvc/chat.go 同款协议）=====

type streamPublicQaParams struct {
	resolved       *aicore.ResolvedModel
	messages       []json.RawMessage
	systemPrompt   string
	tools          *publicQaToolSet
	quotaRemaining int64
	quotaLimit     int64
}

const genericStreamErrorText = "An error occurred."

var errQaStreamWriteFailed = fmt.Errorf("public qa stream write failed")

var (
	publicQaChatWithTools = aicore.ChatWithTools
	publicQaChatStream    = aicore.ChatStream
)

type qaSseEmitter struct {
	c   *gin.Context
	err error
}

func (s *qaSseEmitter) chunk(v any) bool {
	raw, err := json.Marshal(v)
	if err != nil {
		s.err = err
		return false
	}
	if _, werr := s.c.Writer.Write(append([]byte("data: "), append(raw, '\n', '\n')...)); werr != nil {
		s.err = werr
		return false
	}
	s.c.Writer.Flush()
	return true
}

func (s *qaSseEmitter) done() {
	if _, err := s.c.Writer.Write([]byte("data: [DONE]\n\n")); err != nil && s.err == nil {
		s.err = err
	}
	s.c.Writer.Flush()
}

func streamPublicQaAnswer(c *gin.Context, params streamPublicQaParams) {
	w := c.Writer
	header := w.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-cache")
	header.Set("Connection", "keep-alive")
	header.Set("X-Accel-Buffering", "no")
	// 显式 identity：Next 反代压缩中间件跳过 gzip，避免 SSE 被缓冲成一次性下发
	header.Set("Content-Encoding", "identity")
	header.Set("X-Vercel-Ai-Ui-Message-Stream", "v1")
	header.Set("X-Petrichor-Qa-Remaining", strconv.FormatInt(params.quotaRemaining, 10))
	header.Set("X-Petrichor-Qa-Limit", strconv.FormatInt(params.quotaLimit, 10))
	w.WriteHeader(http.StatusOK)

	emitter := &qaSseEmitter{c: c}
	ctx := c.Request.Context()

	messageID := qaNewStreamID()
	textPartID := qaNewStreamID()
	emitter.chunk(map[string]any{"type": "start", "messageId": messageID})
	msgs := make([]aicore.ChatMessage, 0, len(params.messages)+1)
	msgs = append(msgs, aicore.ChatMessage{Role: "system", Content: params.systemPrompt})
	msgs = append(msgs, qaBuildModelMessages(params.messages)...)

	rt := params.resolved.Runtime
	rt.Quirks = aicore.ResolveQuirks(rt.ProviderKey, params.resolved.ModelRef)
	options := params.resolved.Options
	temperature := 0.2
	options.Temperature = &temperature
	definitions := params.tools.definitions()
	completed := false
	var runErr error
	lastStep := 0

	for step := 0; step < 8; step++ {
		lastStep = step + 1
		if !emitter.chunk(map[string]any{"type": "start-step"}) {
			runErr = errQaStreamWriteFailed
			break
		}
		textPartID = qaNewStreamID()
		textStarted := false
		emitDelta := func(delta string) error {
			if delta == "" {
				return nil
			}
			if !textStarted {
				textStarted = true
				if !emitter.chunk(map[string]any{"type": "text-start", "id": textPartID}) {
					return errQaStreamWriteFailed
				}
			}
			if !emitter.chunk(map[string]any{"type": "text-delta", "id": textPartID, "delta": delta}) {
				return errQaStreamWriteFailed
			}
			return nil
		}

		var result *aicore.ChatResult
		if step == 7 {
			result, runErr = publicQaChatStream(ctx, rt, params.resolved.ModelRef, msgs, options, emitDelta)
		} else {
			result, runErr = publicQaChatWithTools(ctx, rt, params.resolved.ModelRef, msgs, options, definitions, emitDelta)
		}
		if runErr == nil && result != nil && !textStarted && result.Answer != "" {
			runErr = emitDelta(result.Answer)
		}
		if textStarted {
			emitter.chunk(map[string]any{"type": "text-end", "id": textPartID})
		}
		if runErr != nil {
			break
		}
		if result == nil || step == 7 || len(result.ToolCalls) == 0 {
			emitter.chunk(map[string]any{"type": "finish-step"})
			completed = true
			break
		}

		calls := append([]aicore.ToolCall{}, result.ToolCalls...)
		for index := range calls {
			if calls[index].ID == "" {
				calls[index].ID = qaNewStreamID()
			}
		}
		msgs = append(msgs, aicore.ChatMessage{Role: "assistant", Content: result.Answer, ToolCalls: calls})
		for _, call := range calls {
			if call.ID == "" {
				call.ID = qaNewStreamID()
			}
			args, parseErr := parsePublicQaToolArgs(call.ArgsJSON)
			var output any
			if parseErr != nil {
				output = map[string]any{"error": publicQaToolError(parseErr)}
			} else {
				toolOutput, toolErr := params.tools.execute(ctx, call.Name, args)
				if toolErr != nil {
					output = map[string]any{"error": publicQaToolError(toolErr)}
				} else {
					output = toolOutput
				}
			}
			if !emitter.chunk(map[string]any{"type": "tool-input-start", "toolCallId": call.ID, "toolName": call.Name}) ||
				!emitter.chunk(map[string]any{"type": "tool-input-available", "toolCallId": call.ID, "toolName": call.Name, "input": args}) ||
				!emitter.chunk(map[string]any{"type": "tool-output-available", "toolCallId": call.ID, "output": output}) {
				runErr = errQaStreamWriteFailed
				break
			}
			msgs = append(msgs, aicore.ChatMessage{Role: "tool", ToolCallID: call.ID, Content: marshalPublicQaToolOutput(output)})
		}
		emitter.chunk(map[string]any{"type": "finish-step"})
		if runErr != nil {
			break
		}
	}

	if completed && runErr == nil {
		emitter.chunk(map[string]any{"type": "finish"})
	} else {
		// 与 AI SDK 默认 onError 一致：不向客户端泄露服务端错误细节。
		emitter.chunk(map[string]any{"type": "error", "errorText": genericStreamErrorText})
	}
	emitter.done()
	if runErr != nil || emitter.err != nil {
		logErr := runErr
		if logErr == nil {
			logErr = emitter.err
		}
		fields := []any{
			"path", c.Request.URL.Path,
			"provider", params.resolved.ProviderKey,
			"model", params.resolved.ModelRef,
			"step", lastStep,
			"err", logErr,
		}
		if errors.Is(runErr, errQaStreamWriteFailed) || errors.Is(ctx.Err(), context.Canceled) || emitter.err != nil {
			slog.Warn("公开问答 SSE 输出中断", fields...)
		} else {
			slog.Error("公开问答模型执行失败", fields...)
		}
	}
}

func qaNewStreamID() string {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("go-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}
