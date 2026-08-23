// review.go 对照 review/{handlers,logic,period,stats,prompt,evolution}.ts：
// AI 写作回顾（周报/月报）。聚合周期内写作活动 → CHAT 模型生成 markdown 综述
// → 落 petrichor_ai_review 缓存 + 站内通知。周/月边界基于 Asia/Shanghai 口径。
package aisvc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/aicore"
	"petrichor/api/internal/auth"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

// ===== 周期计算（period.ts 移植）：UTC+8 口径，返回 UTC 时间戳 =====

const (
	reviewBeijingOffsetMin = 480
	reviewMsPerDay         = int64(86_400_000)
)

var reviewPeriods = []string{"WEEK", "MONTH"}

const (
	maxRegeneratePerDay   = 3
	periodOptionCount     = 12
	periodOptionsMaxPages = 50
)

func isReviewPeriod(v string) bool {
	return v == "WEEK" || v == "MONTH"
}

// toBeijingParts 把 UTC 时间平移成北京本地时间分量。
func toBeijingParts(t time.Time) (year, month, day, weekday int) {
	shifted := t.UTC().Add(time.Duration(reviewBeijingOffsetMin) * time.Minute)
	weekday = int(shifted.Weekday())
	if weekday == 0 {
		weekday = 7
	}
	return shifted.Year(), int(shifted.Month()), shifted.Day(), weekday
}

// fromBeijingDate 给定北京本地 Y/M/D 00:00，返回对应 UTC 时间。
func fromBeijingDate(year, month, day int) time.Time {
	return time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC).
		Add(-time.Duration(reviewBeijingOffsetMin) * time.Minute)
}

func formatBeijingMonth(t time.Time) string {
	year, month, _, _ := toBeijingParts(t)
	return fmt.Sprintf("%04d-%02d", year, month)
}

func formatBeijingDate(t time.Time) string {
	year, month, day, _ := toBeijingParts(t)
	return fmt.Sprintf("%04d-%02d-%02d", year, month, day)
}

// computeIsoWeek ISO 周：周一为起点，第 1 周为包含 1 月 4 日的那一周。
func computeIsoWeek(year, month, day int) (isoYear, isoWeek int) {
	utcDate := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	weekday := int(utcDate.Weekday())
	if weekday == 0 {
		weekday = 7
	}
	thursday := utcDate.AddDate(0, 0, 4-weekday)
	isoYear = thursday.Year()
	jan4 := time.Date(isoYear, 1, 4, 0, 0, 0, 0, time.UTC)
	jan4Weekday := int(jan4.Weekday())
	if jan4Weekday == 0 {
		jan4Weekday = 7
	}
	firstThursday := jan4.AddDate(0, 0, 4-jan4Weekday)
	isoWeek = int(math.Round(thursday.Sub(firstThursday).Hours()/(24*7))) + 1
	return isoYear, isoWeek
}

func buildPeriodKey(period string, t time.Time) string {
	year, month, day, _ := toBeijingParts(t)
	if period == "MONTH" {
		return fmt.Sprintf("%04d-%02d", year, month)
	}
	isoYear, isoWeek := computeIsoWeek(year, month, day)
	return fmt.Sprintf("%04d-W%02d", isoYear, isoWeek)
}

type periodBounds struct {
	start time.Time
	end   time.Time
}

// computePeriodBounds 周/月 key → [start, end) 区间；key 非法时返回错误。
func computePeriodBounds(period, key string) (periodBounds, error) {
	if period == "MONTH" {
		m := regexp.MustCompile(`^(\d{4})-(\d{2})$`).FindStringSubmatch(key)
		if m == nil {
			return periodBounds{}, fmt.Errorf("无效的月份键：%s", key)
		}
		year, month := atoi(m[1]), atoi(m[2])
		if month < 1 || month > 12 {
			return periodBounds{}, fmt.Errorf("无效的月份键：%s", key)
		}
		start := fromBeijingDate(year, month, 1)
		ny, nm := year, month+1
		if month == 12 {
			ny, nm = year+1, 1
		}
		return periodBounds{start: start, end: fromBeijingDate(ny, nm, 1)}, nil
	}

	m := regexp.MustCompile(`^(\d{4})-W(\d{2})$`).FindStringSubmatch(key)
	if m == nil {
		return periodBounds{}, fmt.Errorf("无效的周次键：%s", key)
	}
	isoYear, isoWeek := atoi(m[1]), atoi(m[2])
	if isoWeek < 1 || isoWeek > 53 {
		return periodBounds{}, fmt.Errorf("无效的周次键：%s", key)
	}
	jan4 := time.Date(isoYear, 1, 4, 0, 0, 0, 0, time.UTC)
	jan4Weekday := int(jan4.Weekday())
	if jan4Weekday == 0 {
		jan4Weekday = 7
	}
	week1MondayMs := jan4.UnixMilli() - int64(jan4Weekday-1)*reviewMsPerDay
	mondayMs := week1MondayMs + int64(isoWeek-1)*7*reviewMsPerDay
	start := time.UnixMilli(mondayMs - int64(reviewBeijingOffsetMin)*60_000)
	return periodBounds{start: start, end: start.Add(7 * time.Duration(reviewMsPerDay) * time.Millisecond)}, nil
}

// resolveDefaultPeriodKey 默认显示「上一个完整周期」，避免本周/本月只过 1 天就出空报告。
func resolveDefaultPeriodKey(period string, now time.Time) string {
	if period == "MONTH" {
		year, month, _, _ := toBeijingParts(now)
		if month == 1 {
			year, month = year-1, 12
		} else {
			month--
		}
		return fmt.Sprintf("%04d-%02d", year, month)
	}
	return buildPeriodKey("WEEK", now.Add(-7*24*time.Hour))
}

// listRecentPeriodKeys 最近 N 个期次的 key（含当前），按时间倒序。
func listRecentPeriodKeys(period string, now time.Time, count int) []string {
	if count <= 0 {
		return []string{}
	}
	keys := []string{}
	if period == "MONTH" {
		year, month, _, _ := toBeijingParts(now)
		for i := 0; i < count; i++ {
			keys = append(keys, fmt.Sprintf("%04d-%02d", year, month))
			if month == 1 {
				year--
				month = 12
			} else {
				month--
			}
		}
		return keys
	}
	cursor := now
	seen := map[string]bool{}
	for len(keys) < count {
		key := buildPeriodKey("WEEK", cursor)
		if !seen[key] {
			keys = append(keys, key)
			seen[key] = true
		}
		cursor = cursor.Add(-7 * 24 * time.Hour)
	}
	return keys
}

func atoi(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0
		}
		n = n*10 + int(r-'0')
	}
	return n
}

// ===== 统计结构（stats.ts 移植）=====

type topArticle struct {
	ID                string  `json:"id"`
	Title             string  `json:"title"`
	CharCount         int64   `json:"charCount"`
	IsNew             bool    `json:"isNew"`
	KnowledgeBaseID   string  `json:"knowledgeBaseId"`
	KnowledgeBaseName *string `json:"knowledgeBaseName"`
	UpdatedAt         string  `json:"updatedAt"`
}

type topTag struct {
	Tag   string `json:"tag"`
	Count int64  `json:"count"`
}

type kbActivity struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	ArticleCount int64  `json:"articleCount"`
}

type evolutionEntry struct {
	Period string `json:"period"`
	Title  string `json:"title"`
	Note   string `json:"note"`
}

type reviewEvolution struct {
	Topic     string           `json:"topic"`
	Synthesis string           `json:"synthesis"`
	Entries   []evolutionEntry `json:"entries"`
}

type reviewStats struct {
	NewArticles        int64            `json:"newArticles"`
	UpdatedArticles    int64            `json:"updatedArticles"`
	TotalChars         int64            `json:"totalChars"`
	KnowledgeBaseCount int64            `json:"knowledgeBaseCount"`
	TopTags            []topTag         `json:"topTags"`
	TopArticles        []topArticle     `json:"topArticles"`
	KnowledgeBases     []kbActivity     `json:"knowledgeBases"`
	Evolution          *reviewEvolution `json:"-"`
	// includeEvolution 对应 TS 的 undefined / null 区分：
	// 月报参与演化板块时输出 "evolution" 键（失败为 null），周报完全不输出。
	includeEvolution bool
}

// MarshalJSON 复刻 JSON.stringify(stats) 的 evolution 键行为。
func (s *reviewStats) MarshalJSON() ([]byte, error) {
	type baseStats struct {
		NewArticles        int64        `json:"newArticles"`
		UpdatedArticles    int64        `json:"updatedArticles"`
		TotalChars         int64        `json:"totalChars"`
		KnowledgeBaseCount int64        `json:"knowledgeBaseCount"`
		TopTags            []topTag     `json:"topTags"`
		TopArticles        []topArticle `json:"topArticles"`
		KnowledgeBases     []kbActivity `json:"knowledgeBases"`
	}
	base := baseStats{
		NewArticles:        s.NewArticles,
		UpdatedArticles:    s.UpdatedArticles,
		TotalChars:         s.TotalChars,
		KnowledgeBaseCount: s.KnowledgeBaseCount,
		TopTags:            s.TopTags,
		TopArticles:        s.TopArticles,
		KnowledgeBases:     s.KnowledgeBases,
	}
	if !s.includeEvolution {
		return json.Marshal(base)
	}
	return json.Marshal(struct {
		baseStats
		Evolution *reviewEvolution `json:"evolution"`
	}{baseStats: base, Evolution: s.Evolution})
}

// UnmarshalJSON 供对称反序列化（当前仅测试用途）。
func (s *reviewStats) UnmarshalJSON(data []byte) error {
	var base struct {
		NewArticles        int64            `json:"newArticles"`
		UpdatedArticles    int64            `json:"updatedArticles"`
		TotalChars         int64            `json:"totalChars"`
		KnowledgeBaseCount int64            `json:"knowledgeBaseCount"`
		TopTags            []topTag         `json:"topTags"`
		TopArticles        []topArticle     `json:"topArticles"`
		KnowledgeBases     []kbActivity     `json:"knowledgeBases"`
		Evolution          *reviewEvolution `json:"evolution"`
	}
	if err := json.Unmarshal(data, &base); err != nil {
		return err
	}
	s.NewArticles = base.NewArticles
	s.UpdatedArticles = base.UpdatedArticles
	s.TotalChars = base.TotalChars
	s.KnowledgeBaseCount = base.KnowledgeBaseCount
	s.TopTags = base.TopTags
	s.TopArticles = base.TopArticles
	s.KnowledgeBases = base.KnowledgeBases
	s.Evolution = base.Evolution
	s.includeEvolution = true
	return nil
}

func (s *reviewStats) hasActivity() bool {
	return s.NewArticles > 0 || s.UpdatedArticles > 0
}

const (
	topArticleLimit = 5
	topTagLimit     = 8
	kbActivityLimit = 6
)

// aggregateReviewStats 聚合用户在 [start, end) 内的写作活动。
func aggregateReviewStats(ctx context.Context, userID int64, bounds periodBounds) (*reviewStats, error) {
	pool := db.Pool()
	stats := &reviewStats{
		TopTags:        []topTag{},
		TopArticles:    []topArticle{},
		KnowledgeBases: []kbActivity{},
	}

	// 1) 期内新建
	var newCount int64
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM petrichor_kb_article
		WHERE user_id = $1 AND created_at >= $2 AND created_at < $3`,
		userID, bounds.start, bounds.end).Scan(&newCount); err != nil {
		return nil, err
	}
	stats.NewArticles = newCount

	// 2) 期内被改动过的全部文章（新建也算改动）
	type touchedRow struct {
		id        int64
		title     string
		charCount int64
		createdAt time.Time
		updatedAt time.Time
		kbID      int64
	}
	rows, err := pool.Query(ctx, `
		SELECT id, title, coalesce(char_length(content_md), 0), created_at, updated_at, knowledge_base_id
		FROM petrichor_kb_article
		WHERE user_id = $1 AND updated_at >= $2 AND updated_at < $3
		ORDER BY updated_at ASC`, userID, bounds.start, bounds.end)
	if err != nil {
		return nil, err
	}
	var touched []touchedRow
	for rows.Next() {
		var r touchedRow
		if err := rows.Scan(&r.id, &r.title, &r.charCount, &r.createdAt, &r.updatedAt, &r.kbID); err != nil {
			rows.Close()
			return nil, err
		}
		touched = append(touched, r)
	}
	rows.Close()
	if rows.Err() != nil {
		return nil, rows.Err()
	}

	for _, r := range touched {
		stats.TotalChars += r.charCount
	}
	kbNameMap := map[int64]string{}
	kbIDs := make([]int64, 0, len(touched))
	kbSeen := map[int64]bool{}
	for _, r := range touched {
		if !kbSeen[r.kbID] {
			kbSeen[r.kbID] = true
			kbIDs = append(kbIDs, r.kbID)
		}
	}
	if len(kbIDs) > 0 {
		nameRows, err := pool.Query(ctx, `
			SELECT id, name FROM petrichor_kb_knowledge_base
			WHERE user_id = $1 AND id = ANY($2)`, userID, kbIDs)
		if err != nil {
			return nil, err
		}
		for nameRows.Next() {
			var id int64
			var name string
			if err := nameRows.Scan(&id, &name); err != nil {
				nameRows.Close()
				return nil, err
			}
			kbNameMap[id] = name
		}
		nameRows.Close()
		if nameRows.Err() != nil {
			return nil, nameRows.Err()
		}
	}

	// 按首次出现顺序累计计数（对应 TS Map 的插入序），再稳定排序保证并列时的确定性
	type kbCountEntry struct {
		id    int64
		count int64
	}
	kbOrder := make([]kbCountEntry, 0, len(touched))
	kbCountIdx := map[int64]int{}
	for _, r := range touched {
		if idx, ok := kbCountIdx[r.kbID]; ok {
			kbOrder[idx].count++
			continue
		}
		kbCountIdx[r.kbID] = len(kbOrder)
		kbOrder = append(kbOrder, kbCountEntry{id: r.kbID, count: 1})
	}
	activities := make([]kbActivity, 0, len(kbOrder))
	for _, entry := range kbOrder {
		name, ok := kbNameMap[entry.id]
		if !ok {
			name = "未命名知识库"
		}
		activities = append(activities, kbActivity{ID: idStr(entry.id), Name: name, ArticleCount: entry.count})
	}
	sort.SliceStable(activities, func(i, j int) bool { return activities[i].ArticleCount > activities[j].ArticleCount })
	if len(activities) > kbActivityLimit {
		activities = activities[:kbActivityLimit]
	}
	stats.KnowledgeBases = activities

	// 4) Top 文章（按字数倒序）
	newSet := map[int64]bool{}
	for _, r := range touched {
		if !r.createdAt.Before(bounds.start) && r.createdAt.Before(bounds.end) {
			newSet[r.id] = true
		}
	}
	topTouched := append([]touchedRow(nil), touched...)
	sort.SliceStable(topTouched, func(i, j int) bool { return topTouched[i].charCount > topTouched[j].charCount })
	if len(topTouched) > topArticleLimit {
		topTouched = topTouched[:topArticleLimit]
	}
	for _, r := range topTouched {
		var kbName *string
		if name, ok := kbNameMap[r.kbID]; ok {
			kbName = &name
		}
		stats.TopArticles = append(stats.TopArticles, topArticle{
			ID:                idStr(r.id),
			Title:             r.title,
			CharCount:         r.charCount,
			IsNew:             newSet[r.id],
			KnowledgeBaseID:   idStr(r.kbID),
			KnowledgeBaseName: kbName,
			UpdatedAt:         httpx.FormatISO(r.updatedAt),
		})
	}

	// 5) Top 标签
	if len(touched) > 0 {
		ids := make([]int64, 0, len(touched))
		for _, r := range touched {
			ids = append(ids, r.id)
		}
		tagRows, err := pool.Query(ctx, `
			SELECT tag, count(*) AS total FROM petrichor_kb_article_tag
			WHERE article_id = ANY($1)
			GROUP BY tag
			ORDER BY total DESC
			LIMIT $2`, ids, topTagLimit)
		if err != nil {
			return nil, err
		}
		defer tagRows.Close()
		for tagRows.Next() {
			var t topTag
			if err := tagRows.Scan(&t.Tag, &t.Count); err != nil {
				return nil, err
			}
			stats.TopTags = append(stats.TopTags, t)
		}
		if tagRows.Err() != nil {
			return nil, tagRows.Err()
		}
	}

	stats.UpdatedArticles = int64(len(touched)) - newCount
	if stats.UpdatedArticles < 0 {
		stats.UpdatedArticles = 0
	}
	return stats, nil
}

// ===== 回顾记录 =====

type reviewRecord struct {
	ID                int64
	UserID            int64
	Period            string
	PeriodKey         string
	PeriodStart       time.Time
	PeriodEnd         time.Time
	StatsJSON         string
	Narrative         string
	ModelConfigID     *int64
	RegenerateCount   int32
	LastRegeneratedAt *time.Time
	GeneratedAt       time.Time
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

const reviewCols = `id, user_id, period, period_key, period_start, period_end, stats_json, narrative,
	model_config_id, regenerate_count, last_regenerated_at, generated_at, created_at, updated_at`

func (r *reviewRecord) scanInto() []any {
	return []any{&r.ID, &r.UserID, &r.Period, &r.PeriodKey, &r.PeriodStart, &r.PeriodEnd,
		&r.StatsJSON, &r.Narrative, &r.ModelConfigID, &r.RegenerateCount, &r.LastRegeneratedAt,
		&r.GeneratedAt, &r.CreatedAt, &r.UpdatedAt}
}

func loadReviewRecord(ctx context.Context, userID int64, period, periodKey string) (*reviewRecord, error) {
	var rec reviewRecord
	err := db.Pool().QueryRow(ctx,
		`SELECT `+reviewCols+` FROM petrichor_ai_review
		 WHERE user_id = $1 AND period = $2 AND period_key = $3 LIMIT 1`,
		userID, period, periodKey).Scan(rec.scanInto()...)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &rec, nil
}

// ===== 业务规则（logic.ts 移植）=====

type reviewGetInput struct {
	period       string
	periodKey    string
	forceRebuild bool
}

type reviewListInput struct {
	period   *string
	pageNum  int64
	pageSize int64
}

type reviewRegenerateInput struct {
	period    string
	periodKey string
}

var monthKeyPattern = regexp.MustCompile(`^\d{4}-\d{2}$`)
var weekKeyPattern = regexp.MustCompile(`^\d{4}-W\d{2}$`)

func normalizeReviewPeriod(raw any) (string, error) {
	value := strings.ToUpper(strings.TrimSpace(flexToString(raw)))
	if !isReviewPeriod(value) {
		return "", badRequestMsg("周期必须是 %s", strings.Join(reviewPeriods, " / "))
	}
	return value, nil
}

func normalizePeriodKey(period string, raw any, now time.Time) (string, error) {
	value := strings.TrimSpace(flexToString(raw))
	if value == "" {
		return resolveDefaultPeriodKey(period, now), nil
	}
	if period == "MONTH" && !monthKeyPattern.MatchString(value) {
		return "", badRequestMsg("月份键格式应为 YYYY-MM")
	}
	if period == "WEEK" && !weekKeyPattern.MatchString(value) {
		return "", badRequestMsg("周次键格式应为 YYYY-WNN")
	}
	if _, err := computePeriodBounds(period, value); err != nil {
		return "", badRequestMsg("周期键无效")
	}
	return value, nil
}

func validateReviewGetInput(raw map[string]any, now time.Time) (reviewGetInput, error) {
	period, err := normalizeReviewPeriod(raw["period"])
	if err != nil {
		return reviewGetInput{}, err
	}
	periodKey, err := normalizePeriodKey(period, raw["periodKey"], now)
	if err != nil {
		return reviewGetInput{}, err
	}
	return reviewGetInput{period: period, periodKey: periodKey, forceRebuild: truthy(raw["forceRebuild"])}, nil
}

func validateReviewListInput(raw map[string]any) (reviewListInput, error) {
	out := reviewListInput{
		pageNum:  normalizePositiveInteger(raw["pageNum"], 1),
		pageSize: normalizePositiveInteger(raw["pageSize"], 20),
	}
	if out.pageSize > periodOptionsMaxPages {
		out.pageSize = periodOptionsMaxPages
	}
	if raw["period"] == nil || flexToString(raw["period"]) == "" {
		return out, nil
	}
	period, err := normalizeReviewPeriod(raw["period"])
	if err != nil {
		return reviewListInput{}, err
	}
	out.period = &period
	return out, nil
}

func validateReviewRegenerateInput(raw map[string]any, now time.Time) (reviewRegenerateInput, error) {
	period, err := normalizeReviewPeriod(raw["period"])
	if err != nil {
		return reviewRegenerateInput{}, err
	}
	periodKey, err := normalizePeriodKey(period, raw["periodKey"], now)
	if err != nil {
		return reviewRegenerateInput{}, err
	}
	return reviewRegenerateInput{period: period, periodKey: periodKey}, nil
}

// normalizePositiveInteger 复刻 normalizePositiveInteger：非正整数回落默认值。
func normalizePositiveInteger(v any, fallback int64) int64 {
	n, ok := jsNumber(v)
	if !ok || n != math.Trunc(n) || n <= 0 {
		return fallback
	}
	return int64(n)
}

func isSameUTCDay(a, b time.Time) bool {
	au, bu := a.UTC(), b.UTC()
	return au.Year() == bu.Year() && au.YearDay() == bu.YearDay()
}

func canRegenerateToday(rec *reviewRecord, now time.Time) bool {
	if rec == nil || rec.LastRegeneratedAt == nil {
		return true
	}
	if !isSameUTCDay(*rec.LastRegeneratedAt, now) {
		return true
	}
	return int(rec.RegenerateCount) < maxRegeneratePerDay
}

func nextRegenerateCounters(rec *reviewRecord, now time.Time) (int32, time.Time) {
	if rec == nil || rec.LastRegeneratedAt == nil {
		return 1, now
	}
	count := int32(1)
	if isSameUTCDay(*rec.LastRegeneratedAt, now) {
		count = rec.RegenerateCount + 1
	}
	return count, now
}

const (
	narrativeMaxChars = 4000
	statsJSONMaxChars = 32_000
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
