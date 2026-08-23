// shape.go 复刻 overview-shape.ts：纯数据整形（补零、环比、累计、节律补齐）。
package dashboardpkg

import (
	"sort"
	"strconv"
)

// 统计窗口常量。
const (
	HeatmapDays     = 365
	TrendDays       = 365
	GrowthMonths    = 12
	WindowDays      = 7
	SparkDays       = 14
	AgentWindowDays = 30
)

type heatmapPoint struct {
	Date  string `json:"date"`
	Count int64  `json:"count"`
}

type trendPoint struct {
	Date    string `json:"date"`
	Article int64  `json:"article"`
	Qa      int64  `json:"qa"`
	Agent   int64  `json:"agent"`
	Total   int64  `json:"total"`
}

type growthPoint struct {
	Month    string `json:"month"`
	Articles int64  `json:"articles"`
	Words    int64  `json:"words"`
}

type rhythmCell struct {
	Weekday int   `json:"weekday"`
	Hour    int   `json:"hour"`
	Count   int64 `json:"count"`
}

type distributionItem struct {
	Label string `json:"label"`
	Count int64  `json:"count"`
}

type kpiTile struct {
	Key      string   `json:"key"`
	Label    string   `json:"label"`
	Value    int64    `json:"value"`
	Current  int64    `json:"current"`
	Previous int64    `json:"previous"`
	Delta    *float64 `json:"delta"`
	Spark    []int64  `json:"spark"`
	Unit     *string  `json:"unit,omitempty"`
}

type statItem struct {
	Key   string  `json:"key"`
	Label string  `json:"label"`
	Value int64   `json:"value"`
	Hint  *string `json:"hint,omitempty"`
}

type agentPathStat struct {
	Path       string  `json:"path"`
	Method     string  `json:"method"`
	Count      int64   `json:"count"`
	AvgMs      float64 `json:"avgMs"`
	ErrorCount int64   `json:"errorCount"`
}

type agentDailyPoint struct {
	Date   string `json:"date"`
	Count  int64  `json:"count"`
	AvgMs  int64  `json:"avgMs"`
	Errors int64  `json:"errors"`
}

type toolStat struct {
	Name    string  `json:"name"`
	Count   int64   `json:"count"`
	OkCount int64   `json:"okCount"`
	AvgMs   float64 `json:"avgMs"`
}

type statusBucket struct {
	Status string `json:"status"`
	Count  int64  `json:"count"`
}

type activityItem struct {
	Kind     string  `json:"kind"`
	ID       string  `json:"id"`
	Title    string  `json:"title"`
	Subtitle *string `json:"subtitle"`
	At       string  `json:"at"`
}

// computeDelta 环比百分比：上一周期为 0 时返回 nil（无可比基数）。
func computeDelta(current, previous int64) *float64 {
	if previous <= 0 {
		return nil
	}
	delta := (float64(current) - float64(previous)) / float64(previous) * 100
	return &delta
}

func sumRange(countByDay map[string]int64, days []string) int64 {
	sum := int64(0)
	for _, day := range days {
		sum += countByDay[day]
	}
	return sum
}

// buildKpiTile 对应 buildKpiTile：总量 + 近 7 天 + 前 7 天 + 环比 + 最近 14 天走势。
func buildKpiTile(key, label string, total int64, countByDay map[string]int64, days []string, unit *string) kpiTile {
	currentDays := days[len(days)-WindowDays:]
	previousDays := days[len(days)-WindowDays*2 : len(days)-WindowDays]
	current := sumRange(countByDay, currentDays)
	previous := sumRange(countByDay, previousDays)
	spark := make([]int64, 0, SparkDays)
	for _, day := range days[len(days)-SparkDays:] {
		spark = append(spark, countByDay[day])
	}
	if spark == nil {
		spark = []int64{}
	}
	return kpiTile{
		Key:      key,
		Label:    label,
		Value:    total,
		Current:  current,
		Previous: previous,
		Delta:    computeDelta(current, previous),
		Spark:    spark,
		Unit:     unit,
	}
}

// buildGrowth 按月累计的内容增长：
// 窗口外的存量用「总量 − 窗口内合计」反推成基线，保证每月末的累计值是真实总量。
func buildGrowth(days []string, articleMap, wordMap map[string]int64, totalArticles, totalWords int64) []growthPoint {
	windowArticles := sumRange(articleMap, days)
	windowWords := sumRange(wordMap, days)
	articles := maxInt64(0, totalArticles-windowArticles)
	words := maxInt64(0, totalWords-windowWords)

	type monthBucket struct{ articles, words int64 }
	byMonth := map[string]*monthBucket{}
	var order []string
	for _, day := range days {
		month := day[:7]
		bucket, ok := byMonth[month]
		if !ok {
			bucket = &monthBucket{}
			byMonth[month] = bucket
			order = append(order, month)
		}
		bucket.articles += articleMap[day]
		bucket.words += wordMap[day]
	}

	points := make([]growthPoint, 0, len(order))
	for _, month := range order {
		bucket := byMonth[month]
		articles += bucket.articles
		words += bucket.words
		points = append(points, growthPoint{Month: month, Articles: articles, Words: words})
	}
	// 只取最近 N 个月展示。
	if len(points) > GrowthMonths {
		points = points[len(points)-GrowthMonths:]
	}
	return points
}

// buildRhythmFromTriples 补齐 7×24 全量格子，避免前端还要判空。
func buildRhythmFromTriples(rows []rhythmTriple) []rhythmCell {
	counts := map[string]int64{}
	for _, row := range rows {
		weekday, hour := int(row.weekday), int(row.hour)
		if weekday < 0 || weekday > 6 || hour < 0 || hour > 23 {
			continue
		}
		key := strconv.Itoa(weekday) + ":" + strconv.Itoa(hour)
		counts[key] += row.count
	}
	cells := make([]rhythmCell, 0, 7*24)
	for weekday := 0; weekday < 7; weekday++ {
		for hour := 0; hour < 24; hour++ {
			key := strconv.Itoa(weekday) + ":" + strconv.Itoa(hour)
			cells = append(cells, rhythmCell{Weekday: weekday, Hour: hour, Count: counts[key]})
		}
	}
	return cells
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// sortActivities 按 at 倒序排序后截断到 limit。
func sortActivities(items []activityItem, limit int) []activityItem {
	sort.SliceStable(items, func(i, j int) bool { return items[i].At > items[j].At })
	if len(items) > limit {
		items = items[:limit]
	}
	return items
}
