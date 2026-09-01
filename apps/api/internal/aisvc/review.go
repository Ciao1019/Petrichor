// review.go 对照 review/{handlers,logic,period,stats,prompt,evolution}.ts：
// AI 写作回顾（周报/月报）。聚合周期内写作活动 → CHAT 模型生成 markdown 综述
// → 落 petrichor_ai_review 缓存 + 站内通知。周/月边界基于 Asia/Shanghai 口径。
package aisvc

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

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
