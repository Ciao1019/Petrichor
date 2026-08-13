package review

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/aireview"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticle"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticletag"
	"github.com/Ciao1019/Petrichor/apps/api/ent/knowledgebase"
	"github.com/Ciao1019/Petrichor/apps/api/ent/predicate"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

const (
	maxRegeneratePerDay = 3
	periodOptionCount   = 12
	maxListPageSize     = 50
	maxNarrativeChars   = 4000
	maxStatsJSONChars   = 32000
)

type Handler struct {
	client *ent.Client
	gen    *ai.Generation
}

func NewHandler(client *ent.Client, cfg *config.Config) *Handler {
	return &Handler{client: client, gen: ai.NewGeneration(cfg)}
}

type reviewTopArticle struct {
	ID                string  `json:"id"`
	Title             string  `json:"title"`
	CharCount         int     `json:"charCount"`
	IsNew             bool    `json:"isNew"`
	KnowledgeBaseID   *string `json:"knowledgeBaseId"`
	KnowledgeBaseName *string `json:"knowledgeBaseName"`
	UpdatedAt         string  `json:"updatedAt"`
}

type reviewTopTag struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}

type reviewKnowledgeBase struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	ArticleCount int    `json:"articleCount"`
}

type reviewEvolutionEntry struct {
	Period string `json:"period"`
	Title  string `json:"title"`
	Note   string `json:"note"`
}

type reviewEvolution struct {
	Topic     string                 `json:"topic"`
	Synthesis string                 `json:"synthesis"`
	Entries   []reviewEvolutionEntry `json:"entries"`
}

type reviewStats struct {
	NewArticles        int                   `json:"newArticles"`
	UpdatedArticles    int                   `json:"updatedArticles"`
	TotalChars         int                   `json:"totalChars"`
	KnowledgeBaseCount int                   `json:"knowledgeBaseCount"`
	TopTags            []reviewTopTag        `json:"topTags"`
	TopArticles        []reviewTopArticle    `json:"topArticles"`
	KnowledgeBases     []reviewKnowledgeBase `json:"knowledgeBases"`
	Evolution          *reviewEvolution      `json:"evolution,omitempty"`
}

func (h *Handler) Get(c *gin.Context) {
	var req struct {
		Period       string `json:"period"`
		PeriodKey    string `json:"periodKey"`
		ForceRebuild bool   `json:"forceRebuild"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	now := time.Now().UTC()
	period, periodKey, start, end, err := validatePeriodInput(req.Period, req.PeriodKey, now)
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	existing, err := h.loadReview(c, u.ID, period, periodKey)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if existing != nil && !req.ForceRebuild {
		view, err := reviewView(existing, true, now)
		if err != nil {
			response.Fail(c, err)
			return
		}
		response.OK(c, view)
		return
	}
	if req.ForceRebuild && existing != nil && !canRegenerateToday(existing, now) {
		response.Fail(c, response.BadRequest(fmt.Sprintf("今日重新生成次数已达上限（最多 %d 次）", maxRegeneratePerDay)))
		return
	}
	row, stats, err := h.generateAndPersist(c, u.ID, period, periodKey, start, end, existing, now)
	if err != nil {
		response.Fail(c, err)
		return
	}
	view := buildReviewView(row, stats, false, now)
	response.OK(c, view)
}

func (h *Handler) Regenerate(c *gin.Context) {
	var req struct {
		Period    string `json:"period"`
		PeriodKey string `json:"periodKey"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	now := time.Now().UTC()
	period, periodKey, start, end, err := validatePeriodInput(req.Period, req.PeriodKey, now)
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	existing, err := h.loadReview(c, u.ID, period, periodKey)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if existing != nil && !canRegenerateToday(existing, now) {
		response.Fail(c, response.BadRequest(fmt.Sprintf("今日重新生成次数已达上限（最多 %d 次）", maxRegeneratePerDay)))
		return
	}
	row, stats, err := h.generateAndPersist(c, u.ID, period, periodKey, start, end, existing, now)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, buildReviewView(row, stats, false, now))
}

func (h *Handler) List(c *gin.Context) {
	var req struct {
		Period   string `json:"period"`
		PageNum  int    `json:"pageNum"`
		PageSize int    `json:"pageSize"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	period := strings.ToUpper(strings.TrimSpace(req.Period))
	if period != "" && period != "WEEK" && period != "MONTH" {
		response.Fail(c, response.BadRequest("周期必须是 WEEK / MONTH"))
		return
	}
	if req.PageNum <= 0 {
		req.PageNum = 1
	}
	if req.PageSize <= 0 {
		req.PageSize = 20
	}
	if req.PageSize > maxListPageSize {
		req.PageSize = maxListPageSize
	}
	u := auth.MustUser(c)
	predicates := []predicate.AIReview{aireview.UserIDEQ(u.ID)}
	if period != "" {
		predicates = append(predicates, aireview.PeriodEQ(period))
	}
	total, err := h.client.AIReview.Query().Where(predicates...).Count(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	rows, err := h.client.AIReview.Query().Where(predicates...).
		Order(ent.Desc(aireview.FieldGeneratedAt), ent.Desc(aireview.FieldID)).
		Limit(req.PageSize).
		Offset((req.PageNum - 1) * req.PageSize).
		All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		out = append(out, reviewListItem(row))
	}
	response.TableData(c, out, total)
}

func (h *Handler) PeriodOptions(c *gin.Context) {
	_ = auth.MustUser(c)
	now := time.Now().UTC()
	response.OK(c, gin.H{
		"week":  buildPeriodOptions("WEEK", now),
		"month": buildPeriodOptions("MONTH", now),
	})
}

func (h *Handler) loadReview(c *gin.Context, userID int64, period, periodKey string) (*ent.AIReview, error) {
	row, err := h.client.AIReview.Query().Where(
		aireview.UserIDEQ(userID),
		aireview.PeriodEQ(period),
		aireview.PeriodKeyEQ(periodKey),
	).Only(c.Request.Context())
	if ent.IsNotFound(err) {
		return nil, nil
	}
	return row, err
}

func (h *Handler) generateAndPersist(
	c *gin.Context,
	userID int64,
	period, periodKey string,
	start, end time.Time,
	existing *ent.AIReview,
	now time.Time,
) (*ent.AIReview, reviewStats, error) {
	stats, touched, err := h.aggregateStats(c, userID, start, end)
	if err != nil {
		return nil, reviewStats{}, err
	}
	hasActivity := stats.NewArticles > 0 || stats.UpdatedArticles > 0
	narrative := ""
	var modelConfigID *int64
	if !hasActivity {
		if period == "WEEK" {
			narrative = fmt.Sprintf("本周（%s）你没有新增或更新任何文章。如果只是暂时停下脚步，没关系；想找回节奏，可以从把最近的灵感先记成一条标题开始。", periodKey)
		} else {
			narrative = fmt.Sprintf("本月（%s）你没有新增或更新任何文章。把月初的一些零散想法落成草稿，也许就是下个周期的起点。", periodKey)
		}
	} else {
		modelCfg, err := ai.ResolveChatConfig(c.Request.Context(), h.client, userID)
		if err != nil {
			return nil, reviewStats{}, err
		}
		id := modelCfg.ID
		modelConfigID = &id
		result, err := h.gen.Chat(c.Request.Context(), modelCfg, []ai.ChatMessage{
			{Role: "system", Content: buildReviewSystemPrompt()},
			{Role: "user", Content: buildReviewUserMessage(period, periodKey, start, end, stats, touched)},
		})
		if err != nil {
			return nil, reviewStats{}, err
		}
		narrative, err = normalizeReviewNarrative(result.Content)
		if err != nil {
			return nil, reviewStats{}, err
		}
	}

	if period == "MONTH" && hasActivity {
		// 认知演化是月报的增强区块，失败时不影响主体回顾。
		stats.Evolution = h.buildEvolution(c, userID, stats)
	}
	if utf8.RuneCountInString(narrative) > maxNarrativeChars {
		return nil, reviewStats{}, response.BadRequest("综述长度超出限制")
	}
	statsJSON, err := json.Marshal(stats)
	if err != nil {
		return nil, reviewStats{}, err
	}
	if utf8.RuneCount(statsJSON) > maxStatsJSONChars {
		return nil, reviewStats{}, response.BadRequest("统计数据超出存储上限")
	}

	var row *ent.AIReview
	if existing != nil {
		count, lastAt := nextRegenerateCounters(existing, now)
		updater := h.client.AIReview.UpdateOne(existing).
			SetStatsJSON(string(statsJSON)).
			SetNarrative(narrative).
			SetPeriodStart(start).
			SetPeriodEnd(end).
			SetRegenerateCount(count).
			SetLastRegeneratedAt(lastAt).
			SetGeneratedAt(now)
		if modelConfigID == nil {
			updater.ClearModelConfigID()
		} else {
			updater.SetModelConfigID(*modelConfigID)
		}
		row, err = updater.Save(c.Request.Context())
	} else {
		creator := h.client.AIReview.Create().
			SetUserID(userID).
			SetPeriod(period).
			SetPeriodKey(periodKey).
			SetPeriodStart(start).
			SetPeriodEnd(end).
			SetStatsJSON(string(statsJSON)).
			SetNarrative(narrative).
			SetRegenerateCount(0).
			SetGeneratedAt(now)
		if modelConfigID != nil {
			creator.SetModelConfigID(*modelConfigID)
		}
		row, err = creator.Save(c.Request.Context())
	}
	if err != nil {
		return nil, reviewStats{}, err
	}
	if err := h.insertNotification(c, userID, row, period, periodKey, existing != nil, hasActivity, now); err != nil {
		return nil, reviewStats{}, err
	}
	return row, stats, nil
}

func (h *Handler) aggregateStats(c *gin.Context, userID int64, start, end time.Time) (reviewStats, []*ent.KBArticle, error) {
	newCount, err := h.client.KBArticle.Query().Where(
		kbarticle.UserIDEQ(userID),
		kbarticle.CreatedAtGTE(start),
		kbarticle.CreatedAtLT(end),
	).Count(c.Request.Context())
	if err != nil {
		return reviewStats{}, nil, err
	}
	touched, err := h.client.KBArticle.Query().Where(
		kbarticle.UserIDEQ(userID),
		kbarticle.UpdatedAtGTE(start),
		kbarticle.UpdatedAtLT(end),
	).Order(ent.Asc(kbarticle.FieldUpdatedAt)).All(c.Request.Context())
	if err != nil {
		return reviewStats{}, nil, err
	}

	kbIDs := make([]int64, 0)
	kbCounts := make(map[int64]int)
	articleIDs := make([]int64, 0, len(touched))
	newIDs := make(map[int64]bool)
	totalChars := 0
	for _, article := range touched {
		articleIDs = append(articleIDs, article.ID)
		totalChars += utf8.RuneCountInString(article.ContentMd)
		if _, exists := kbCounts[article.KnowledgeBaseID]; !exists {
			kbIDs = append(kbIDs, article.KnowledgeBaseID)
		}
		kbCounts[article.KnowledgeBaseID]++
		if !article.CreatedAt.Before(start) && article.CreatedAt.Before(end) {
			newIDs[article.ID] = true
		}
	}
	kbNames := make(map[int64]string)
	if len(kbIDs) > 0 {
		rows, err := h.client.KnowledgeBase.Query().Where(
			knowledgebase.UserIDEQ(userID),
			knowledgebase.IDIn(kbIDs...),
		).All(c.Request.Context())
		if err != nil {
			return reviewStats{}, nil, err
		}
		for _, row := range rows {
			kbNames[row.ID] = row.Name
		}
	}
	knowledgeBases := make([]reviewKnowledgeBase, 0, len(kbCounts))
	for id, count := range kbCounts {
		name := kbNames[id]
		if name == "" {
			name = "未命名知识库"
		}
		knowledgeBases = append(knowledgeBases, reviewKnowledgeBase{
			ID: strconvFormatID(id), Name: name, ArticleCount: count,
		})
	}
	sort.Slice(knowledgeBases, func(i, j int) bool {
		if knowledgeBases[i].ArticleCount == knowledgeBases[j].ArticleCount {
			return knowledgeBases[i].ID < knowledgeBases[j].ID
		}
		return knowledgeBases[i].ArticleCount > knowledgeBases[j].ArticleCount
	})
	if len(knowledgeBases) > 6 {
		knowledgeBases = knowledgeBases[:6]
	}

	topSource := append([]*ent.KBArticle(nil), touched...)
	sort.SliceStable(topSource, func(i, j int) bool {
		return utf8.RuneCountInString(topSource[i].ContentMd) > utf8.RuneCountInString(topSource[j].ContentMd)
	})
	if len(topSource) > 5 {
		topSource = topSource[:5]
	}
	topArticles := make([]reviewTopArticle, 0, len(topSource))
	for _, article := range topSource {
		kbID := strconvFormatID(article.KnowledgeBaseID)
		var kbName *string
		if value, ok := kbNames[article.KnowledgeBaseID]; ok {
			kbName = &value
		}
		topArticles = append(topArticles, reviewTopArticle{
			ID: strconvFormatID(article.ID), Title: article.Title,
			CharCount: utf8.RuneCountInString(article.ContentMd), IsNew: newIDs[article.ID],
			KnowledgeBaseID: &kbID, KnowledgeBaseName: kbName,
			UpdatedAt: article.UpdatedAt.UTC().Format(time.RFC3339Nano),
		})
	}

	tagCounts := make(map[string]int)
	if len(articleIDs) > 0 {
		tags, err := h.client.KBArticleTag.Query().Where(kbarticletag.ArticleIDIn(articleIDs...)).All(c.Request.Context())
		if err != nil {
			return reviewStats{}, nil, err
		}
		for _, row := range tags {
			tagCounts[row.Tag]++
		}
	}
	topTags := make([]reviewTopTag, 0, len(tagCounts))
	for tag, count := range tagCounts {
		topTags = append(topTags, reviewTopTag{Tag: tag, Count: count})
	}
	sort.Slice(topTags, func(i, j int) bool {
		if topTags[i].Count == topTags[j].Count {
			return topTags[i].Tag < topTags[j].Tag
		}
		return topTags[i].Count > topTags[j].Count
	})
	if len(topTags) > 8 {
		topTags = topTags[:8]
	}
	updatedCount := len(touched) - newCount
	if updatedCount < 0 {
		updatedCount = 0
	}
	return reviewStats{
		NewArticles: newCount, UpdatedArticles: updatedCount, TotalChars: totalChars,
		KnowledgeBaseCount: len(knowledgeBases), TopTags: topTags,
		TopArticles: topArticles, KnowledgeBases: knowledgeBases,
	}, touched, nil
}

func buildReviewSystemPrompt() string {
	return strings.Join([]string{
		"你是一名亲切而克制的中文知识回顾助手。",
		"你的任务是基于用户在某个周期内的写作活动数据，输出一段自然的回顾。",
		"硬性规则：",
		"- 直接输出回顾正文，不要使用 Markdown 标题、列表、代码块、表情符号。",
		"- 总字数控制在 220 到 360 个汉字。",
		"- 用第二人称（你）与用户对话，语气平实而具体，避免空泛的鼓励。",
		"- 如果数据中存在主题或标签倾向，自然地指出，不要虚构任何事实。",
		"- 结尾最多给一句简短的展望或建议。",
	}, "\n")
}

func buildReviewUserMessage(period, periodKey string, start, end time.Time, stats reviewStats, touched []*ent.KBArticle) string {
	label := "本周"
	if period == "MONTH" {
		label = "本月"
	}
	lines := []string{
		fmt.Sprintf("回顾周期：%s（%s）", map[string]string{"WEEK": "周报", "MONTH": "月报"}[period], periodKey),
		fmt.Sprintf("时间范围：%s 至 %s（北京时间）", formatBeijingDate(start), formatBeijingDate(end.Add(-time.Nanosecond))),
		"", "核心统计：",
		fmt.Sprintf("- %s新增文章：%d 篇", label, stats.NewArticles),
		fmt.Sprintf("- %s修改文章：%d 篇", label, stats.UpdatedArticles),
		fmt.Sprintf("- 涉及总字数：%d 字", stats.TotalChars),
		fmt.Sprintf("- 活跃知识库数量：%d 个", stats.KnowledgeBaseCount),
	}
	if len(stats.KnowledgeBases) > 0 {
		parts := make([]string, 0, len(stats.KnowledgeBases))
		for _, kb := range stats.KnowledgeBases {
			parts = append(parts, fmt.Sprintf("%s（%d 篇）", kb.Name, kb.ArticleCount))
		}
		lines = append(lines, "- 活跃知识库分布："+strings.Join(parts, "、"))
	}
	if len(stats.TopTags) > 0 {
		parts := make([]string, 0, len(stats.TopTags))
		for _, tag := range stats.TopTags {
			parts = append(parts, fmt.Sprintf("%s×%d", tag.Tag, tag.Count))
		}
		lines = append(lines, "- 高频标签："+strings.Join(parts, "、"))
	}
	articleMap := make(map[int64]*ent.KBArticle, len(touched))
	for _, article := range touched {
		articleMap[article.ID] = article
	}
	if len(stats.TopArticles) > 0 {
		lines = append(lines, "", "代表性文章（仅供理解主题倾向，请不要逐篇罗列标题）：")
		for _, top := range stats.TopArticles {
			var article *ent.KBArticle
			for id, candidate := range articleMap {
				if strconvFormatID(id) == top.ID {
					article = candidate
					break
				}
			}
			summary := "（无摘要）"
			if article != nil && article.AiSummary != nil && strings.TrimSpace(*article.AiSummary) != "" {
				summary = truncateRunes(normalizeWhitespace(*article.AiSummary), 220)
			}
			kind := "更新"
			if top.IsNew {
				kind = "新建"
			}
			kb := ""
			if top.KnowledgeBaseName != nil {
				kb = "《" + *top.KnowledgeBaseName + "》/"
			}
			lines = append(lines, fmt.Sprintf("- [%s] %s%s（%d 字）：%s", kind, kb, top.Title, top.CharCount, summary))
		}
	}
	return strings.Join(append(lines, "", "请基于以上数据生成一段自然的回顾正文。"), "\n")
}

var reviewFencePattern = regexp.MustCompile("(?is)^```(?:markdown|md|text)?\\s*(.*?)\\s*```$")
var reviewHeadingPattern = regexp.MustCompile(`(?m)^#{1,6}\s*回顾\s*`)
var reviewPrefixPattern = regexp.MustCompile(`^(本周|本月)?回顾[:：]\s*`)

func normalizeReviewNarrative(raw string) (string, error) {
	text := strings.TrimSpace(raw)
	if match := reviewFencePattern.FindStringSubmatch(text); len(match) == 2 {
		text = strings.TrimSpace(match[1])
	}
	text = strings.TrimSpace(reviewHeadingPattern.ReplaceAllString(text, ""))
	text = strings.TrimSpace(reviewPrefixPattern.ReplaceAllString(text, ""))
	if text == "" {
		return "", fmt.Errorf("模型未返回有效综述")
	}
	if utf8.RuneCountInString(text) > 1200 {
		text = truncateRunes(text, 1200) + "..."
	}
	return text, nil
}

func (h *Handler) insertNotification(c *gin.Context, userID int64, row *ent.AIReview, period, periodKey string, regenerated, hasActivity bool, now time.Time) error {
	label := formatPeriodLabel(period, periodKey)
	title := label + "回顾已生成"
	if regenerated {
		title = label + "回顾已重新生成"
	}
	content := fmt.Sprintf("已为你生成 %s 的 AI 写作回顾，点击查看详情。", label)
	if !hasActivity {
		content = label + "写作活动较少，回顾以简短的提示形式生成。"
	}
	payload, _ := json.Marshal(gin.H{
		"reviewId": strconvFormatID(row.ID), "period": period, "periodKey": periodKey,
	})
	return h.client.Notification.Create().
		SetUserID(userID).
		SetCategory("AI_REVIEW").
		SetBizType("AI_REVIEW").
		SetBizID(row.ID).
		SetTitle(title).
		SetContent(content).
		SetPayloadJSON(string(payload)).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Exec(c.Request.Context())
}

type evolutionMaterial struct {
	Title     string
	Summary   *string
	CreatedAt time.Time
}

func (h *Handler) buildEvolution(c *gin.Context, userID int64, stats reviewStats) *reviewEvolution {
	kind, tag, kbID, topicLabel := "", "", int64(0), ""
	for _, item := range stats.TopTags {
		if item.Count >= 2 {
			kind, tag, topicLabel = "tag", item.Tag, item.Tag
			break
		}
	}
	if kind == "" {
		for _, item := range stats.KnowledgeBases {
			if item.ArticleCount >= 2 {
				if _, err := fmt.Sscan(item.ID, &kbID); err == nil && kbID > 0 {
					kind, topicLabel = "kb", item.Name
				}
				break
			}
		}
	}
	if kind == "" {
		return nil
	}
	query := h.client.KBArticle.Query().Where(kbarticle.UserIDEQ(userID))
	if kind == "kb" {
		query = query.Where(kbarticle.KnowledgeBaseIDEQ(kbID))
	} else {
		tagRows, err := h.client.KBArticleTag.Query().Where(kbarticletag.TagEQ(tag)).All(c.Request.Context())
		if err != nil || len(tagRows) == 0 {
			return nil
		}
		ids := make([]int64, 0, len(tagRows))
		for _, row := range tagRows {
			ids = append(ids, row.ArticleID)
		}
		query = query.Where(kbarticle.IDIn(ids...))
	}
	articles, err := query.Order(ent.Asc(kbarticle.FieldCreatedAt)).Limit(24).All(c.Request.Context())
	if err != nil || len(articles) < 3 {
		return nil
	}
	months := make(map[string]bool)
	materials := make([]evolutionMaterial, 0, len(articles))
	for _, article := range articles {
		month := formatBeijingMonth(article.CreatedAt)
		months[month] = true
		materials = append(materials, evolutionMaterial{Title: article.Title, Summary: article.AiSummary, CreatedAt: article.CreatedAt})
	}
	if len(months) < 2 {
		return nil
	}
	modelCfg, err := ai.ResolveChatConfig(c.Request.Context(), h.client, userID)
	if err != nil {
		return nil
	}
	result, err := h.gen.Chat(c.Request.Context(), modelCfg, []ai.ChatMessage{
		{Role: "system", Content: buildEvolutionSystemPrompt()},
		{Role: "user", Content: buildEvolutionUserMessage(topicLabel, materials)},
	})
	if err != nil {
		return nil
	}
	return parseEvolutionResult(result.Content)
}

func buildEvolutionSystemPrompt() string {
	return strings.Join([]string{
		"你是一名知识回顾助手，请根据围绕同一主题、按时间排列的笔记，归纳认知如何演化。",
		"只输出 JSON 对象，不要输出其他文字或代码块。",
		`格式：{"topic":"主题名","synthesis":"...","entries":[{"period":"YYYY-MM","title":"阶段小标题","note":"..."}]}`,
		"entries 按时间升序，3 到 8 条；相邻且观点相近的笔记合并成一个阶段。",
		"每条 note 不超过 80 字，synthesis 用 2-3 句总述，不得虚构。",
		`若看不出演化脉络，输出 {"topic":"","synthesis":"","entries":[]}。`,
	}, "\n")
}

func buildEvolutionUserMessage(topic string, materials []evolutionMaterial) string {
	lines := []string{fmt.Sprintf("主题：%s", topic), fmt.Sprintf("以下是用户围绕该主题的 %d 篇笔记，按写作时间升序：", len(materials)), ""}
	for _, item := range materials {
		summary := "（无摘要）"
		if item.Summary != nil && strings.TrimSpace(*item.Summary) != "" {
			summary = truncateRunes(normalizeWhitespace(*item.Summary), 200)
		}
		lines = append(lines, fmt.Sprintf("- [%s] %s：%s", formatBeijingMonth(item.CreatedAt), item.Title, summary))
	}
	return strings.Join(append(lines, "", "请归纳这条认知演化时间线。"), "\n")
}

func parseEvolutionResult(raw string) *reviewEvolution {
	text := strings.TrimSpace(raw)
	text = strings.TrimPrefix(text, "```json")
	text = strings.TrimPrefix(text, "```")
	text = strings.TrimSuffix(text, "```")
	if start, end := strings.Index(text, "{"), strings.LastIndex(text, "}"); start >= 0 && end > start {
		text = text[start : end+1]
	}
	var parsed reviewEvolution
	if json.Unmarshal([]byte(text), &parsed) != nil {
		return nil
	}
	parsed.Topic = strings.TrimSpace(parsed.Topic)
	parsed.Synthesis = truncateRunes(normalizeWhitespace(parsed.Synthesis), 600)
	valid := make([]reviewEvolutionEntry, 0, 8)
	periodPattern := regexp.MustCompile(`^\d{4}-\d{2}$`)
	for _, entry := range parsed.Entries {
		entry.Period = strings.TrimSpace(entry.Period)
		entry.Title = strings.TrimSpace(entry.Title)
		entry.Note = truncateRunes(normalizeWhitespace(entry.Note), 200)
		if !periodPattern.MatchString(entry.Period) || entry.Note == "" {
			continue
		}
		if entry.Title == "" {
			entry.Title = entry.Period
		}
		valid = append(valid, entry)
		if len(valid) == 8 {
			break
		}
	}
	parsed.Entries = valid
	if parsed.Topic == "" || parsed.Synthesis == "" || len(parsed.Entries) < 2 {
		return nil
	}
	return &parsed
}

func reviewView(row *ent.AIReview, fromCache bool, now time.Time) (gin.H, error) {
	var stats reviewStats
	if strings.TrimSpace(row.StatsJSON) == "" {
		return nil, response.BadRequest("缓存数据缺失")
	}
	if err := json.Unmarshal([]byte(row.StatsJSON), &stats); err != nil {
		return nil, response.BadRequest("缓存数据损坏")
	}
	return buildReviewView(row, stats, fromCache, now), nil
}

func buildReviewView(row *ent.AIReview, stats reviewStats, fromCache bool, now time.Time) gin.H {
	var modelConfigID any
	if row.ModelConfigID != nil {
		modelConfigID = strconvFormatID(*row.ModelConfigID)
	}
	return gin.H{
		"id":              strconvFormatID(row.ID),
		"period":          row.Period,
		"periodKey":       row.PeriodKey,
		"periodStart":     row.PeriodStart.UTC().Format(time.RFC3339Nano),
		"periodEnd":       row.PeriodEnd.UTC().Format(time.RFC3339Nano),
		"stats":           stats,
		"narrative":       row.Narrative,
		"generatedAt":     row.GeneratedAt.UTC().Format(time.RFC3339Nano),
		"modelConfigId":   modelConfigID,
		"regenerateCount": row.RegenerateCount,
		"canRegenerate":   canRegenerateToday(row, now),
		"hasActivity":     stats.NewArticles > 0 || stats.UpdatedArticles > 0,
		"fromCache":       fromCache,
	}
}

func reviewListItem(row *ent.AIReview) gin.H {
	var stats reviewStats
	_ = json.Unmarshal([]byte(row.StatsJSON), &stats)
	return gin.H{
		"id":          strconvFormatID(row.ID),
		"period":      row.Period,
		"periodKey":   row.PeriodKey,
		"periodStart": row.PeriodStart.UTC().Format(time.RFC3339Nano),
		"periodEnd":   row.PeriodEnd.UTC().Format(time.RFC3339Nano),
		"generatedAt": row.GeneratedAt.UTC().Format(time.RFC3339Nano),
		"statsSummary": gin.H{
			"newArticles": stats.NewArticles, "updatedArticles": stats.UpdatedArticles, "totalChars": stats.TotalChars,
		},
		"narrativeExcerpt": truncateRunes(normalizeWhitespace(row.Narrative), 120),
	}
}

func canRegenerateToday(row *ent.AIReview, now time.Time) bool {
	if row.LastRegeneratedAt == nil {
		return true
	}
	last := row.LastRegeneratedAt.UTC()
	return last.Year() != now.Year() || last.YearDay() != now.YearDay() || row.RegenerateCount < maxRegeneratePerDay
}

func nextRegenerateCounters(row *ent.AIReview, now time.Time) (int, time.Time) {
	if row.LastRegeneratedAt == nil {
		return 1, now
	}
	last := row.LastRegeneratedAt.UTC()
	if last.Year() != now.Year() || last.YearDay() != now.YearDay() {
		return 1, now
	}
	return row.RegenerateCount + 1, now
}

func validatePeriodInput(rawPeriod, rawKey string, now time.Time) (string, string, time.Time, time.Time, error) {
	period := strings.ToUpper(strings.TrimSpace(rawPeriod))
	if period != "WEEK" && period != "MONTH" {
		return "", "", time.Time{}, time.Time{}, response.BadRequest("周期必须是 WEEK / MONTH")
	}
	key := strings.TrimSpace(rawKey)
	if key == "" {
		key = defaultPeriodKey(period, now)
	}
	start, end, err := periodBounds(period, key)
	if err != nil {
		return "", "", time.Time{}, time.Time{}, response.BadRequest(err.Error())
	}
	return period, key, start, end, nil
}

func buildPeriodOptions(period string, now time.Time) []gin.H {
	keys := listRecentPeriodKeys(period, now, periodOptionCount)
	current := buildPeriodKey(period, now)
	defaultKey := defaultPeriodKey(period, now)
	out := make([]gin.H, 0, len(keys))
	for _, key := range keys {
		out = append(out, gin.H{
			"key": key, "label": formatPeriodLabel(period, key),
			"isCurrent": key == current, "isDefault": key == defaultKey,
		})
	}
	return out
}

func formatPeriodLabel(period, key string) string {
	if period == "MONTH" {
		var year, month int
		if _, err := fmt.Sscanf(key, "%d-%d", &year, &month); err == nil {
			return fmt.Sprintf("%d 年 %d 月", year, month)
		}
		return key
	}
	var year, week int
	if _, err := fmt.Sscanf(key, "%d-W%d", &year, &week); err == nil {
		return fmt.Sprintf("%d 年第 %d 周", year, week)
	}
	return key
}

func defaultPeriodKey(period string, now time.Time) string {
	if period == "MONTH" {
		shifted := now.UTC().Add(8 * time.Hour)
		year, month, _ := shifted.Date()
		month--
		if month == 0 {
			year--
			month = 12
		}
		return fmt.Sprintf("%04d-%02d", year, int(month))
	}
	return buildPeriodKey("WEEK", now.AddDate(0, 0, -7))
}

func listRecentPeriodKeys(period string, now time.Time, count int) []string {
	if count <= 0 {
		return []string{}
	}
	keys := make([]string, 0, count)
	if period == "MONTH" {
		shifted := now.UTC().Add(8 * time.Hour)
		year, month, _ := shifted.Date()
		for len(keys) < count {
			keys = append(keys, fmt.Sprintf("%04d-%02d", year, int(month)))
			month--
			if month == 0 {
				year--
				month = 12
			}
		}
		return keys
	}
	cursor := now
	seen := make(map[string]bool)
	for len(keys) < count {
		key := buildPeriodKey("WEEK", cursor)
		if !seen[key] {
			seen[key] = true
			keys = append(keys, key)
		}
		cursor = cursor.AddDate(0, 0, -7)
	}
	return keys
}

func buildPeriodKey(period string, date time.Time) string {
	shifted := date.UTC().Add(8 * time.Hour)
	year, month, day := shifted.Date()
	if period == "MONTH" {
		return fmt.Sprintf("%04d-%02d", year, int(month))
	}
	isoYear, isoWeek := time.Date(year, month, day, 0, 0, 0, 0, time.UTC).ISOWeek()
	return fmt.Sprintf("%04d-W%02d", isoYear, isoWeek)
}

var monthKeyPattern = regexp.MustCompile(`^(\d{4})-(\d{2})$`)
var weekKeyPattern = regexp.MustCompile(`^(\d{4})-W(\d{2})$`)

func periodBounds(period, key string) (time.Time, time.Time, error) {
	const beijingOffset = 8 * time.Hour
	if period == "MONTH" {
		match := monthKeyPattern.FindStringSubmatch(key)
		if len(match) != 3 {
			return time.Time{}, time.Time{}, fmt.Errorf("月份键格式应为 YYYY-MM")
		}
		var year, month int
		_, _ = fmt.Sscan(match[1], &year)
		_, _ = fmt.Sscan(match[2], &month)
		if month < 1 || month > 12 {
			return time.Time{}, time.Time{}, fmt.Errorf("周期键无效")
		}
		startLocal := time.Date(year, time.Month(month), 1, 0, 0, 0, 0, time.UTC)
		endLocal := startLocal.AddDate(0, 1, 0)
		return startLocal.Add(-beijingOffset), endLocal.Add(-beijingOffset), nil
	}
	match := weekKeyPattern.FindStringSubmatch(key)
	if len(match) != 3 {
		return time.Time{}, time.Time{}, fmt.Errorf("周次键格式应为 YYYY-WNN")
	}
	var year, week int
	_, _ = fmt.Sscan(match[1], &year)
	_, _ = fmt.Sscan(match[2], &week)
	if week < 1 || week > 53 {
		return time.Time{}, time.Time{}, fmt.Errorf("周期键无效")
	}
	jan4 := time.Date(year, 1, 4, 0, 0, 0, 0, time.UTC)
	weekday := int(jan4.Weekday())
	if weekday == 0 {
		weekday = 7
	}
	week1Monday := jan4.AddDate(0, 0, -(weekday - 1))
	start := week1Monday.AddDate(0, 0, (week-1)*7).Add(-beijingOffset)
	return start, start.AddDate(0, 0, 7), nil
}

func formatBeijingDate(value time.Time) string {
	return value.UTC().Add(8 * time.Hour).Format("2006-01-02")
}

func formatBeijingMonth(value time.Time) string {
	return value.UTC().Add(8 * time.Hour).Format("2006-01")
}

func normalizeWhitespace(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func truncateRunes(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return strings.TrimSpace(string(runes[:max])) + "…"
}

func strconvFormatID(id int64) string {
	return fmt.Sprintf("%d", id)
}
