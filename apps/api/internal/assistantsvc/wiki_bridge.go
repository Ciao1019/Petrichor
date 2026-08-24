package assistantsvc

// wiki_bridge.go 助手 Wiki 问答检索层（对照 kb/wiki-qa-user.ts + wiki-qa-core.ts）。
//
// 与 TS 一致的语义：
// - 未指定 knowledgeBaseId 时跨用户全部知识库检索；
// - 多关键词打分：标题 +4、摘要/别名 +2、正文 +1（附命中片段）；
// - pageKey 跨库同名时优先指定库，否则取最早创建的页面。

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"petrichor/api/internal/db"
)

// wikiPageRecord 页面记录（petrichor_kb_wiki_page 行的子集）。
type wikiPageRecord struct {
	ID              int64
	UserID          int64
	KnowledgeBaseID int64
	PageKey         string
	Title           string
	Kind            string
	ContentMd       string
	Summary         *string
	FrontmatterJSON *string
	UpdatedAtUnix   int64
}

const wikiPageColumns = `id, user_id, knowledge_base_id, page_key, title, kind, content_md, summary, frontmatter_json, updated_at`

func scanWikiPageRows(rows interface {
	Next() bool
	Scan(dest ...any) error
}) []wikiPageRecord {
	pages := []wikiPageRecord{}
	for rows.Next() {
		var p wikiPageRecord
		if err := rows.Scan(&p.ID, &p.UserID, &p.KnowledgeBaseID, &p.PageKey, &p.Title, &p.Kind,
			&p.ContentMd, &p.Summary, &p.FrontmatterJSON, &p.UpdatedAtUnix); err != nil {
			continue
		}
		pages = append(pages, p)
	}
	return pages
}

// listAccessibleWikiPages 用户名下全部可用页面（跨库；log 页不参与；未归档）。
func listAccessibleWikiPages(ctx context.Context, userID int64, knowledgeBaseID int64) []wikiPageRecord {
	sql := `SELECT id, user_id, knowledge_base_id, page_key, title, kind,
			       content_md, summary, frontmatter_json,
			       COALESCE(EXTRACT(EPOCH FROM updated_at)::bigint, 0)
		 FROM petrichor_kb_wiki_page
		 WHERE user_id = $1 AND archived_at IS NULL AND kind <> 'log'`
	args := []any{userID}
	if knowledgeBaseID > 0 {
		sql += ` AND knowledge_base_id = $2`
		args = append(args, knowledgeBaseID)
	}
	rows, err := db.Pool().Query(ctx, sql, args...)
	if err != nil {
		return nil
	}
	defer rows.Close()
	return scanWikiPageRows(rows)
}

// readFrontmatterAliases 从 frontmatter_json 读 aliases 数组。
func bridgeFrontmatterAliases(raw *string) []string {
	if raw == nil || *raw == "" {
		return nil
	}
	var fm struct {
		Aliases []any `json:"aliases"`
	}
	if json.Unmarshal([]byte(*raw), &fm) != nil {
		return nil
	}
	out := make([]string, 0, len(fm.Aliases))
	for _, a := range fm.Aliases {
		if s, ok := a.(string); ok && trimSpace(s) != "" {
			out = append(out, s)
		}
	}
	return out
}

func bridgeSummarizeContent(contentMd string, maxLength int) string {
	var flatBuilder strings.Builder
	lastSpace := false
	for _, r := range contentMd {
		if r == '\n' || r == '\r' || r == '\t' {
			r = ' '
		}
		if r == ' ' {
			if lastSpace {
				continue
			}
			lastSpace = true
		} else {
			lastSpace = false
		}
		flatBuilder.WriteRune(r)
	}
	flat := strings.TrimSpace(flatBuilder.String())
	runes := []rune(flat)
	if len(runes) <= maxLength {
		return flat
	}
	return string(runes[:maxLength])
}

// extractMatchSnippet 从 markdown 原文提取命中片段（前后各留 ~60 字上下文）。
func extractMatchSnippet(contentMd, query string) string {
	lowerContent := strings.ToLower(contentMd)
	idx := strings.Index(lowerContent, strings.ToLower(query))
	if idx < 0 {
		return ""
	}
	runes := []rune(contentMd)
	byteIdx := len(string(contentMd[:idx]))
	pos := len([]rune(string(contentMd[:idx])))
	_ = byteIdx
	start := pos - 60
	if start < 0 {
		start = 0
	}
	end := pos + len([]rune(query)) + 60
	if end > len(runes) {
		end = len(runes)
	}
	return string(runes[start:end])
}

type wikiSearchHit struct {
	page    wikiPageRecord
	score   float64
	snippet string
}

func wikiCard(page wikiPageRecord) map[string]any {
	summary := ""
	if page.Summary != nil {
		summary = strings.TrimSpace(*page.Summary)
	}
	if summary == "" {
		summary = bridgeSummarizeContent(page.ContentMd, 160)
	}
	return map[string]any{
		"pageKey":         page.PageKey,
		"title":           page.Title,
		"kind":            page.Kind,
		"aliases":         bridgeFrontmatterAliases(page.FrontmatterJSON),
		"summary":         summary,
		"knowledgeBaseId": fmt.Sprintf("%d", page.KnowledgeBaseID),
	}
}

// rankWikiPagesForQueries 多关键词打分：每个词独立算分后取该页面最好成绩。
func rankWikiPagesForQueries(pages []wikiPageRecord, queries []string, limit int) []map[string]any {
	type scored struct {
		page    wikiPageRecord
		score   float64
		snippet string
	}
	list := make([]scored, 0, len(pages))
	for _, page := range pages {
		contentFlat := bridgeSummarizeContent(page.ContentMd, 4000)
		aliases := bridgeFrontmatterAliases(page.FrontmatterJSON)
		var best *scored
		for _, query := range queries {
			normalized := strings.ToLower(strings.TrimSpace(query))
			if normalized == "" {
				continue
			}
			score := float64(0)
			snippet := ""
			if strings.Contains(strings.ToLower(page.Title), normalized) {
				score += 4
			}
			summary := ""
			if page.Summary != nil {
				summary = *page.Summary
			}
			if strings.Contains(strings.ToLower(summary), normalized) {
				score += 2
			}
			for _, alias := range aliases {
				if strings.Contains(strings.ToLower(alias), normalized) {
					score += 2
					break
				}
			}
			if strings.Contains(strings.ToLower(contentFlat), normalized) {
				score += 1
				snippet = extractMatchSnippet(page.ContentMd, strings.TrimSpace(query))
			}
			if score > 0 && (best == nil || score > best.score) {
				best = &scored{page: page, score: score, snippet: snippet}
			}
		}
		if best != nil {
			list = append(list, *best)
		}
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].score > list[j].score })
	if len(list) > limit {
		list = list[:limit]
	}
	items := make([]map[string]any, 0, len(list))
	for _, item := range list {
		card := wikiCard(item.page)
		snippet := item.snippet
		if snippet == "" {
			snippet = bridgeSummarizeContent(item.page.ContentMd, 140)
		}
		card["snippet"] = snippet
		items = append(items, card)
	}
	return items
}

// isWikiTopicKind 主题知识页类型。
func isWikiTopicKind(kind string) bool {
	switch kind {
	case "concept", "entity", "compare", "answer":
		return true
	}
	return false
}

// kbListWikiOverview 概览分组：主题知识页在前、源文档页在后，按更新时间倒序。
func kbListWikiOverview(ctx context.Context, userID, knowledgeBaseID int64) map[string]any {
	pages := listAccessibleWikiPages(ctx, userID, knowledgeBaseID)
	topics := []map[string]any{}
	sources := []map[string]any{}
	sort.SliceStable(pages, func(i, j int) bool { return pages[i].UpdatedAtUnix > pages[j].UpdatedAtUnix })
	for _, page := range pages {
		if isWikiTopicKind(page.Kind) {
			topics = append(topics, wikiCard(page))
		} else if page.Kind == "source" {
			sources = append(sources, wikiCard(page))
		}
	}
	return map[string]any{
		"groups": []map[string]any{
			{"key": "topics", "label": "主题与知识", "pages": topics},
			{"key": "sources", "label": "源文档", "pages": sources},
		},
		"total": len(topics) + len(sources),
	}
}

// kbSearchWikiPages 多关键词检索（未指定库时跨用户全部知识库）。
func kbSearchWikiPages(ctx context.Context, userID, knowledgeBaseID int64, queries []string, limit int) ([]string, []map[string]any) {
	cleaned := make([]string, 0, len(queries))
	for _, q := range queries {
		q = strings.TrimSpace(q)
		if q != "" {
			cleaned = append(cleaned, q)
		}
		if len(cleaned) >= 6 {
			break
		}
	}
	if len(cleaned) == 0 {
		return cleaned, []map[string]any{}
	}
	if limit <= 0 {
		limit = 8
	}
	if limit > 20 {
		limit = 20
	}
	pages := listAccessibleWikiPages(ctx, userID, knowledgeBaseID)
	return cleaned, rankWikiPagesForQueries(pages, cleaned, limit)
}

// kbWikiPageDetailByPageKey 按 pageKey 读详情：同名跨库时优先指定库，否则取最早创建。
func kbWikiPageDetailByPageKey(ctx context.Context, userID, knowledgeBaseID int64, pageKey string) (map[string]any, error) {
	sql := `SELECT id, user_id, knowledge_base_id, page_key, title, kind,
			       content_md, summary, frontmatter_json,
			       COALESCE(EXTRACT(EPOCH FROM updated_at)::bigint, 0)
		 FROM petrichor_kb_wiki_page
		 WHERE user_id = $1 AND page_key = $2 AND archived_at IS NULL
		 ORDER BY id ASC LIMIT 20`
	rows, err := db.Pool().Query(ctx, sql, userID, strings.TrimSpace(pageKey))
	if err != nil {
		return nil, err
	}
	pages := scanWikiPageRows(rows)
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(pages) == 0 {
		return nil, fmt.Errorf("Wiki 页面不存在")
	}
	page := pages[0]
	if knowledgeBaseID > 0 {
		for _, p := range pages {
			if p.KnowledgeBaseID == knowledgeBaseID {
				page = p
				break
			}
		}
	}
	detail := wikiCard(page)
	detail["contentMd"] = page.ContentMd
	detail["sourceArticles"] = bridgeLoadSourceArticles(ctx, page.ID)
	detail["links"] = loadWikiNeighborPages(ctx, page, "out")
	detail["inLinks"] = loadWikiNeighborPages(ctx, page, "in")
	return detail, nil
}

// loadWikiSourceArticles 来源文章（petrichor_kb_wiki_source_ref → article 标题）。
func bridgeLoadSourceArticles(ctx context.Context, pageID int64) []map[string]any {
	rows, err := db.Pool().Query(ctx,
		`SELECT r.article_id, COALESCE(a.title, ''), r.note
		 FROM petrichor_kb_wiki_source_ref r
		 LEFT JOIN petrichor_kb_article a ON a.id = r.article_id
		 WHERE r.page_id = $1 ORDER BY r.id ASC`, pageID)
	if err != nil {
		return []map[string]any{}
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var articleID int64
		var title string
		var note *string
		if err := rows.Scan(&articleID, &title, &note); err != nil {
			continue
		}
		entry := map[string]any{
			"articleId": fmt.Sprintf("%d", articleID),
			"title":     title,
		}
		if note != nil {
			entry["note"] = *note
		}
		out = append(out, entry)
	}
	return out
}

// loadWikiNeighborPages 关联页面：dir=out 出链（to_page_key），dir=in 入链（from_page_id）。
func loadWikiNeighborPages(ctx context.Context, page wikiPageRecord, dir string) []map[string]any {
	var rows interface {
		Next() bool
		Scan(dest ...any) error
		Close()
		Err() error
	}
	type linkRow struct {
		toPageKey  string
		fromPageID int64
		linkType   string
	}
	links := []linkRow{}
	if dir == "out" {
		r, err := db.Pool().Query(ctx,
			`SELECT to_page_key, 0::bigint, link_type FROM petrichor_kb_wiki_link
			 WHERE from_page_id = $1 ORDER BY to_page_key ASC`, page.ID)
		if err != nil {
			return []map[string]any{}
		}
		rows = r
	} else {
		r, err := db.Pool().Query(ctx,
			`SELECT '', from_page_id, link_type FROM petrichor_kb_wiki_link
			 WHERE user_id = $1 AND knowledge_base_id = $2 AND to_page_key = $3
			 ORDER BY from_page_id ASC`, page.UserID, page.KnowledgeBaseID, page.PageKey)
		if err != nil {
			return []map[string]any{}
		}
		rows = r
	}
	defer rows.Close()
	for rows.Next() {
		var l linkRow
		if err := rows.Scan(&l.toPageKey, &l.fromPageID, &l.linkType); err != nil {
			continue
		}
		links = append(links, l)
	}

	resolveByKeys := func(keys []string) map[string]wikiPageRecord {
		byKey := map[string]wikiPageRecord{}
		if len(keys) == 0 {
			return byKey
		}
		r, err := db.Pool().Query(ctx,
			`SELECT id, user_id, knowledge_base_id, page_key, title, kind,
			        content_md, summary, frontmatter_json,
			        COALESCE(EXTRACT(EPOCH FROM updated_at)::bigint, 0)
			 FROM petrichor_kb_wiki_page
			 WHERE user_id = $1 AND knowledge_base_id = $2 AND archived_at IS NULL
			   AND page_key = ANY($3)`,
			page.UserID, page.KnowledgeBaseID, keys)
		if err != nil {
			return byKey
		}
		defer r.Close()
		for _, p := range scanWikiPageRows(r) {
			byKey[p.PageKey] = p
		}
		return byKey
	}
	resolveByIDs := func(ids []int64) map[int64]wikiPageRecord {
		byID := map[int64]wikiPageRecord{}
		if len(ids) == 0 {
			return byID
		}
		r, err := db.Pool().Query(ctx,
			`SELECT id, user_id, knowledge_base_id, page_key, title, kind,
			        content_md, summary, frontmatter_json,
			        COALESCE(EXTRACT(EPOCH FROM updated_at)::bigint, 0)
			 FROM petrichor_kb_wiki_page
			 WHERE id = ANY($1) AND archived_at IS NULL`, ids)
		if err != nil {
			return byID
		}
		defer r.Close()
		for _, p := range scanWikiPageRows(r) {
			byID[p.ID] = p
		}
		return byID
	}

	out := make([]map[string]any, 0, len(links))
	if dir == "out" {
		keys := make([]string, 0, len(links))
		for _, l := range links {
			keys = append(keys, l.toPageKey)
		}
		byKey := resolveByKeys(keys)
		for _, l := range links {
			resolved, ok := byKey[l.toPageKey]
			entry := map[string]any{
				"pageKey":  l.toPageKey,
				"linkType": l.linkType,
			}
			if ok {
				entry["title"] = resolved.Title
				entry["kind"] = resolved.Kind
				entry["summary"] = neighborSummary(resolved)
			} else {
				entry["title"] = l.toPageKey
			}
			out = append(out, entry)
		}
	} else {
		ids := make([]int64, 0, len(links))
		for _, l := range links {
			ids = append(ids, l.fromPageID)
		}
		byID := resolveByIDs(ids)
		for _, l := range links {
			resolved, ok := byID[l.fromPageID]
			entry := map[string]any{
				"linkType": l.linkType,
			}
			if ok {
				entry["pageKey"] = resolved.PageKey
				entry["title"] = resolved.Title
				entry["kind"] = resolved.Kind
				entry["summary"] = neighborSummary(resolved)
			}
			out = append(out, entry)
		}
	}
	return out
}

func neighborSummary(p wikiPageRecord) any {
	if p.Summary != nil && strings.TrimSpace(*p.Summary) != "" {
		return strings.TrimSpace(*p.Summary)
	}
	return bridgeSummarizeContent(p.ContentMd, 120)
}
