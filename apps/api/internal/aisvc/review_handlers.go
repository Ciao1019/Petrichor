package aisvc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/aicore"
	"petrichor/api/internal/auth"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

// ===== 视图序列化 =====

func nullableIDPtrStr(v *int64) any {
	if v == nil {
		return nil
	}
	return idStr(*v)
}

func buildReviewView(rec *reviewRecord, period, periodKey string, stats any, narrative string, fromCache bool, now time.Time) gin.H {
	bounds, _ := computePeriodBounds(period, periodKey)
	hasActivity := false
	if s, ok := stats.(*reviewStats); ok {
		hasActivity = s.hasActivity()
	} else if m, ok := stats.(map[string]any); ok {
		na := numberOrZero(m["newArticles"])
		ua := numberOrZero(m["updatedArticles"])
		hasActivity = na > 0 || ua > 0
	}
	var generatedAt any
	var regenerateCount int64
	canRegen := true
	var modelConfigID any
	if rec != nil {
		generatedAt = httpx.FormatISO(rec.GeneratedAt)
		regenerateCount = int64(rec.RegenerateCount)
		canRegen = canRegenerateToday(rec, now)
		modelConfigID = nullableIDPtrStr(rec.ModelConfigID)
	}
	return gin.H{
		"id":              nullableRecordID(rec),
		"period":          period,
		"periodKey":       periodKey,
		"periodStart":     httpx.FormatISO(bounds.start),
		"periodEnd":       httpx.FormatISO(bounds.end),
		"stats":           statsAny(stats),
		"narrative":       narrative,
		"generatedAt":     generatedAt,
		"modelConfigId":   modelConfigID,
		"regenerateCount": regenerateCount,
		"canRegenerate":   canRegen,
		"hasActivity":     hasActivity,
		"fromCache":       fromCache,
	}
}

func nullableRecordID(rec *reviewRecord) any {
	if rec == nil {
		return nil
	}
	return idStr(rec.ID)
}

// statsAny 缓存路径回传原始解析对象，生成路径回传结构体本身。
func statsAny(stats any) any {
	if s, ok := stats.(*reviewStats); ok {
		return s
	}
	if m, ok := stats.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func numberOrZero(v any) float64 {
	n, ok := jsNumber(v)
	if !ok {
		return 0
	}
	return n
}

func parseStatsJSONSafe(value *string) map[string]any {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(*value), &parsed); err != nil || parsed == nil {
		return nil
	}
	return parsed
}

// parseCachedStatsOrThrow 复刻 parseStatsJsonOrThrow：区分缺失与损坏两种缓存异常。
func parseCachedStatsOrThrow(value string) (map[string]any, error) {
	if strings.TrimSpace(value) == "" {
		return nil, badRequestMsg("缓存数据缺失")
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(value), &parsed); err != nil || parsed == nil {
		return nil, badRequestMsg("缓存数据损坏")
	}
	return parsed, nil
}

func buildNarrativeExcerpt(value string, max int) string {
	normalized := strings.TrimSpace(regexp.MustCompile(`\s+`).ReplaceAllString(value, " "))
	runes := []rune(normalized)
	if len(runes) <= max {
		return normalized
	}
	return trimEnd(string(runes[:max])) + "…"
}

// trimEnd 复刻 JS String.prototype.trimEnd()。
func trimEnd(s string) string {
	return strings.TrimRightFunc(s, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f' || r == 0x85 || r == 0xA0
	})
}

func buildPeriodOptionList(period string, now time.Time) []gin.H {
	currentKey := buildPeriodKey(period, now)
	defaultKey := resolveDefaultPeriodKey(period, now)
	keys := listRecentPeriodKeys(period, now, periodOptionCount)
	items := make([]gin.H, 0, len(keys))
	for _, key := range keys {
		items = append(items, gin.H{
			"key":       key,
			"label":     formatPeriodLabel(period, key),
			"isCurrent": key == currentKey,
			"isDefault": key == defaultKey,
		})
	}
	return items
}

func formatPeriodLabel(period, key string) string {
	if period == "MONTH" {
		parts := strings.Split(key, "-")
		if len(parts) != 2 {
			return key
		}
		return fmt.Sprintf("%s 年 %d 月", parts[0], atoi(parts[1]))
	}
	m := regexp.MustCompile(`^(\d{4})-W(\d{2})$`).FindStringSubmatch(key)
	if m == nil {
		return key
	}
	return fmt.Sprintf("%s 年第 %d 周", m[1], atoi(m[2]))
}

// ===== 接口 =====

// GetReview POST /api/ai/review/get：优先命中缓存，forceRebuild 时受每日限频约束重建。
func GetReview(c *gin.Context) {
	user := auth.CurrentUser(c)
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	ctx := c.Request.Context()
	now := time.Now()

	input, err := validateReviewGetInput(body, now)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	existing, err := loadReviewRecord(ctx, user.ID, input.period, input.periodKey)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	if existing != nil && !input.forceRebuild {
		cached, err := parseCachedStatsOrThrow(existing.StatsJSON)
		if err != nil {
			httpx.HandleError(c, err)
			return
		}
		httpx.OK(c, buildReviewView(existing, input.period, input.periodKey, cached, existing.Narrative, true, now))
		return
	}
	if input.forceRebuild && existing != nil && !canRegenerateToday(existing, now) {
		httpx.HandleError(c, badRequestMsg("今日重新生成次数已达上限（最多 %d 次）", maxRegeneratePerDay))
		return
	}

	view, err := generateAndPersistReview(ctx, user.ID, input.period, input.periodKey, existing, now)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, view)
}

// RegenerateReview POST /api/ai/review/regenerate：强制重建（同样受限频）。
func RegenerateReview(c *gin.Context) {
	user := auth.CurrentUser(c)
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	ctx := c.Request.Context()
	now := time.Now()

	input, err := validateReviewRegenerateInput(body, now)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	existing, err := loadReviewRecord(ctx, user.ID, input.period, input.periodKey)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	if existing != nil && !canRegenerateToday(existing, now) {
		httpx.HandleError(c, badRequestMsg("今日重新生成次数已达上限（最多 %d 次）", maxRegeneratePerDay))
		return
	}

	view, err := generateAndPersistReview(ctx, user.ID, input.period, input.periodKey, existing, now)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, view)
}

// ListReviews POST /api/ai/review/list。
func ListReviews(c *gin.Context) {
	user := auth.CurrentUser(c)
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	input, err := validateReviewListInput(body)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	ctx := c.Request.Context()

	where := ` WHERE user_id = $1`
	args := []any{user.ID}
	if input.period != nil {
		args = append(args, *input.period)
		where += fmt.Sprintf(" AND period = $%d", len(args))
	}

	var total int64
	if err := db.Pool().QueryRow(ctx,
		`SELECT count(*) FROM petrichor_ai_review`+where, args...).Scan(&total); err != nil {
		httpx.HandleError(c, err)
		return
	}

	args = append(args, input.pageSize, (input.pageNum-1)*input.pageSize)
	limitIdx := len(args) - 1
	offsetIdx := len(args)
	rows, err := db.Pool().Query(ctx,
		`SELECT `+reviewCols+` FROM petrichor_ai_review`+where+
			fmt.Sprintf(` ORDER BY generated_at DESC, id DESC LIMIT $%d OFFSET $%d`, limitIdx, offsetIdx),
		args...)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	defer rows.Close()

	items := []gin.H{}
	for rows.Next() {
		var rec reviewRecord
		if err := rows.Scan(rec.scanInto()...); err != nil {
			httpx.HandleError(c, err)
			return
		}
		items = append(items, buildReviewListItem(&rec))
	}
	if rows.Err() != nil {
		httpx.HandleError(c, rows.Err())
		return
	}
	httpx.TableData(c, items, total)
}

// GetReviewPeriodOptions POST /api/ai/review/period-options。
func GetReviewPeriodOptions(c *gin.Context) {
	now := time.Now()
	httpx.OK(c, gin.H{
		"week":  buildPeriodOptionList("WEEK", now),
		"month": buildPeriodOptionList("MONTH", now),
	})
}

func buildReviewListItem(rec *reviewRecord) gin.H {
	cached := parseStatsJSONSafe(&rec.StatsJSON)
	newArticles, updatedArticles, totalChars := 0.0, 0.0, 0.0
	if cached != nil {
		newArticles = numberOrZero(cached["newArticles"])
		updatedArticles = numberOrZero(cached["updatedArticles"])
		totalChars = numberOrZero(cached["totalChars"])
	}
	return gin.H{
		"id":          idStr(rec.ID),
		"period":      rec.Period,
		"periodKey":   rec.PeriodKey,
		"periodStart": httpx.FormatISO(rec.PeriodStart),
		"periodEnd":   httpx.FormatISO(rec.PeriodEnd),
		"generatedAt": httpx.FormatISO(rec.GeneratedAt),
		"statsSummary": gin.H{
			"newArticles":     newArticles,
			"updatedArticles": updatedArticles,
			"totalChars":      totalChars,
		},
		"narrativeExcerpt": buildNarrativeExcerpt(rec.Narrative, 120),
	}
}

// ===== 生成与落库（handlers.generateAndPersist 移植）=====

func generateAndPersistReview(ctx context.Context, userID int64, period, periodKey string, existing *reviewRecord, now time.Time) (gin.H, error) {
	bounds, err := computePeriodBounds(period, periodKey)
	if err != nil {
		return nil, badRequestMsg("周期键无效")
	}
	stats, err := aggregateReviewStats(ctx, userID, bounds)
	if err != nil {
		return nil, err
	}

	isRegenerate := existing != nil
	regenerateCount, lastRegeneratedAt := nextRegenerateCounters(existing, now)

	var narrative string
	var modelConfigID *int64

	hasActivity := stats.hasActivity()
	if !hasActivity {
		if period == "WEEK" {
			narrative = fmt.Sprintf("本周（%s）你没有新增或更新任何文章。如果只是暂时停下脚步，没关系；想找回节奏，可以从把最近的灵感先记成一条标题开始。", periodKey)
		} else {
			narrative = fmt.Sprintf("本月（%s）你没有新增或更新任何文章。把月初的一些零散想法落成草稿，也许就是下个周期的起点。", periodKey)
		}
	} else {
		snippets, err := collectArticleSnippets(ctx, userID, stats)
		if err != nil {
			return nil, err
		}
		resolved, err := aicore.ResolveModelForPurpose(ctx, userID, aicore.PurposeChat, nil)
		if err != nil {
			return nil, err
		}
		userMessage := buildReviewUserMessage(reviewUserMessageInput{
			period:             period,
			periodKey:          periodKey,
			periodStartDisplay: formatBeijingDate(bounds.start),
			periodEndDisplay:   formatBeijingDate(bounds.end.Add(-time.Millisecond)),
			stats:              stats,
			snippets:           snippets,
		})
		result, err := aicore.Chat(ctx, resolved.Runtime, resolved.ModelRef, []aicore.ChatMessage{
			{Role: "system", Content: buildReviewSystemPrompt()},
			{Role: "user", Content: userMessage},
		}, resolved.Options)
		if err != nil {
			return nil, err
		}
		narrative, err = normalizeReviewNarrative(result.Answer)
		if err != nil {
			return nil, err
		}
		id := resolved.ModelID
		modelConfigID = &id
	}

	// 月报专属：认知演化时间线。任何环节失败都静默降级为 null（键仍输出），不影响月报主体。
	if period == "MONTH" && hasActivity {
		stats.includeEvolution = true
		if evolution, err := buildEvolutionForReview(ctx, userID, stats); err == nil {
			stats.Evolution = evolution
		}
	}

	if runeLen(narrative) > narrativeMaxChars {
		return nil, badRequestMsg("综述长度超出限制")
	}
	statsJSON := jsonStringifyStrict(stats)
	if statsJSON == "" || runeLen(statsJSON) > statsJSONMaxChars {
		return nil, badRequestMsg("统计数据超出存储上限")
	}

	pool := db.Pool()
	var saved reviewRecord
	if existing != nil {
		err = pool.QueryRow(ctx, `
			UPDATE petrichor_ai_review SET stats_json = $1, narrative = $2, model_config_id = $3,
			       regenerate_count = $4, last_regenerated_at = $5, generated_at = $6, updated_at = $7,
			       period_start = $8, period_end = $9
			 WHERE id = $10 RETURNING `+reviewCols,
			statsJSON, narrative, modelConfigID, regenerateCount, lastRegeneratedAt, now, now,
			bounds.start, bounds.end, existing.ID).Scan(saved.scanInto()...)
	} else {
		err = pool.QueryRow(ctx, `
			INSERT INTO petrichor_ai_review (user_id, period, period_key, period_start, period_end,
			       stats_json, narrative, model_config_id, regenerate_count, generated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9) RETURNING `+reviewCols,
			userID, period, periodKey, bounds.start, bounds.end,
			statsJSON, narrative, modelConfigID, now).Scan(saved.scanInto()...)
	}
	if err != nil {
		return nil, err
	}

	if err := insertReviewNotification(ctx, userID, &saved, period, periodKey, isRegenerate, hasActivity, now); err != nil {
		return nil, err
	}

	return buildReviewView(&saved, period, periodKey, stats, narrative, false, now), nil
}

// ===== 通知 =====

func insertReviewNotification(ctx context.Context, userID int64, review *reviewRecord,
	period, periodKey string, isRegenerate, hasActivity bool, now time.Time) error {
	label := formatPeriodLabel(period, periodKey)
	title := fmt.Sprintf("%s回顾已生成", label)
	if isRegenerate {
		title = fmt.Sprintf("%s回顾已重新生成", label)
	}
	content := fmt.Sprintf("已为你生成 %s 的 AI 写作回顾，点击查看详情。", label)
	if !hasActivity {
		content = fmt.Sprintf("%s写作活动较少，回顾以简短的提示形式生成。", label)
	}
	payload := jsonStringifyStrict(gin.H{
		"reviewId":  idStr(review.ID),
		"period":    period,
		"periodKey": periodKey,
	})
	_, err := db.Pool().Exec(ctx, `
		INSERT INTO petrichor_notification (user_id, category, biz_type, biz_id, title, content, payload_json, created_at, updated_at)
		VALUES ($1, 'AI_REVIEW', 'AI_REVIEW', $2, $3, $4, $5, $6, $7)`,
		userID, review.ID, title, content, payload, now, now)
	return err
}

// ===== Prompt（prompt.ts 移植）=====

type articleSnippet struct {
	title             string
	summary           *string
	knowledgeBaseName *string
	isNew             bool
	charCount         int64
}

const (
	narrativeMaxInputSnippets = 8
	narrativeSnippetMaxChars  = 220
)

func buildReviewSystemPrompt() string {
	return strings.Join([]string{
		"你是一名亲切而克制的中文知识回顾助手。",
		"你的任务是基于用户在某个周期内的写作活动数据，输出一段自然的回顾。",
		"硬性规则：",
		"- 直接输出回顾正文，不要使用 Markdown 标题、列表、代码块、表情符号。",
		"- 总字数控制在 220 到 360 个汉字。",
		"- 用第二人称（你）与用户对话，语气平实而具体，避免空泛的鼓励。",
		"- 如果数据中存在主题/标签倾向，自然地指出，避免堆砌名词。",
		"- 不要虚构未在数据中出现的标题、标签或事实。",
		"- 如果数据显示该周期几乎没有写作活动，要诚实承认，并给一句轻量的提醒，而不是夸大其辞。",
		"- 结尾可以用一句简短的展望或建议（不超过一句），但不要套话。",
	}, "\n")
}

type reviewUserMessageInput struct {
	period             string
	periodKey          string
	periodStartDisplay string
	periodEndDisplay   string
	stats              *reviewStats
	snippets           []articleSnippet
}

func buildReviewUserMessage(input reviewUserMessageInput) string {
	periodLabel := "本月"
	if input.period == "WEEK" {
		periodLabel = "本周"
	}
	reportKind := "月报"
	if input.period == "WEEK" {
		reportKind = "周报"
	}
	lines := []string{
		fmt.Sprintf("回顾周期：%s（%s）", reportKind, input.periodKey),
		fmt.Sprintf("时间范围：%s 至 %s（北京时间）", input.periodStartDisplay, input.periodEndDisplay),
		"",
		"核心统计：",
		fmt.Sprintf("- %s新增文章：%d 篇", periodLabel, input.stats.NewArticles),
		fmt.Sprintf("- %s修改文章：%d 篇", periodLabel, input.stats.UpdatedArticles),
		fmt.Sprintf("- 涉及总字数：%d 字", input.stats.TotalChars),
		fmt.Sprintf("- 活跃知识库数量：%d 个", input.stats.KnowledgeBaseCount),
	}
	if len(input.stats.KnowledgeBases) > 0 {
		descs := make([]string, 0, len(input.stats.KnowledgeBases))
		for _, kb := range input.stats.KnowledgeBases {
			descs = append(descs, fmt.Sprintf("%s（%d 篇）", kb.Name, kb.ArticleCount))
		}
		lines = append(lines, fmt.Sprintf("- 活跃知识库分布：%s", strings.Join(descs, "、")))
	}
	if len(input.stats.TopTags) > 0 {
		descs := make([]string, 0, len(input.stats.TopTags))
		for _, tag := range input.stats.TopTags {
			descs = append(descs, fmt.Sprintf("%s×%d", tag.Tag, tag.Count))
		}
		lines = append(lines, fmt.Sprintf("- 高频标签：%s", strings.Join(descs, "、")))
	}

	snippets := input.snippets
	if len(snippets) > narrativeMaxInputSnippets {
		snippets = snippets[:narrativeMaxInputSnippets]
	}
	if len(snippets) > 0 {
		lines = append(lines, "", "代表性文章（仅供你理解主题倾向，请不要逐篇罗列标题）：")
		for _, snippet := range snippets {
			tag := "更新"
			if snippet.isNew {
				tag = "新建"
			}
			kb := ""
			if snippet.knowledgeBaseName != nil {
				kb = fmt.Sprintf("《%s》/", *snippet.knowledgeBaseName)
			}
			summary := "（无摘要）"
			if snippet.summary != nil {
				summary = truncatePromptText(*snippet.summary, narrativeSnippetMaxChars)
			}
			lines = append(lines, fmt.Sprintf("- [%s] %s%s（%d 字）：%s", tag, kb, snippet.title, snippet.charCount, summary))
		}
	}
	lines = append(lines, "", "请基于以上数据生成一段自然的回顾正文。")
	return strings.Join(lines, "\n")
}

var (
	fenceOpenPattern     = regexp.MustCompile("(?i)^```(?:markdown|md|text)?\\s*")
	fenceClosePattern    = regexp.MustCompile("(?i)\\s*```$")
	reviewHeadingPattern = regexp.MustCompile(`^#{1,6}\s*回顾\s*`)
	reviewPrefixPattern  = regexp.MustCompile(`^(本周|本月)?回顾[:：]\s*`)
)

// normalizeReviewNarrative 复刻 normalizeReviewNarrative。
func normalizeReviewNarrative(raw string) (string, error) {
	stripped := reviewPrefixPattern.ReplaceAllString(
		reviewHeadingPattern.ReplaceAllString(
			fenceClosePattern.ReplaceAllString(
				fenceOpenPattern.ReplaceAllString(strings.TrimSpace(raw), ""), ""), ""), "")
	stripped = strings.TrimSpace(stripped)
	if stripped == "" {
		return "", errors.New("模型未返回有效综述")
	}
	runes := []rune(stripped)
	if len(runes) > 1200 {
		return trimEnd(string(runes[:1200])) + "...", nil
	}
	return stripped, nil
}

// truncatePromptText 复刻 prompt.ts 的 truncate：压缩空白后按 rune 截断加省略号。
func truncatePromptText(value string, max int) string {
	normalized := strings.TrimSpace(regexp.MustCompile(`\s+`).ReplaceAllString(value, " "))
	runes := []rune(normalized)
	if len(runes) <= max {
		return normalized
	}
	return trimEnd(string(runes[:max])) + "…"
}

// collectArticleSnippets 取 Top 文章的标题与 AI 摘要（不灌全文以控制 token）。
func collectArticleSnippets(ctx context.Context, userID int64, stats *reviewStats) ([]articleSnippet, error) {
	topIDs := make([]int64, 0, len(stats.TopArticles))
	for _, article := range stats.TopArticles {
		topIDs = append(topIDs, int64(atoi(article.ID)))
	}
	if len(topIDs) == 0 {
		return []articleSnippet{}, nil
	}
	rows, err := db.Pool().Query(ctx, `
		SELECT id, title, ai_summary FROM petrichor_kb_article
		WHERE user_id = $1 AND id = ANY($2)`, userID, topIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	summaryMap := map[int64]*string{}
	for rows.Next() {
		var id int64
		var title string
		var summary *string
		if err := rows.Scan(&id, &title, &summary); err != nil {
			return nil, err
		}
		summaryMap[id] = summary
	}
	if rows.Err() != nil {
		return nil, rows.Err()
	}

	out := make([]articleSnippet, 0, len(stats.TopArticles))
	for _, article := range stats.TopArticles {
		id := int64(atoi(article.ID))
		summary, ok := summaryMap[id]
		if !ok {
			summary = nil
		}
		out = append(out, articleSnippet{
			title:             article.Title,
			summary:           summary,
			knowledgeBaseName: article.KnowledgeBaseName,
			isNew:             article.IsNew,
			charCount:         article.CharCount,
		})
	}
	return out, nil
}
