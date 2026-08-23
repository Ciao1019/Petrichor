// overview.go 复刻 overview-logic.ts 的 loadDashboardOverview：
// 合并聚合 SQL（标量一条、按天序列 union all 一条、分布/状态分组各一条）+ 纯函数整形。
package dashboardpkg

import (
	"context"
	"strconv"
	"time"

	httpx "petrichor/api/internal/httpx"

	"petrichor/api/internal/db"
)

// formatUtcDay 对应 formatUtcDay：UTC YYYY-MM-DD。
func formatUtcDay(t time.Time) string {
	return t.UTC().Format("2006-01-02")
}

// enumerateDays 生成 [start, start+days) 的日期字符串序列。
func enumerateDays(start time.Time, days int) []string {
	result := make([]string, 0, days)
	base := time.Date(start.UTC().Year(), start.UTC().Month(), start.UTC().Day(), 0, 0, 0, 0, time.UTC)
	for i := 0; i < days; i++ {
		result = append(result, formatUtcDay(base.AddDate(0, 0, i)))
	}
	return result
}

type scalarRow struct {
	articles         int64
	words            int64
	minutes          int64
	threads          int64
	knowledgeBases   int64
	tags             int64
	wikiPages        int64
	graphEdges       int64
	agentCallsTotal  int64
	agentWindowTotal int64
	agentSuccess     int64
	agentClientErr   int64
	agentServerErr   int64
	agentAvgMs       int64
	agentMaxMs       int64
}

type dailyRow struct {
	bucket string
	day    string
	c1     int64
	c2     int64
	c3     int64
}

type labelRow struct {
	bucket string
	label  string
	c1     int64
	c2     int64
	c3     int64
}

type pathRow struct {
	path       string
	method     string
	count      int64
	avgMs      float64
	errorCount int64
}

type toolRow struct {
	name    string
	count   int64
	okCount int64
	avgMs   float64
}

// OverviewResponse 总览响应（recentThreads 用 map 形态对齐 toAssistantThreadResponse）。
type OverviewResponse struct {
	GeneratedAt    string             `json:"generatedAt"`
	Kpis           kpis               `json:"kpis"`
	Heatmap        heatmap            `json:"heatmap"`
	Trend          []trendPoint       `json:"trend"`
	Growth         []growthPoint      `json:"growth"`
	Rhythm         rhythm             `json:"rhythm"`
	Distribution   distribution       `json:"distribution"`
	Assets         []distributionItem `json:"assets"`
	Agent          agentStats         `json:"agent"`
	Tools          toolsStats         `json:"tools"`
	Pipeline       pipeline           `json:"pipeline"`
	RecentActivity []activityItem     `json:"recentActivity"`
	RecentThreads  []map[string]any   `json:"recentThreads"`
}

type kpis struct {
	Primary   []kpiTile  `json:"primary"`
	Secondary []statItem `json:"secondary"`
}

type heatmap struct {
	Points []heatmapPoint `json:"points"`
	Start  string         `json:"start"`
	End    string         `json:"end"`
	Total  int64          `json:"total"`
}

type rhythm struct {
	Cells []rhythmCell `json:"cells"`
	Total int64        `json:"total"`
}

type distribution struct {
	KnowledgeBases []distributionItem `json:"knowledgeBases"`
	Tags           []distributionItem `json:"tags"`
}

type agentStats struct {
	WindowDays    int               `json:"windowDays"`
	TotalCalls    int64             `json:"totalCalls"`
	SuccessCalls  int64             `json:"successCalls"`
	ClientErrors  int64             `json:"clientErrors"`
	ServerErrors  int64             `json:"serverErrors"`
	SuccessRate   float64           `json:"successRate"`
	AvgDurationMs int64             `json:"avgDurationMs"`
	MaxDurationMs int64             `json:"maxDurationMs"`
	TopPaths      []agentPathStat   `json:"topPaths"`
	Daily         []agentDailyPoint `json:"daily"`
}

type toolsStats struct {
	WindowDays int        `json:"windowDays"`
	Items      []toolStat `json:"items"`
}

type pipeline struct {
	Documents     []statusBucket `json:"documents"`
	Imports       []statusBucket `json:"imports"`
	DocumentTotal int64          `json:"documentTotal"`
	DocumentBytes int64          `json:"documentBytes"`
	DocumentPages int64          `json:"documentPages"`
	ImportTotal   int64          `json:"importTotal"`
}

func num(v int64) int64 { return v }

// LoadDashboardOverview 复刻 loadDashboardOverview（PostgreSQL 方言）。
func LoadDashboardOverview(ctx context.Context, userID int64) (*OverviewResponse, error) {
	pool := db.Pool()
	now := time.Now()
	todayUTC := now.UTC().Truncate(24 * time.Hour)
	heatmapStart := todayUTC.AddDate(0, 0, -(HeatmapDays - 1))
	agentStart := todayUTC.AddDate(0, 0, -(AgentWindowDays - 1))
	days := enumerateDays(heatmapStart, HeatmapDays)

	// 1) 标量总量：全部挂在当前用户那一行上，保证恰好返回一行。
	var scalars scalarRow
	scalarErr := pool.QueryRow(ctx, `
SELECT
	(SELECT count(*)::int FROM petrichor_kb_article WHERE user_id = $1),
	(SELECT coalesce(sum(length(content_md)), 0)::bigint FROM petrichor_kb_article WHERE user_id = $1),
	(SELECT coalesce(sum(coalesce(reading_minutes, 0)), 0)::bigint FROM petrichor_kb_article WHERE user_id = $1),
	(SELECT count(*)::int FROM petrichor_assistant_thread WHERE user_id = $1 AND deleted_at IS NULL),
	(SELECT count(*)::int FROM petrichor_kb_knowledge_base WHERE user_id = $1),
	(SELECT count(distinct t.tag)::int FROM petrichor_kb_article_tag t
		JOIN petrichor_kb_article a ON a.id = t.article_id WHERE a.user_id = $1),
	(SELECT count(*)::int FROM petrichor_kb_wiki_page WHERE user_id = $1 AND archived_at IS NULL),
	(SELECT count(*)::int FROM petrichor_site_graph_edge WHERE user_id = $1),
	(SELECT count(*)::int FROM petrichor_agent_call_log WHERE user_id = $1),
	(SELECT count(*)::int FROM petrichor_agent_call_log WHERE user_id = $1 AND created_at >= $2),
	(SELECT coalesce(sum(CASE WHEN status_code < 400 THEN 1 ELSE 0 END), 0)::int FROM petrichor_agent_call_log WHERE user_id = $1 AND created_at >= $2),
	(SELECT coalesce(sum(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END), 0)::int FROM petrichor_agent_call_log WHERE user_id = $1 AND created_at >= $2),
	(SELECT coalesce(sum(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END), 0)::int FROM petrichor_agent_call_log WHERE user_id = $1 AND created_at >= $2),
	(SELECT coalesce(avg(duration_ms), 0)::int FROM petrichor_agent_call_log WHERE user_id = $1 AND created_at >= $2),
	(SELECT coalesce(max(duration_ms), 0)::int FROM petrichor_agent_call_log WHERE user_id = $1 AND created_at >= $2)`,
		userID, agentStart).Scan(
		&scalars.articles, &scalars.words, &scalars.minutes,
		&scalars.threads, &scalars.knowledgeBases, &scalars.tags,
		&scalars.wikiPages, &scalars.graphEdges, &scalars.agentCallsTotal,
		&scalars.agentWindowTotal, &scalars.agentSuccess, &scalars.agentClientErr,
		&scalars.agentServerErr, &scalars.agentAvgMs, &scalars.agentMaxMs)
	if scalarErr != nil {
		return nil, scalarErr
	}

	// 2) 三条按天活动序列：bucket 区分后 union all 拼成一条。
	dailyRows := []dailyRow{}
	if err := collectRows(&dailyRows, func() (rowScanner, error) {
		return pool.Query(ctx, `
SELECT t.bucket, t.day, t.c1, t.c2, t.c3 FROM (
	SELECT 'article' AS bucket,
	       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
	       count(*)::int AS c1,
	       coalesce(sum(length(content_md)), 0)::bigint AS c2,
	       0 AS c3
		FROM petrichor_kb_article
		WHERE user_id = $1 AND created_at >= $2
		GROUP BY 2
	UNION ALL
	SELECT 'qa', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), count(*)::int, 0, 0
		FROM petrichor_assistant_thread
		WHERE user_id = $1 AND deleted_at IS NULL AND created_at >= $2
		GROUP BY 2
	UNION ALL
	SELECT 'agent', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
	       count(*)::int, coalesce(avg(duration_ms), 0)::int,
	       coalesce(sum(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0)::int
		FROM petrichor_agent_call_log
		WHERE user_id = $1 AND created_at >= $2
		GROUP BY 2
) AS t`, userID, heatmapStart)
	}, func(rs rowScanner) (dailyRow, error) {
		var r dailyRow
		err := rs.Scan(&r.bucket, &r.day, &r.c1, &r.c2, &r.c3)
		return r, err
	}); err != nil {
		return nil, err
	}
	articleMap := map[string]int64{}
	wordMap := map[string]int64{}
	qaMap := map[string]int64{}
	agentMap := map[string]*agentDaily{}
	for _, row := range dailyRows {
		switch row.bucket {
		case "article":
			articleMap[row.day] = num(row.c1)
			wordMap[row.day] = num(row.c2)
		case "qa":
			qaMap[row.day] = num(row.c1)
		case "agent":
			agentMap[row.day] = &agentDaily{count: num(row.c1), avgMs: num(row.c2), errors: num(row.c3)}
		}
	}

	// 3) 知识库分布与标签分布：各自带 limit，包一层子查询再 union，显式排序保 Top N 次序。
	labelRows := []labelRow{}
	if err := collectRows(&labelRows, func() (rowScanner, error) {
		return pool.Query(ctx, `
SELECT t.bucket, t.label, t.c1 FROM (
	SELECT * FROM (
		SELECT 'kb' AS bucket, kb.name AS label, count(a.id)::int AS c1
			FROM petrichor_kb_article a
			JOIN petrichor_kb_knowledge_base kb ON kb.id = a.knowledge_base_id
			WHERE a.user_id = $1
			GROUP BY kb.id, kb.name
			ORDER BY c1 DESC
			LIMIT 6
	) AS kb_dist
	UNION ALL
	SELECT * FROM (
		SELECT 'tag' AS bucket, tag AS label, count(*)::int AS c1
			FROM petrichor_kb_article_tag t
			JOIN petrichor_kb_article a ON a.id = t.article_id
			WHERE a.user_id = $1
			GROUP BY tag
			ORDER BY c1 DESC
			LIMIT 8
	) AS tag_dist
) AS t ORDER BY t.bucket ASC, t.c1 DESC`, userID)
	}, func(rs rowScanner) (labelRow, error) {
		var r labelRow
		err := rs.Scan(&r.bucket, &r.label, &r.c1)
		return r, err
	}); err != nil {
		return nil, err
	}

	// 4) 文档状态 / 导入任务状态 / 图谱节点类型分组计数。
	groupRows := []labelRow{}
	if err := collectRows(&groupRows, func() (rowScanner, error) {
		return pool.Query(ctx, `
SELECT t.bucket, t.label, t.c1, t.c2, t.c3 FROM (
	SELECT 'doc' AS bucket, status AS label, count(*)::int AS c1,
	       coalesce(sum(coalesce(size_bytes, 0)), 0)::bigint AS c2,
	       coalesce(sum(coalesce(page_count, 0)), 0)::bigint AS c3
		FROM petrichor_doc_document
		WHERE user_id = $1
		GROUP BY status
	UNION ALL
	SELECT 'import', status, count(*)::int, 0, 0
		FROM petrichor_kb_import_job
		WHERE user_id = $1
		GROUP BY status
	UNION ALL
	SELECT 'graph_node', kind, count(*)::int,
	       coalesce(sum(CASE WHEN status = 'PUBLISHED' THEN 1 ELSE 0 END), 0)::int, 0
		FROM petrichor_site_graph_node
		WHERE user_id = $1
		GROUP BY kind
) AS t ORDER BY t.bucket ASC, t.c1 DESC`, userID)
	}, func(rs rowScanner) (labelRow, error) {
		var r labelRow
		err := rs.Scan(&r.bucket, &r.label, &r.c1, &r.c2, &r.c3)
		return r, err
	}); err != nil {
		return nil, err
	}

	// 5) Agent 高频路径 Top 6。
	pathRows := []pathRow{}
	if err := collectRows(&pathRows, func() (rowScanner, error) {
		return pool.Query(ctx, `
SELECT path, method, count(*)::int AS count,
       coalesce(avg(duration_ms), 0)::float8 AS avg_ms,
       coalesce(sum(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0)::int AS error_count
FROM petrichor_agent_call_log
WHERE user_id = $1 AND created_at >= $2
GROUP BY path, method
ORDER BY count(*) DESC
LIMIT 6`, userID, agentStart)
	}, func(rs rowScanner) (pathRow, error) {
		var r pathRow
		err := rs.Scan(&r.path, &r.method, &r.count, &r.avgMs, &r.errorCount)
		return r, err
	}); err != nil {
		return nil, err
	}

	// 6) 助手工具调用：step 无 user_id，经 run → thread 回溯归属。
	toolRows := []toolRow{}
	if err := collectRows(&toolRows, func() (rowScanner, error) {
		return pool.Query(ctx, `
SELECT s.tool_name AS name, count(*)::int AS count,
       coalesce(sum(CASE WHEN s.status = 'COMPLETED' THEN 1 ELSE 0 END), 0)::int AS ok_count,
       coalesce(avg(s.duration_ms), 0)::float8 AS avg_ms
FROM petrichor_assistant_step s
JOIN petrichor_assistant_run r ON r.id = s.run_id
JOIN petrichor_assistant_thread th ON th.id = r.thread_id
WHERE th.user_id = $1 AND th.deleted_at IS NULL AND r.started_at >= $2
GROUP BY s.tool_name
ORDER BY count(*) DESC
LIMIT 8`, userID, agentStart)
	}, func(rs rowScanner) (toolRow, error) {
		var r toolRow
		err := rs.Scan(&r.name, &r.count, &r.okCount, &r.avgMs)
		return r, err
	}); err != nil {
		return nil, err
	}

	// 7) 创作节律：UTC 星期 × 小时。
	rhythmRows := []rhythmTriple{}
	if err := collectRows(&rhythmRows, func() (rowScanner, error) {
		return pool.Query(ctx, `
SELECT extract(dow from created_at AT TIME ZONE 'UTC')::int AS weekday,
       extract(hour from created_at AT TIME ZONE 'UTC')::int AS hour,
       count(*)::int AS count
FROM petrichor_kb_article
WHERE user_id = $1 AND created_at >= $2
GROUP BY 1, 2`, userID, heatmapStart)
	}, func(rs rowScanner) (rhythmTriple, error) {
		var r rhythmTriple
		err := rs.Scan(&r.weekday, &r.hour, &r.count)
		return r, err
	}); err != nil {
		return nil, err
	}

	// 8) 最近文章 Top 6。
	recentArticles := []recentArticle{}
	if err := collectRows(&recentArticles, func() (rowScanner, error) {
		return pool.Query(ctx, `
SELECT a.id, a.title, kb.name, a.created_at
FROM petrichor_kb_article a
JOIN petrichor_kb_knowledge_base kb ON kb.id = a.knowledge_base_id
WHERE a.user_id = $1
ORDER BY a.created_at DESC, a.id DESC
LIMIT 6`, userID)
	}, func(rs rowScanner) (recentArticle, error) {
		var r recentArticle
		err := rs.Scan(&r.id, &r.title, &r.kbName, &r.createdAt)
		return r, err
	}); err != nil {
		return nil, err
	}

	// 9) 最近助手会话 Top 6（对应 listAssistantThreads limit=6）。
	recentThreadItems := []threadSummary{}
	if err := collectRows(&recentThreadItems, func() (rowScanner, error) {
		return pool.Query(ctx, `
SELECT id, title, focus_json, created_at, updated_at
FROM petrichor_assistant_thread
WHERE user_id = $1 AND deleted_at IS NULL
ORDER BY updated_at DESC, id DESC
LIMIT 6`, userID)
	}, func(rs rowScanner) (threadSummary, error) {
		var r threadSummary
		err := rs.Scan(&r.id, &r.title, &r.focusJSON, &r.createdAt, &r.updatedAt)
		return r, err
	}); err != nil {
		return nil, err
	}

	// ===== 整形 =====

	heatmapTotal := int64(0)
	heatmapPoints := make([]heatmapPoint, 0, len(days))
	for _, date := range days {
		count := articleMap[date]
		heatmapTotal += count
		heatmapPoints = append(heatmapPoints, heatmapPoint{Date: date, Count: count})
	}

	trendDays := days[len(days)-TrendDays:]
	trend := make([]trendPoint, 0, len(trendDays))
	for _, date := range trendDays {
		article := articleMap[date]
		qa := qaMap[date]
		var agentCount int64
		if row := agentMap[date]; row != nil {
			agentCount = row.count
		}
		trend = append(trend, trendPoint{
			Date: date, Article: article, Qa: qa, Agent: agentCount,
			Total: article + qa + agentCount,
		})
	}

	docRows := filterLabelRows(groupRows, "doc")
	importRows := filterLabelRows(groupRows, "import")
	graphNodeRows := filterLabelRows(groupRows, "graph_node")

	var documentTotal, documentBytes, documentPages, importTotal int64
	for _, row := range docRows {
		documentTotal += num(row.c1)
		documentBytes += num(row.c2)
		documentPages += num(row.c3)
	}
	for _, row := range importRows {
		importTotal += num(row.c1)
	}
	var graphNodeTotal, graphNodePublished int64
	for _, row := range graphNodeRows {
		graphNodeTotal += num(row.c1)
		graphNodePublished += num(row.c2)
	}

	agentWindowCalls := num(scalars.agentWindowTotal)
	var successRate float64
	if agentWindowCalls > 0 {
		successRate = float64(num(scalars.agentSuccess)) / float64(agentWindowCalls) * 100
	}

	recentActivity := make([]activityItem, 0, len(recentArticles)+len(recentThreadItems))
	for _, article := range recentArticles {
		subtitle := article.kbName
		recentActivity = append(recentActivity, activityItem{
			Kind: "article", ID: strconv.FormatInt(article.id, 10), Title: article.title,
			Subtitle: &subtitle, At: httpx.FormatISO(article.createdAt),
		})
	}
	recentThreadsJSON := make([]map[string]any, 0, len(recentThreadItems))
	for i := range recentThreadItems {
		thread := &recentThreadItems[i]
		updated := thread.updatedAt
		if updated == nil {
			createdCopy := thread.createdAt
			updated = &createdCopy
		}
		recentThreadsJSON = append(recentThreadsJSON, map[string]any{
			"id":        strconv.FormatInt(thread.id, 10),
			"title":     thread.title,
			"focus":     parseFocus(thread.focusJSON),
			"createdAt": httpx.FormatISO(thread.createdAt),
			"updatedAt": httpx.FormatISO(*updated),
		})
		title := thread.title
		if title == "" {
			title = "未命名对话"
		}
		recentActivity = append(recentActivity, activityItem{
			Kind: "thread", ID: strconv.FormatInt(thread.id, 10), Title: title,
			Subtitle: nil, At: httpx.FormatISO(*updated),
		})
	}
	recentActivity = sortActivities(recentActivity, 8)

	agentDailySeries := make([]agentDailyPoint, 0, AgentWindowDays)
	for _, date := range days[len(days)-AgentWindowDays:] {
		point := agentDailyPoint{Date: date}
		if row := agentMap[date]; row != nil {
			point.Count = row.count
			point.AvgMs = row.avgMs
			point.Errors = row.errors
		}
		agentDailySeries = append(agentDailySeries, point)
	}

	topPaths := make([]agentPathStat, 0, len(pathRows))
	for _, row := range pathRows {
		topPaths = append(topPaths, agentPathStat{
			Path: row.path, Method: row.method, Count: num(row.count),
			AvgMs: row.avgMs, ErrorCount: num(row.errorCount),
		})
	}

	toolItems := make([]toolStat, 0, len(toolRows))
	for _, row := range toolRows {
		toolItems = append(toolItems, toolStat{
			Name: row.name, Count: num(row.count), OkCount: num(row.okCount), AvgMs: row.avgMs,
		})
	}

	documents := make([]statusBucket, 0, len(docRows))
	for _, row := range docRows {
		documents = append(documents, statusBucket{Status: row.label, Count: num(row.c1)})
	}
	imports := make([]statusBucket, 0, len(importRows))
	for _, row := range importRows {
		imports = append(imports, statusBucket{Status: row.label, Count: num(row.c1)})
	}

	kbDistribution := make([]distributionItem, 0, 6)
	tagDistribution := make([]distributionItem, 0, 8)
	for _, row := range labelRows {
		item := distributionItem{Label: row.label, Count: num(row.c1)}
		switch row.bucket {
		case "kb":
			kbDistribution = append(kbDistribution, item)
		case "tag":
			tagDistribution = append(tagDistribution, item)
		}
	}

	assets := []distributionItem{
		{Label: "文章", Count: num(scalars.articles)},
		{Label: "Wiki 页面", Count: num(scalars.wikiPages)},
		{Label: "文档", Count: documentTotal},
		{Label: "图谱节点", Count: graphNodeTotal},
	}
	filteredAssets := assets[:0]
	for _, item := range assets {
		if item.Count > 0 {
			filteredAssets = append(filteredAssets, item)
		}
	}

	unitWord := "字"
	unitMinutes := "分钟"
	hintPages := itoa64(documentPages) + " 页"
	hintPublished := itoa64(graphNodePublished) + " 已发布"

	return &OverviewResponse{
		GeneratedAt: httpx.FormatISO(now),
		Kpis: kpis{
			Primary: []kpiTile{
				buildKpiTile("articles", "文章总数", num(scalars.articles), articleMap, days, nil),
				buildKpiTile("words", "累计字数", num(scalars.words), wordMap, days, &unitWord),
				buildKpiTile("threads", "助手对话", num(scalars.threads), qaMap, days, nil),
				buildKpiTile("agentCalls", "Agent 调用", num(scalars.agentCallsTotal), dayMapFrom(agentMap), days, nil),
			},
			Secondary: []statItem{
				{Key: "knowledgeBases", Label: "知识库", Value: num(scalars.knowledgeBases)},
				{Key: "wikiPages", Label: "Wiki 页面", Value: num(scalars.wikiPages)},
				{Key: "documents", Label: "文档", Value: documentTotal, Hint: &hintPages},
				{Key: "tags", Label: "标签", Value: num(scalars.tags)},
				{Key: "graphNodes", Label: "图谱节点", Value: graphNodeTotal, Hint: &hintPublished},
				{Key: "graphEdges", Label: "图谱关系", Value: num(scalars.graphEdges)},
				{Key: "readingMinutes", Label: "阅读时长", Value: num(scalars.minutes), Hint: &unitMinutes},
			},
		},
		Heatmap: heatmap{
			Points: heatmapPoints,
			Start:  firstOr(days, formatUtcDay(heatmapStart)),
			End:    lastOr(days, formatUtcDay(todayUTC)),
			Total:  heatmapTotal,
		},
		Trend:  trend,
		Growth: buildGrowth(days, articleMap, wordMap, num(scalars.articles), num(scalars.words)),
		Rhythm: rhythm{
			Cells: buildRhythmFromTriples(rhythmRows),
			Total: sumRange(articleMap, days),
		},
		Distribution: distribution{KnowledgeBases: kbDistribution, Tags: tagDistribution},
		Assets:       filteredAssets,
		Agent: agentStats{
			WindowDays:    AgentWindowDays,
			TotalCalls:    agentWindowCalls,
			SuccessCalls:  num(scalars.agentSuccess),
			ClientErrors:  num(scalars.agentClientErr),
			ServerErrors:  num(scalars.agentServerErr),
			SuccessRate:   successRate,
			AvgDurationMs: num(scalars.agentAvgMs),
			MaxDurationMs: num(scalars.agentMaxMs),
			TopPaths:      topPaths,
			Daily:         agentDailySeries,
		},
		Tools: toolsStats{WindowDays: AgentWindowDays, Items: toolItems},
		Pipeline: pipeline{
			Documents:     documents,
			Imports:       imports,
			DocumentTotal: documentTotal,
			DocumentBytes: documentBytes,
			DocumentPages: documentPages,
			ImportTotal:   importTotal,
		},
		RecentActivity: recentActivity,
		RecentThreads:  recentThreadsJSON,
	}, nil
}

// agentDaily Agent 按天聚合值。
type agentDaily struct {
	count  int64
	avgMs  int64
	errors int64
}

// rhythmTriple 创作节律分桶行。
type rhythmTriple struct {
	weekday int64
	hour    int64
	count   int64
}

// recentArticle 最近文章条目。
type recentArticle struct {
	id        int64
	title     string
	kbName    string
	createdAt time.Time
}

// threadSummary 最近助手会话条目（对应 toAssistantThreadResponse 的输入）。
type threadSummary struct {
	id        int64
	title     string
	focusJSON *string
	createdAt time.Time
	updatedAt *time.Time
}

// collectRows 执行查询并逐行扫描到目标切片；任何一步出错都向上传播。
func collectRows[T any](dst *[]T, query func() (rowScanner, error), scan func(rowScanner) (T, error)) error {
	rows, err := query()
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		item, serr := scan(rows)
		if serr != nil {
			return serr
		}
		*dst = append(*dst, item)
	}
	return rows.Err()
}

func dayMapFrom(agentMap map[string]*agentDaily) map[string]int64 {
	out := map[string]int64{}
	for day, row := range agentMap {
		out[day] = row.count
	}
	return out
}

func filterLabelRows(rows []labelRow, bucket string) []labelRow {
	out := []labelRow{}
	for _, row := range rows {
		if row.bucket == bucket {
			out = append(out, row)
		}
	}
	return out
}

// parseFocus 对应 parseAssistantFocus：非法或非对象返回 nil。
func parseFocus(raw *string) any {
	if raw == nil || trimSpaces(*raw) == "" {
		return nil
	}
	var parsed map[string]any
	if jsonUnmarshal([]byte(*raw), &parsed) != nil {
		return nil
	}
	return parsed
}
