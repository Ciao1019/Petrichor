// qa.go 前台公开问答：限流（visitor-id 主键 + IP 兜底）→ 公开文章/Wiki 检索 →
// CHAT 模型流式补全，以 assistant-ui UIMessage 流协议（SSE）输出。
// 对照 TS public-qa-handlers.ts publicQaChat 与 assistantsvc/chat.go 的同协议写出器；
// 偏差：Go 版 aicore 未实现工具调用循环，TS 的 agentic 工具编排收敛为单轮检索增强问答。
package publicapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
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

// ResolveClientIp 从常见反代头里取访客 IP（与 agent/handlers.ts 同款顺序）。
func ResolveClientIp(c *gin.Context) string {
	if v := firstHop(c.GetHeader("X-Forwarded-For")); v != "" {
		return v
	}
	if v := strings.TrimSpace(c.GetHeader("X-Real-Ip")); v != "" {
		return v
	}
	if v := strings.TrimSpace(c.GetHeader("Cf-Connecting-Ip")); v != "" {
		return v
	}
	return ""
}

func firstHop(header string) string {
	for _, part := range strings.Split(header, ",") {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			return trimmed
		}
	}
	return ""
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

	qaMaxQuestionRunes = 200  // 送入检索的问句长度上限
	qaArticleHitLimit  = 4    // 关键词检索命中的文章数
	qaCatalogLimit     = 12   // 无命中时的公开文章目录条数
	qaWikiHitLimit     = 4    // wiki 模式检索的 Wiki 页面数
	qaContextChars     = 1600 // 单篇文章送入提示词的正文长度上限
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

	question := qaLastUserText(req.Messages)
	knowledgeBlock, kerr := retrievePublicQaKnowledge(ctx, mode, question)
	if kerr != nil {
		httpx.HandleError(c, kerr)
		return
	}

	streamPublicQaAnswer(c, streamPublicQaParams{
		resolved:       resolved,
		messages:       req.Messages,
		systemPrompt:   buildPublicQaSystemPrompt(mode, knowledgeBlock),
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

// qaLastUserText 从后往前找第一条有文本的 user 消息，作为检索问句。
func qaLastUserText(messages []json.RawMessage) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if text := qaMessageText(messages[i], "user"); text != "" {
			return text
		}
	}
	return ""
}

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

// ===== 检索（单轮 RAG，替代 TS 的工具循环）=====

type qaArticleHit struct {
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

// retrievePublicQaKnowledge 组装「本站资料」提示词块：
// normal 模式检索公开文章（pg_trgm 相似度 + ILIKE），wiki 模式叠加公开 Wiki 页面；
// 全部无命中时回退公开文章目录，保证「有哪些文章」类问题可答。
func retrievePublicQaKnowledge(ctx context.Context, mode, question string) (string, error) {
	keyword := []rune(strings.TrimSpace(question))
	if len(keyword) > qaMaxQuestionRunes {
		keyword = keyword[:qaMaxQuestionRunes]
	}
	query := strings.TrimSpace(string(keyword))

	blocks := []string{}
	if query != "" {
		articles, err := searchPublicQaArticles(ctx, query, qaArticleHitLimit)
		if err != nil {
			return "", err
		}
		for _, hit := range articles {
			blocks = append(blocks, formatQaArticleBlock(hit.title, hit.shareCode, hit.excerpt, clipQaText(hit.contentMd, qaContextChars)))
		}
		if mode == qaModeWiki {
			wikiHits, werr := searchPublicQaWikiPages(ctx, query, qaWikiHitLimit)
			if werr != nil {
				return "", werr
			}
			for _, hit := range wikiHits {
				blocks = append(blocks, formatQaWikiBlock(hit.pageKey, hit.title, hit.kind, hit.summary,
					clipQaText(hit.contentMd, qaContextChars)))
			}
		}
	}
	if len(blocks) == 0 {
		catalog, err := loadPublicQaArticleCatalog(ctx, qaCatalogLimit)
		if err != nil {
			return "", err
		}
		if len(catalog) > 0 {
			lines := []string{"（关键词未直接命中正文，以下是本站公开文章目录）"}
			for _, item := range catalog {
				lines = append(lines, fmt.Sprintf("- 《%s》 href=/p/%s 摘要：%s",
					item.title, item.shareCode, clipQaText(item.excerpt, 120)))
			}
			blocks = append(blocks, strings.Join(lines, "\n"))
		}
	}
	if len(blocks) == 0 {
		return "【本站资料】\n（本站暂无公开资料）", nil
	}
	return "【本站资料】\n" + strings.Join(blocks, "\n\n"), nil
}

// searchPublicQaArticles 对照 ArticleSearch 的相似度排序，但只取无密码有效分享的文章。
func searchPublicQaArticles(ctx context.Context, query string, limit int64) ([]qaArticleHit, error) {
	likePattern := "%" + escapeLikePattern(query) + "%"
	rows, err := pool().Query(ctx,
		`SELECT a.title, s.share_code,
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
		if serr := rows.Scan(&hit.title, &hit.shareCode, &hit.excerpt, &hit.contentMd, &score); serr != nil {
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

type qaCatalogItem struct {
	title     string
	shareCode string
	excerpt   string
}

func loadPublicQaArticleCatalog(ctx context.Context, limit int64) ([]qaCatalogItem, error) {
	rows, err := pool().Query(ctx,
		`SELECT a.title, s.share_code, coalesce(a.public_excerpt, '')
		 FROM petrichor_kb_article_share s
		 JOIN petrichor_kb_article a ON a.id = s.article_id
		 WHERE `+publicShareVisibilityWhere+`
		 ORDER BY s.pin_order IS NULL, s.pin_order DESC, a.updated_at DESC
		 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []qaCatalogItem{}
	for rows.Next() {
		var item qaCatalogItem
		if serr := rows.Scan(&item.title, &item.shareCode, &item.excerpt); serr != nil {
			return nil, serr
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func clipQaText(text string, max int) string {
	flat := spaceRe.ReplaceAllString(fenceRe.ReplaceAllString(text, " "), " ")
	runes := []rune(strings.TrimSpace(flat))
	if len(runes) <= max {
		return strings.TrimSpace(flat)
	}
	return strings.TrimSpace(string(runes[:max])) + "…"
}

func formatQaArticleBlock(title, shareCode, excerpt, content string) string {
	return strings.Join([]string{
		"【公开文章】《" + title + "》",
		"href：/p/" + shareCode,
		"摘要：" + excerpt,
		"正文片段：",
		content,
	}, "\n")
}

func formatQaWikiBlock(pageKey, title, kind, summary, content string) string {
	return strings.Join([]string{
		"【Wiki 页面】[[pageKey=" + pageKey + "|《" + title + "》]] kind=" + kind,
		"摘要：" + summary,
		"正文片段：",
		content,
	}, "\n")
}

// ===== 提示词（对照 buildPublicQaSystemPrompt / buildWikiQaSystemPrompt 的无工具子集）=====

func buildPublicQaSystemPrompt(mode, knowledgeBlock string) string {
	rules := []string{
		"你是本站的公开文档问答助手，面向未登录的访客。你的知识范围严格限定在本站「公开分享的文章」之内。",
		"核心规则：",
		"1. 遇到自我介绍、能力说明、寒暄等元问题，直接用简短文字回答，不要引用资料。",
		"2. 内容型问题只依据下方【本站资料】回答；资料不足以回答时，如实说明「本站暂无相关的公开资料」，严禁编造。",
		"3. 回答涉及具体文章时必须给出依据：用 Markdown 链接标注来源，形如 [文章标题](/p/<shareCode>)；shareCode 只能来自资料块中出现的 href，严禁编造链接。",
		"4. 资料块中的正文片段可能被截断，不要对片段之外的内容做断言。",
		"5. 只使用中文回答。答案要直接、结构清晰、避免编造。",
	}
	if mode == qaModeWiki {
		rules = append(rules,
			"6. 引用 Wiki 页面时可在正文中写 [[pageKey|页面标题]] 形式的内联引用（pageKey 来自资料块的 [[pageKey=...|...]] 标记）；来源文章仍用 /p/<shareCode> 链接。")
	}
	return strings.Join(rules, "\n") + "\n\n" + knowledgeBlock
}

// ===== UIMessage 流式输出（帧格式对照 internal/assistantsvc/chat.go 同款协议）=====

type streamPublicQaParams struct {
	resolved       *aicore.ResolvedModel
	messages       []json.RawMessage
	systemPrompt   string
	quotaRemaining int64
	quotaLimit     int64
}

const genericStreamErrorText = "An error occurred."

var errQaStreamWriteFailed = fmt.Errorf("public qa stream write failed")

type qaSseEmitter struct{ c *gin.Context }

func (s *qaSseEmitter) chunk(v any) bool {
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

func (s *qaSseEmitter) done() {
	_, _ = s.c.Writer.Write([]byte("data: [DONE]\n\n"))
	s.c.Writer.Flush()
}

func streamPublicQaAnswer(c *gin.Context, params streamPublicQaParams) {
	w := c.Writer
	header := w.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-cache")
	header.Set("Connection", "keep-alive")
	header.Set("X-Accel-Buffering", "no")
	header.Set("X-Vercel-Ai-Ui-Message-Stream", "v1")
	header.Set("X-Petrichor-Qa-Remaining", strconv.FormatInt(params.quotaRemaining, 10))
	header.Set("X-Petrichor-Qa-Limit", strconv.FormatInt(params.quotaLimit, 10))
	w.WriteHeader(http.StatusOK)

	emitter := &qaSseEmitter{c: c}
	ctx := c.Request.Context()

	messageID := qaNewStreamID()
	textPartID := qaNewStreamID()
	emitter.chunk(map[string]any{"type": "start", "messageId": messageID})
	emitter.chunk(map[string]any{"type": "start-step"})
	emitter.chunk(map[string]any{"type": "text-start", "id": textPartID})

	msgs := make([]aicore.ChatMessage, 0, len(params.messages)+1)
	msgs = append(msgs, aicore.ChatMessage{Role: "system", Content: params.systemPrompt})
	msgs = append(msgs, qaBuildModelMessages(params.messages)...)

	rt := params.resolved.Runtime
	rt.Quirks = aicore.ResolveQuirks(rt.ProviderKey, params.resolved.ModelRef)

	_, err := aicore.ChatStream(ctx, rt, params.resolved.ModelRef, msgs, params.resolved.Options,
		func(delta string) error {
			if !emitter.chunk(map[string]any{"type": "text-delta", "id": textPartID, "delta": delta}) {
				return errQaStreamWriteFailed
			}
			return nil
		})

	if err == nil {
		emitter.chunk(map[string]any{"type": "text-end", "id": textPartID})
		emitter.chunk(map[string]any{"type": "finish-step"})
		emitter.chunk(map[string]any{"type": "finish"})
	} else {
		// 与 AI SDK 默认 onError 一致：不向客户端泄露服务端错误细节。
		emitter.chunk(map[string]any{"type": "error", "errorText": genericStreamErrorText})
	}
	emitter.done()
}

func qaNewStreamID() string {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("go-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}
