package dashboard

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/agentcalllog"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantrun"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantstep"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantthread"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticle"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticletag"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocument"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbimportjob"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbwikipage"
	"github.com/Ciao1019/Petrichor/apps/api/ent/knowledgebase"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

const (
	heatmapDays     = 365
	trendDays       = 365
	growthMonths    = 12
	windowDays      = 7
	sparkDays       = 14
	agentWindowDays = 30
)

type Handler struct {
	client *ent.Client
	sql    *sql.DB
}

func NewHandler(client *ent.Client, sqlDB *sql.DB) *Handler {
	return &Handler{client: client, sql: sqlDB}
}

func startOfUTCDay(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

func addDays(t time.Time, days int) time.Time {
	return t.AddDate(0, 0, days)
}

func formatDay(t time.Time) string {
	return t.UTC().Format("2006-01-02")
}

func enumerateDays(start time.Time, count int) []string {
	out := make([]string, 0, count)
	for i := 0; i < count; i++ {
		out = append(out, formatDay(addDays(start, i)))
	}
	return out
}

func toCountMap(rows []dailyRow) map[string]int {
	m := make(map[string]int, len(rows))
	for _, row := range rows {
		if row.Day != "" {
			m[row.Day] = row.Count
		}
	}
	return m
}

func sumRange(m map[string]int, days []string) int {
	total := 0
	for _, d := range days {
		total += m[d]
	}
	return total
}

func computeDelta(current, previous int) *float64 {
	if previous <= 0 {
		return nil
	}
	v := (float64(current-previous) / float64(previous)) * 100
	return &v
}

func buildKpiTile(key, label, unit string, total int, m map[string]int, days []string) gin.H {
	currentDays := days[len(days)-windowDays:]
	prevDays := days[len(days)-windowDays*2 : len(days)-windowDays]
	sparkDaysList := days[len(days)-sparkDays:]
	current := sumRange(m, currentDays)
	previous := sumRange(m, prevDays)
	spark := make([]int, 0, len(sparkDaysList))
	for _, d := range sparkDaysList {
		spark = append(spark, m[d])
	}
	tile := gin.H{
		"key":      key,
		"label":    label,
		"value":    total,
		"current":  current,
		"previous": previous,
		"delta":    computeDelta(current, previous),
		"spark":    spark,
	}
	if unit != "" {
		tile["unit"] = unit
	}
	return tile
}

type dailyRow struct {
	Day   string
	Count int
}

func (h *Handler) loadArticleDaily(ctx context.Context, userID int64, since time.Time) ([]dailyRow, error) {
	rows, err := h.client.KBArticle.Query().
		Where(kbarticle.UserIDEQ(userID), kbarticle.CreatedAtGTE(since)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	m := make(map[string]int)
	for _, row := range rows {
		m[formatDay(row.CreatedAt)]++
	}
	out := make([]dailyRow, 0, len(m))
	for day, count := range m {
		out = append(out, dailyRow{Day: day, Count: count})
	}
	return out, nil
}

func (h *Handler) loadThreadDaily(ctx context.Context, userID int64, since time.Time) ([]dailyRow, error) {
	rows, err := h.client.AssistantThread.Query().
		Where(assistantthread.UserIDEQ(userID), assistantthread.DeletedAtIsNil(), assistantthread.CreatedAtGTE(since)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	m := make(map[string]int)
	for _, row := range rows {
		m[formatDay(row.CreatedAt)]++
	}
	out := make([]dailyRow, 0, len(m))
	for day, count := range m {
		out = append(out, dailyRow{Day: day, Count: count})
	}
	return out, nil
}

func (h *Handler) loadAgentDaily(ctx context.Context, userID int64, since time.Time) ([]dailyRow, error) {
	rows, err := h.client.AgentCallLog.Query().
		Where(agentcalllog.UserIDEQ(userID), agentcalllog.CreatedAtGTE(since)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	m := make(map[string]int)
	for _, row := range rows {
		m[formatDay(row.CreatedAt)]++
	}
	out := make([]dailyRow, 0, len(m))
	for day, count := range m {
		out = append(out, dailyRow{Day: day, Count: count})
	}
	return out, nil
}

func (h *Handler) Overview(c *gin.Context) {
	u := auth.MustUser(c)
	ctx := c.Request.Context()
	now := time.Now().UTC()
	today := startOfUTCDay(now)
	heatmapStart := addDays(today, -(heatmapDays - 1))
	agentStart := addDays(today, -(agentWindowDays - 1))
	days := enumerateDays(heatmapStart, heatmapDays)

	articleRows, err := h.client.KBArticle.Query().
		Where(kbarticle.UserIDEQ(u.ID)).
		All(ctx)
	if err != nil {
		response.Fail(c, err)
		return
	}
	threadDailyRows, err := h.loadThreadDaily(ctx, u.ID, heatmapStart)
	if err != nil {
		response.Fail(c, err)
		return
	}
	agentDailyRows, err := h.loadAgentDaily(ctx, u.ID, heatmapStart)
	if err != nil {
		response.Fail(c, err)
		return
	}
	articleMap := make(map[string]int)
	wordMap := make(map[string]int)
	totalWords := 0
	totalMinutes := 0
	rhythmCounts := make(map[[2]int]int)
	for _, row := range articleRows {
		wordCount := utf8.RuneCountInString(row.ContentMd)
		totalWords += wordCount
		if row.ReadingMinutes != nil {
			totalMinutes += *row.ReadingMinutes
		}
		if !row.CreatedAt.Before(heatmapStart) {
			day := formatDay(row.CreatedAt)
			articleMap[day]++
			wordMap[day] += wordCount
			utc := row.CreatedAt.UTC()
			rhythmCounts[[2]int{int(utc.Weekday()), utc.Hour()}]++
		}
	}
	threadMap := toCountMap(threadDailyRows)
	agentMap := toCountMap(agentDailyRows)

	totalArticles := len(articleRows)
	totalThreads, err := h.client.AssistantThread.Query().
		Where(assistantthread.UserIDEQ(u.ID), assistantthread.DeletedAtIsNil()).Count(ctx)
	if err != nil {
		response.Fail(c, err)
		return
	}
	totalKBs, err := h.client.KnowledgeBase.Query().Where(knowledgebase.UserIDEQ(u.ID)).Count(ctx)
	if err != nil {
		response.Fail(c, err)
		return
	}
	totalWiki, err := h.client.KBWikiPage.Query().
		Where(kbwikipage.UserIDEQ(u.ID), kbwikipage.ArchivedAtIsNil()).Count(ctx)
	if err != nil {
		response.Fail(c, err)
		return
	}
	totalAgentCalls, err := h.client.AgentCallLog.Query().Where(agentcalllog.UserIDEQ(u.ID)).Count(ctx)
	if err != nil {
		response.Fail(c, err)
		return
	}
	totalTags := 0
	articleIDs, err := h.client.KBArticle.Query().
		Where(kbarticle.UserIDEQ(u.ID)).
		IDs(ctx)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if len(articleIDs) > 0 {
		tagRows, err := h.client.KBArticleTag.Query().
			Where(kbarticletag.ArticleIDIn(articleIDs...)).
			All(ctx)
		if err != nil {
			response.Fail(c, err)
			return
		}
		seen := make(map[string]struct{})
		for _, row := range tagRows {
			seen[row.Tag] = struct{}{}
		}
		totalTags = len(seen)
	}
	docRows, err := h.client.KBDocument.Query().Where(kbdocument.UserIDEQ(u.ID)).All(ctx)
	if err != nil {
		response.Fail(c, err)
		return
	}
	documentTotal := len(docRows)
	documentBytes := int64(0)
	documentPages := 0
	docStatus := make(map[string]int)
	for _, row := range docRows {
		docStatus[row.Status]++
		if row.SizeBytes != nil {
			documentBytes += *row.SizeBytes
		}
		if row.PageCount != nil {
			documentPages += *row.PageCount
		}
	}
	importRows, err := h.client.KBImportJob.Query().Where(kbimportjob.UserIDEQ(u.ID)).All(ctx)
	if err != nil {
		response.Fail(c, err)
		return
	}
	importTotal := len(importRows)
	importStatus := make(map[string]int)
	for _, row := range importRows {
		importStatus[row.Status]++
	}

	agentWindowRows, err := h.client.AgentCallLog.Query().
		Where(agentcalllog.UserIDEQ(u.ID), agentcalllog.CreatedAtGTE(agentStart)).
		All(ctx)
	if err != nil {
		response.Fail(c, err)
		return
	}
	agentWindowTotal := len(agentWindowRows)
	agentSuccess := 0
	agentClientErrors := 0
	agentServerErrors := 0
	totalDuration := 0
	maxDuration := 0
	type dailyAgentStats struct {
		count    int
		duration int
		errors   int
	}
	agentDailyStats := make(map[string]*dailyAgentStats)
	pathStats := make(map[string]gin.H)
	for _, row := range agentWindowRows {
		day := formatDay(row.CreatedAt)
		daily := agentDailyStats[day]
		if daily == nil {
			daily = &dailyAgentStats{}
			agentDailyStats[day] = daily
		}
		daily.count++
		daily.duration += row.DurationMs
		if row.StatusCode < 400 {
			agentSuccess++
		} else if row.StatusCode < 500 {
			agentClientErrors++
			daily.errors++
		} else {
			agentServerErrors++
			daily.errors++
		}
		totalDuration += row.DurationMs
		if row.DurationMs > maxDuration {
			maxDuration = row.DurationMs
		}
		key := row.Method + " " + row.Path
		stat, ok := pathStats[key]
		if !ok {
			stat = gin.H{
				"path":       row.Path,
				"method":     row.Method,
				"count":      0,
				"avgMs":      0,
				"errorCount": 0,
				"_dur":       0,
			}
		}
		stat["count"] = stat["count"].(int) + 1
		stat["_dur"] = stat["_dur"].(int) + row.DurationMs
		if row.StatusCode >= 400 {
			stat["errorCount"] = stat["errorCount"].(int) + 1
		}
		pathStats[key] = stat
	}
	topPaths := make([]gin.H, 0, len(pathStats))
	for _, stat := range pathStats {
		count := stat["count"].(int)
		if count > 0 {
			stat["avgMs"] = stat["_dur"].(int) / count
		}
		delete(stat, "_dur")
		topPaths = append(topPaths, stat)
	}
	sort.Slice(topPaths, func(i, j int) bool {
		return topPaths[i]["count"].(int) > topPaths[j]["count"].(int)
	})
	if len(topPaths) > 6 {
		topPaths = topPaths[:6]
	}

	heatmapTotal := 0
	heatmapPoints := make([]gin.H, 0, len(days))
	for _, date := range days {
		count := articleMap[date]
		heatmapTotal += count
		heatmapPoints = append(heatmapPoints, gin.H{"date": date, "count": count})
	}

	trendDaysList := days
	if len(trendDaysList) > trendDays {
		trendDaysList = trendDaysList[len(trendDaysList)-trendDays:]
	}
	trend := make([]gin.H, 0, len(trendDaysList))
	for _, date := range trendDaysList {
		article := articleMap[date]
		qa := threadMap[date]
		agent := agentMap[date]
		trend = append(trend, gin.H{
			"date":    date,
			"article": article,
			"qa":      qa,
			"agent":   agent,
			"total":   article + qa + agent,
		})
	}

	kbDist := make([]gin.H, 0)
	kbs, err := h.client.KnowledgeBase.Query().Where(knowledgebase.UserIDEQ(u.ID)).All(ctx)
	if err != nil {
		response.Fail(c, err)
		return
	}
	for _, kb := range kbs {
		count, err := h.client.KBArticle.Query().
			Where(kbarticle.UserIDEQ(u.ID), kbarticle.KnowledgeBaseIDEQ(kb.ID)).Count(ctx)
		if err != nil {
			response.Fail(c, err)
			return
		}
		if count > 0 {
			kbDist = append(kbDist, gin.H{"label": kb.Name, "count": count})
		}
	}
	sort.Slice(kbDist, func(i, j int) bool {
		return kbDist[i]["count"].(int) > kbDist[j]["count"].(int)
	})
	if len(kbDist) > 6 {
		kbDist = kbDist[:6]
	}

	tagRows := make([]*ent.KBArticleTag, 0)
	if len(articleIDs) > 0 {
		tagRows, err = h.client.KBArticleTag.Query().
			Where(kbarticletag.ArticleIDIn(articleIDs...)).
			All(ctx)
		if err != nil {
			response.Fail(c, err)
			return
		}
	}
	tagCount := make(map[string]int)
	for _, row := range tagRows {
		tagCount[row.Tag]++
	}
	tagDist := make([]gin.H, 0, len(tagCount))
	for tag, count := range tagCount {
		tagDist = append(tagDist, gin.H{"label": tag, "count": count})
	}
	sort.Slice(tagDist, func(i, j int) bool {
		return tagDist[i]["count"].(int) > tagDist[j]["count"].(int)
	})
	if len(tagDist) > 8 {
		tagDist = tagDist[:8]
	}

	recentArticles, err := h.client.KBArticle.Query().
		Where(kbarticle.UserIDEQ(u.ID)).
		Order(ent.Desc(kbarticle.FieldCreatedAt), ent.Desc(kbarticle.FieldID)).
		Limit(6).All(ctx)
	if err != nil {
		response.Fail(c, err)
		return
	}
	recentThreads, err := h.client.AssistantThread.Query().
		Where(assistantthread.UserIDEQ(u.ID), assistantthread.DeletedAtIsNil()).
		Order(ent.Desc(assistantthread.FieldUpdatedAt), ent.Desc(assistantthread.FieldID)).
		Limit(6).All(ctx)
	if err != nil {
		response.Fail(c, err)
		return
	}

	recentActivity := make([]gin.H, 0)
	for _, row := range recentArticles {
		kbName := ""
		if kb, err := h.client.KnowledgeBase.Get(ctx, row.KnowledgeBaseID); err == nil {
			kbName = kb.Name
		}
		recentActivity = append(recentActivity, gin.H{
			"kind":     "article",
			"id":       fmt.Sprintf("%d", row.ID),
			"title":    row.Title,
			"subtitle": kbName,
			"at":       row.CreatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	for _, row := range recentThreads {
		title := row.Title
		if title == "" {
			title = "未命名对话"
		}
		recentActivity = append(recentActivity, gin.H{
			"kind":     "thread",
			"id":       fmt.Sprintf("%d", row.ID),
			"title":    title,
			"subtitle": nil,
			"at":       row.UpdatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	sort.Slice(recentActivity, func(i, j int) bool {
		return recentActivity[i]["at"].(string) > recentActivity[j]["at"].(string)
	})
	if len(recentActivity) > 8 {
		recentActivity = recentActivity[:8]
	}

	threadSummaries := make([]gin.H, 0, len(recentThreads))
	for _, row := range recentThreads {
		var focus any
		if row.FocusJSON != nil {
			_ = json.Unmarshal([]byte(*row.FocusJSON), &focus)
		}
		threadSummaries = append(threadSummaries, gin.H{
			"id":        fmt.Sprintf("%d", row.ID),
			"title":     row.Title,
			"focus":     focus,
			"createdAt": row.CreatedAt.UTC().Format(time.RFC3339Nano),
			"updatedAt": row.UpdatedAt.UTC().Format(time.RFC3339Nano),
		})
	}

	docBuckets := make([]gin.H, 0, len(docStatus))
	for status, count := range docStatus {
		docBuckets = append(docBuckets, gin.H{"status": status, "count": count})
	}
	importBuckets := make([]gin.H, 0, len(importStatus))
	for status, count := range importStatus {
		importBuckets = append(importBuckets, gin.H{"status": status, "count": count})
	}
	sort.Slice(docBuckets, func(i, j int) bool {
		left := docBuckets[i]["count"].(int)
		right := docBuckets[j]["count"].(int)
		if left == right {
			return docBuckets[i]["status"].(string) < docBuckets[j]["status"].(string)
		}
		return left > right
	})
	sort.Slice(importBuckets, func(i, j int) bool {
		left := importBuckets[i]["count"].(int)
		right := importBuckets[j]["count"].(int)
		if left == right {
			return importBuckets[i]["status"].(string) < importBuckets[j]["status"].(string)
		}
		return left > right
	})

	agentDaily := make([]gin.H, 0, agentWindowDays)
	agentWindowDaysList := days[len(days)-agentWindowDays:]
	for _, date := range agentWindowDaysList {
		stats := agentDailyStats[date]
		count, avgMs, errors := 0, 0, 0
		if stats != nil {
			count = stats.count
			errors = stats.errors
			if stats.count > 0 {
				avgMs = stats.duration / stats.count
			}
		}
		agentDaily = append(agentDaily, gin.H{
			"date":   date,
			"count":  count,
			"avgMs":  avgMs,
			"errors": errors,
		})
	}

	windowArticles := sumRange(articleMap, days)
	windowWords := sumRange(wordMap, days)
	cumulativeArticles := max(0, totalArticles-windowArticles)
	cumulativeWords := max(0, totalWords-windowWords)
	type monthGrowth struct {
		articles int
		words    int
	}
	monthOrder := make([]string, 0, 13)
	monthBuckets := make(map[string]*monthGrowth)
	for _, day := range days {
		month := day[:7]
		bucket := monthBuckets[month]
		if bucket == nil {
			bucket = &monthGrowth{}
			monthBuckets[month] = bucket
			monthOrder = append(monthOrder, month)
		}
		bucket.articles += articleMap[day]
		bucket.words += wordMap[day]
	}
	growth := make([]gin.H, 0, len(monthOrder))
	for _, month := range monthOrder {
		bucket := monthBuckets[month]
		cumulativeArticles += bucket.articles
		cumulativeWords += bucket.words
		growth = append(growth, gin.H{
			"month":    month,
			"articles": cumulativeArticles,
			"words":    cumulativeWords,
		})
	}
	if len(growth) > growthMonths {
		growth = growth[len(growth)-growthMonths:]
	}

	rhythmCells := make([]gin.H, 0, 7*24)
	for weekday := 0; weekday < 7; weekday++ {
		for hour := 0; hour < 24; hour++ {
			rhythmCells = append(rhythmCells, gin.H{
				"weekday": weekday,
				"hour":    hour,
				"count":   rhythmCounts[[2]int{weekday, hour}],
			})
		}
	}

	type toolAggregate struct {
		count         int
		okCount       int
		durationTotal int
		durationCount int
	}
	toolAggregates := make(map[string]*toolAggregate)
	liveThreadIDs, err := h.client.AssistantThread.Query().
		Where(assistantthread.UserIDEQ(u.ID), assistantthread.DeletedAtIsNil()).
		IDs(ctx)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if len(liveThreadIDs) > 0 {
		runIDs, err := h.client.AssistantRun.Query().
			Where(assistantrun.ThreadIDIn(liveThreadIDs...), assistantrun.StartedAtGTE(agentStart)).
			IDs(ctx)
		if err != nil {
			response.Fail(c, err)
			return
		}
		if len(runIDs) > 0 {
			steps, err := h.client.AssistantStep.Query().
				Where(assistantstep.RunIDIn(runIDs...)).
				All(ctx)
			if err != nil {
				response.Fail(c, err)
				return
			}
			for _, step := range steps {
				aggregate := toolAggregates[step.ToolName]
				if aggregate == nil {
					aggregate = &toolAggregate{}
					toolAggregates[step.ToolName] = aggregate
				}
				aggregate.count++
				if step.Status == "COMPLETED" {
					aggregate.okCount++
				}
				if step.DurationMs != nil {
					aggregate.durationTotal += *step.DurationMs
					aggregate.durationCount++
				}
			}
		}
	}
	toolItems := make([]gin.H, 0, len(toolAggregates))
	for name, aggregate := range toolAggregates {
		avgMs := 0
		if aggregate.durationCount > 0 {
			avgMs = aggregate.durationTotal / aggregate.durationCount
		}
		toolItems = append(toolItems, gin.H{
			"name":    name,
			"count":   aggregate.count,
			"okCount": aggregate.okCount,
			"avgMs":   avgMs,
		})
	}
	sort.Slice(toolItems, func(i, j int) bool {
		left, right := toolItems[i]["count"].(int), toolItems[j]["count"].(int)
		if left == right {
			return toolItems[i]["name"].(string) < toolItems[j]["name"].(string)
		}
		return left > right
	})
	if len(toolItems) > 8 {
		toolItems = toolItems[:8]
	}

	assets := make([]gin.H, 0, 3)
	for _, item := range []struct {
		label string
		count int
	}{
		{label: "文章", count: totalArticles},
		{label: "Wiki 页面", count: totalWiki},
		{label: "文档", count: documentTotal},
	} {
		if item.count > 0 {
			assets = append(assets, gin.H{"label": item.label, "count": item.count})
		}
	}

	avgDuration := 0
	if agentWindowTotal > 0 {
		avgDuration = totalDuration / agentWindowTotal
	}
	successRate := 0.0
	if agentWindowTotal > 0 {
		successRate = float64(agentSuccess) / float64(agentWindowTotal) * 100
	}

	response.OK(c, gin.H{
		"generatedAt": now.Format(time.RFC3339Nano),
		"kpis": gin.H{
			"primary": []gin.H{
				buildKpiTile("articles", "文章总数", "", totalArticles, articleMap, days),
				buildKpiTile("words", "累计字数", "字", totalWords, wordMap, days),
				buildKpiTile("threads", "助手对话", "", totalThreads, threadMap, days),
				buildKpiTile("agentCalls", "Agent 调用", "", totalAgentCalls, agentMap, days),
			},
			"secondary": []gin.H{
				{"key": "knowledgeBases", "label": "知识库", "value": totalKBs},
				{"key": "wikiPages", "label": "Wiki 页面", "value": totalWiki},
				{"key": "documents", "label": "文档", "value": documentTotal, "hint": fmt.Sprintf("%d 页", documentPages)},
				{"key": "tags", "label": "标签", "value": totalTags},
				{"key": "readingMinutes", "label": "阅读时长", "value": totalMinutes, "hint": "分钟"},
			},
		},
		"heatmap": gin.H{
			"points": heatmapPoints,
			"start":  days[0],
			"end":    days[len(days)-1],
			"total":  heatmapTotal,
		},
		"trend":  trend,
		"growth": growth,
		"rhythm": gin.H{
			"cells": rhythmCells,
			"total": heatmapTotal,
		},
		"distribution": gin.H{
			"knowledgeBases": kbDist,
			"tags":           tagDist,
		},
		"assets": assets,
		"agent": gin.H{
			"windowDays":    agentWindowDays,
			"totalCalls":    agentWindowTotal,
			"successCalls":  agentSuccess,
			"clientErrors":  agentClientErrors,
			"serverErrors":  agentServerErrors,
			"successRate":   successRate,
			"avgDurationMs": avgDuration,
			"maxDurationMs": maxDuration,
			"topPaths":      topPaths,
			"daily":         agentDaily,
		},
		"tools": gin.H{
			"windowDays": agentWindowDays,
			"items":      toolItems,
		},
		"pipeline": gin.H{
			"documents":     docBuckets,
			"imports":       importBuckets,
			"documentTotal": documentTotal,
			"documentBytes": documentBytes,
			"documentPages": documentPages,
			"importTotal":   importTotal,
		},
		"recentActivity": recentActivity,
		"recentThreads":  threadSummaries,
	})
}
