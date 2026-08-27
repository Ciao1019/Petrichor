package publicapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"time"

	"petrichor/api/internal/aicore"
	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/sitecontent"
)

type publicQaTool struct {
	definition aicore.ToolDefinition
	execute    func(context.Context, map[string]any) (any, error)
}

type publicQaToolSet struct {
	scope map[int64]*PublicArticleRef
	items []publicQaTool
}

func qaToolDefinition(name, description, schema string) aicore.ToolDefinition {
	return aicore.ToolDefinition{Name: name, Description: description, Parameters: json.RawMessage(schema)}
}

func (set *publicQaToolSet) definitions() []aicore.ToolDefinition {
	definitions := make([]aicore.ToolDefinition, 0, len(set.items))
	for _, tool := range set.items {
		definitions = append(definitions, tool.definition)
	}
	return definitions
}

func (set *publicQaToolSet) execute(ctx context.Context, name string, args map[string]any) (any, error) {
	for _, tool := range set.items {
		if tool.definition.Name == name {
			return tool.execute(ctx, args)
		}
	}
	return nil, badReq("未知公开问答工具")
}

func buildPublicQaTools(scope map[int64]*PublicArticleRef, mode string) *publicQaToolSet {
	set := &publicQaToolSet{scope: scope}
	uiTools := []publicQaTool{
		{
			definition: qaToolDefinition("show_agent_plan", "多步检索时展示执行计划。", `{"type":"object","properties":{"title":{"type":"string"},"description":{"type":"string"},"todos":{"type":"array","items":{"type":"object"}}},"required":["todos"]}`),
			execute: func(_ context.Context, args map[string]any) (any, error) {
				return map[string]any{"id": "plan-" + strconv.FormatInt(time.Now().UnixMilli(), 10), "title": args["title"], "description": args["description"], "todos": args["todos"]}, nil
			},
		},
		{
			definition: qaToolDefinition("show_progress", "展示当前检索、阅读、分析进度。", `{"type":"object","properties":{"title":{"type":"string"},"description":{"type":"string"},"steps":{"type":"array","items":{"type":"object"}}},"required":["steps"]}`),
			execute: func(_ context.Context, args map[string]any) (any, error) {
				return map[string]any{"id": "progress-" + strconv.FormatInt(time.Now().UnixMilli(), 10), "title": args["title"], "description": args["description"], "steps": args["steps"]}, nil
			},
		},
		{
			definition: qaToolDefinition("show_citations", "展示最终答案实际使用的公开文章或 Wiki 引用。", `{"type":"object","properties":{"citations":{"type":"array","minItems":1,"items":{"type":"object","properties":{"id":{"type":"string"},"href":{"type":"string"},"title":{"type":"string"},"snippet":{"type":"string"},"type":{"type":"string"}},"required":["id","href","title"]}}},"required":["citations"]}`),
			execute: func(_ context.Context, args map[string]any) (any, error) {
				return map[string]any{"id": "citations-" + strconv.FormatInt(time.Now().UnixMilli(), 10), "citations": args["citations"], "variant": "default"}, nil
			},
		},
		{
			definition: qaToolDefinition("show_data_table", "为结构化对比、清单或矩阵展示表格。", `{"type":"object","properties":{"title":{"type":"string"},"columns":{"type":"array","minItems":1,"items":{"type":"object"}},"data":{"type":"array","items":{"type":"object"}}},"required":["columns","data"]}`),
			execute: func(_ context.Context, args map[string]any) (any, error) {
				return map[string]any{"id": "table-" + strconv.FormatInt(time.Now().UnixMilli(), 10), "title": args["title"], "columns": args["columns"], "data": args["data"], "emptyMessage": "暂无数据"}, nil
			},
		},
	}

	if mode == qaModeWiki {
		set.items = append(set.items, uiTools[:2]...)
		set.items = append(set.items,
			publicQaTool{
				definition: qaToolDefinition("wiki_overview", "列出本站公开 Wiki 的分组概览。回答内容型问题时先用它掌握全貌。", `{"type":"object","properties":{}}`),
				execute:    func(ctx context.Context, _ map[string]any) (any, error) { return listPublicQaWikiOverview(ctx, scope) },
			},
			publicQaTool{
				definition: qaToolDefinition("search_wiki_pages", "在公开 Wiki 页面中用多个同义关键词检索，返回真实 pageKey、摘要和命中片段。", `{"type":"object","properties":{"queries":{"type":"array","minItems":1,"maxItems":6,"items":{"type":"string","minLength":1}},"limit":{"type":"integer","minimum":1,"maximum":20}},"required":["queries"]}`),
				execute:    func(ctx context.Context, args map[string]any) (any, error) { return searchPublicQaWikiTool(ctx, args) },
			},
			publicQaTool{
				definition: qaToolDefinition("read_wiki_page_detail", "按真实 pageKey 读取公开 Wiki 全文、关联页面与来源文章。", `{"type":"object","properties":{"pageKey":{"type":"string","minLength":1}},"required":["pageKey"]}`),
				execute: func(ctx context.Context, args map[string]any) (any, error) {
					return readPublicQaWikiDetail(ctx, scope, qaRequiredString(args, "pageKey", 200))
				},
			},
		)
		set.items = append(set.items, uiTools[2:]...)
		return set
	}

	set.items = append(set.items, uiTools[:2]...)
	set.items = append(set.items,
		publicQaTool{
			definition: qaToolDefinition("list_public_articles", "列出本站全部公开可访问文章，适合回答公开文章目录类问题。", `{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":50},"offset":{"type":"integer","minimum":0}}}`),
			execute: func(ctx context.Context, args map[string]any) (any, error) {
				return listPublicQaArticles(ctx, qaBoundedInt(args, "limit", 30, 1, 50), qaBoundedInt(args, "offset", 0, 0, 100000))
			},
		},
		publicQaTool{
			definition: qaToolDefinition("search_knowledge_graph", "在公开全站星图上检索概念/实体关系与关联公开文章，适合关联型问题。", `{"type":"object","properties":{"query":{"type":"string","minLength":1},"maxHops":{"type":"integer","minimum":1,"maximum":3},"limit":{"type":"integer","minimum":1,"maximum":10}},"required":["query"]}`),
			execute:    func(ctx context.Context, args map[string]any) (any, error) { return searchPublicQaGraph(ctx, args) },
		},
		publicQaTool{
			definition: qaToolDefinition("search_public_articles", "在公开文章标题、摘要和正文中检索，返回 articleId、shareCode、摘要与公开链接。", `{"type":"object","properties":{"query":{"type":"string","minLength":1},"limit":{"type":"integer","minimum":1,"maximum":20}},"required":["query"]}`),
			execute: func(ctx context.Context, args map[string]any) (any, error) {
				return searchPublicQaArticlesTool(ctx, args)
			},
		},
		publicQaTool{
			definition: qaToolDefinition("search_document_tree", "在一篇公开文章的目录树中定位最相关章节；需传 search_public_articles 返回的 articleId。", `{"type":"object","properties":{"articleId":{"oneOf":[{"type":"string"},{"type":"integer"}]},"query":{"type":"string","minLength":1},"limit":{"type":"integer","minimum":1,"maximum":12}},"required":["articleId","query"]}`),
			execute: func(ctx context.Context, args map[string]any) (any, error) {
				return searchPublicQaTree(ctx, scope, args)
			},
		},
		publicQaTool{
			definition: qaToolDefinition("read_tree_node", "按 nodeKey 读取公开文章目录节点全文。", `{"type":"object","properties":{"nodeKey":{"type":"string","minLength":1}},"required":["nodeKey"]}`),
			execute: func(ctx context.Context, args map[string]any) (any, error) {
				return readPublicQaTreeNode(ctx, scope, qaRequiredString(args, "nodeKey", 300))
			},
		},
		publicQaTool{
			definition: qaToolDefinition("read_wiki_page", "读取文章级公开 Wiki 页面，pageKey 形如 source-<articleId>。", `{"type":"object","properties":{"pageKey":{"type":"string","minLength":1}},"required":["pageKey"]}`),
			execute: func(ctx context.Context, args map[string]any) (any, error) {
				return readPublicQaSourceWiki(ctx, scope, qaRequiredString(args, "pageKey", 200))
			},
		},
		publicQaTool{
			definition: qaToolDefinition("read_source_article", "读取一篇公开文章源文档全文与公开链接。", `{"type":"object","properties":{"articleId":{"oneOf":[{"type":"string"},{"type":"integer"}]}},"required":["articleId"]}`),
			execute: func(ctx context.Context, args map[string]any) (any, error) {
				return readPublicQaSourceArticle(ctx, scope, qaRequiredID(args, "articleId"))
			},
		},
	)
	set.items = append(set.items, uiTools[2:]...)
	return set
}

func qaRequiredString(args map[string]any, key string, max int) string {
	value, _ := args[key].(string)
	value = strings.TrimSpace(value)
	if max > 0 && len([]rune(value)) > max {
		value = string([]rune(value)[:max])
	}
	return value
}

func qaBoundedInt(args map[string]any, key string, fallback, min, max int) int {
	value := fallback
	switch typed := args[key].(type) {
	case float64:
		value = int(typed)
	case int:
		value = typed
	case string:
		if parsed, err := strconv.Atoi(strings.TrimSpace(typed)); err == nil {
			value = parsed
		}
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func qaRequiredID(args map[string]any, key string) int64 {
	switch typed := args[key].(type) {
	case float64:
		if typed > 0 && typed == float64(int64(typed)) {
			return int64(typed)
		}
	case int:
		if typed > 0 {
			return int64(typed)
		}
	case string:
		if parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64); err == nil && parsed > 0 {
			return parsed
		}
	}
	return 0
}

func requirePublicQaArticle(scope map[int64]*PublicArticleRef, articleID int64) (*PublicArticleRef, error) {
	if articleID <= 0 {
		return nil, badReq("articleId 必须是正整数")
	}
	ref := scope[articleID]
	if ref == nil {
		return nil, notFoundErr("该文章不在公开范围内")
	}
	return ref, nil
}

func listPublicQaArticles(ctx context.Context, limit, offset int) (map[string]any, error) {
	var total int64
	if err := pool().QueryRow(ctx,
		`SELECT count(*) FROM petrichor_kb_article_share s
		 JOIN petrichor_kb_article a ON a.id = s.article_id
		 WHERE `+publicShareVisibilityWhere).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := pool().Query(ctx,
		`SELECT a.id, a.title, s.share_code,
		 coalesce(nullif(btrim(a.ai_summary), ''), coalesce(a.public_excerpt, '')), a.updated_at
		 FROM petrichor_kb_article_share s
		 JOIN petrichor_kb_article a ON a.id = s.article_id
		 WHERE `+publicShareVisibilityWhere+`
		 ORDER BY s.pin_order IS NULL, s.pin_order DESC, a.updated_at DESC, s.id DESC
		 LIMIT $1 OFFSET $2`, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var articleID int64
		var title, shareCode, snippet string
		var updatedAt time.Time
		if err := rows.Scan(&articleID, &title, &shareCode, &snippet, &updatedAt); err != nil {
			return nil, err
		}
		items = append(items, map[string]any{
			"articleId": strconv.FormatInt(articleID, 10), "shareCode": shareCode,
			"href": "/p/" + shareCode, "title": title, "snippet": snippet,
			"updatedAt": httpx.FormatISO(updatedAt),
		})
	}
	result := map[string]any{"total": total, "items": items}
	if total == 0 {
		result["emptyMessage"] = "本站暂无公开文章"
	}
	return result, rows.Err()
}

func searchPublicQaArticlesTool(ctx context.Context, args map[string]any) (map[string]any, error) {
	query := qaRequiredString(args, "query", 200)
	if query == "" {
		return nil, badReq("query 不能为空")
	}
	hits, err := searchPublicQaArticles(ctx, query, int64(qaBoundedInt(args, "limit", 8, 1, 20)))
	if err != nil {
		return nil, err
	}
	items := make([]map[string]any, 0, len(hits))
	for _, hit := range hits {
		items = append(items, map[string]any{
			"articleId": strconv.FormatInt(hit.articleID, 10), "shareCode": hit.shareCode,
			"href": "/p/" + hit.shareCode, "title": hit.title, "snippet": hit.excerpt,
		})
	}
	return map[string]any{"query": query, "items": items, "emptyMessage": "没有匹配的公开文章"}, nil
}

func searchPublicQaTree(ctx context.Context, scope map[int64]*PublicArticleRef, args map[string]any) (map[string]any, error) {
	articleID := qaRequiredID(args, "articleId")
	ref, err := requirePublicQaArticle(scope, articleID)
	if err != nil {
		return nil, err
	}
	query := qaRequiredString(args, "query", 200)
	if query == "" {
		return nil, badReq("query 不能为空")
	}
	limit := qaBoundedInt(args, "limit", 6, 1, 12)
	like := "%" + escapeLikePattern(query) + "%"
	rows, err := pool().Query(ctx,
		`SELECT node_key, title, coalesce(summary, ''), content_md, depth,
		 (similarity(title, $5) * 4 + similarity(coalesce(summary, ''), $5) * 2 + similarity(content_md, $5)) AS score
		 FROM petrichor_kb_wiki_tree_node
		 WHERE user_id = $1 AND knowledge_base_id = $2 AND article_id = $3
		   AND (title ILIKE $4 OR coalesce(summary, '') ILIKE $4 OR content_md ILIKE $4)
		 ORDER BY score DESC, position ASC LIMIT $6`,
		ref.UserID, ref.KnowledgeBaseID, articleID, like, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var nodeKey, title, summary, content string
		var depth int32
		var score float64
		if err := rows.Scan(&nodeKey, &title, &summary, &content, &depth, &score); err != nil {
			return nil, err
		}
		items = append(items, map[string]any{
			"nodeKey": nodeKey, "articleId": strconv.FormatInt(articleID, 10), "title": title,
			"path": []string{ref.Title, title}, "summary": summary,
			"contentMd": clipQaText(content, qaContextChars), "depth": depth,
		})
	}
	return map[string]any{"articleId": strconv.FormatInt(articleID, 10), "items": items, "emptyMessage": "没有匹配的目录章节"}, rows.Err()
}

func readPublicQaTreeNode(ctx context.Context, scope map[int64]*PublicArticleRef, nodeKey string) (map[string]any, error) {
	if nodeKey == "" {
		return nil, badReq("nodeKey 不能为空")
	}
	rows, err := pool().Query(ctx,
		`SELECT user_id, knowledge_base_id, article_id, title, coalesce(summary, ''), content_md, depth
		 FROM petrichor_kb_wiki_tree_node WHERE node_key = $1 ORDER BY id ASC`, nodeKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var userID, kbID, articleID int64
		var title, summary, content string
		var depth int32
		if err := rows.Scan(&userID, &kbID, &articleID, &title, &summary, &content, &depth); err != nil {
			return nil, err
		}
		ref := scope[articleID]
		if ref == nil || ref.UserID != userID || ref.KnowledgeBaseID != kbID {
			continue
		}
		return map[string]any{
			"nodeKey": nodeKey, "articleId": strconv.FormatInt(articleID, 10), "title": title,
			"path": []string{ref.Title, title}, "summary": summary, "contentMd": content,
			"depth": depth, "href": "/p/" + ref.ShareCode,
		}, nil
	}
	return nil, notFoundErr("目录节点不存在或不在公开范围内")
}

func readPublicQaSourceWiki(ctx context.Context, scope map[int64]*PublicArticleRef, pageKey string) (map[string]any, error) {
	if !strings.HasPrefix(pageKey, "source-") {
		return nil, badReq("公开问答仅支持读取文章级 Wiki 页面")
	}
	articleID, err := strconv.ParseInt(strings.TrimPrefix(pageKey, "source-"), 10, 64)
	if err != nil {
		return nil, badReq("pageKey 格式错误")
	}
	if _, err := requirePublicQaArticle(scope, articleID); err != nil {
		return nil, err
	}
	return readPublicQaWikiDetail(ctx, scope, pageKey)
}

func readPublicQaWikiDetail(ctx context.Context, scope map[int64]*PublicArticleRef, pageKey string) (map[string]any, error) {
	if pageKey == "" {
		return nil, badReq("pageKey 不能为空")
	}
	page, err := resolveAccessiblePage(ctx, scope, pageKey)
	if err != nil {
		return nil, err
	}
	return readPublicWikiPageDetail(ctx, scope, page)
}

func readPublicQaSourceArticle(ctx context.Context, scope map[int64]*PublicArticleRef, articleID int64) (map[string]any, error) {
	ref, err := requirePublicQaArticle(scope, articleID)
	if err != nil {
		return nil, err
	}
	var title, content string
	if err := pool().QueryRow(ctx,
		`SELECT title, content_md FROM petrichor_kb_article
		 WHERE id = $1 AND user_id = $2 AND knowledge_base_id = $3`,
		articleID, ref.UserID, ref.KnowledgeBaseID).Scan(&title, &content); err != nil {
		return nil, err
	}
	return map[string]any{
		"articleId": strconv.FormatInt(articleID, 10), "title": title, "contentMd": content,
		"shareCode": ref.ShareCode, "href": "/p/" + ref.ShareCode,
	}, nil
}

func listPublicQaWikiOverview(ctx context.Context, scope map[int64]*PublicArticleRef) (map[string]any, error) {
	articleIDs := make([]int64, 0, len(scope))
	for id := range scope {
		articleIDs = append(articleIDs, id)
	}
	if len(articleIDs) == 0 {
		return map[string]any{"total": 0, "topics": []any{}, "sources": []any{}, "emptyMessage": "本站暂无公开的 Wiki 页面"}, nil
	}
	rows, err := pool().Query(ctx,
		`SELECT DISTINCT p.id, p.user_id, p.knowledge_base_id, p.page_key, p.title, p.kind,
		 p.content_md, p.frontmatter_json, p.summary
		 FROM petrichor_kb_wiki_page p
		 JOIN petrichor_kb_wiki_source_ref r ON r.page_id = p.id
		 WHERE r.article_id = ANY($1) AND p.archived_at IS NULL
		 ORDER BY p.title ASC`, articleIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	topics := []map[string]any{}
	sources := []map[string]any{}
	seen := map[int64]struct{}{}
	for rows.Next() {
		page, err := scanWikiPage(rows)
		if err != nil {
			return nil, err
		}
		if _, exists := seen[page.id]; exists {
			continue
		}
		seen[page.id] = struct{}{}
		card := toWikiQaCard(page)
		if page.kind == "source" {
			sources = append(sources, card)
		} else {
			topics = append(topics, card)
		}
	}
	return map[string]any{"total": len(topics) + len(sources), "topics": topics, "sources": sources}, rows.Err()
}

func searchPublicQaWikiTool(ctx context.Context, args map[string]any) (map[string]any, error) {
	limit := qaBoundedInt(args, "limit", 8, 1, 20)
	queries := []string{}
	if raw, ok := args["queries"].([]any); ok {
		for _, item := range raw {
			if query, ok := item.(string); ok && strings.TrimSpace(query) != "" {
				queries = append(queries, strings.TrimSpace(query))
			}
		}
	}
	if typed, ok := args["queries"].([]string); ok {
		queries = append(queries, typed...)
	}
	if len(queries) == 0 {
		return nil, badReq("queries 不能为空")
	}
	items := []map[string]any{}
	seen := map[string]struct{}{}
	for _, query := range queries {
		hits, err := searchPublicQaWikiPages(ctx, query, int64(limit))
		if err != nil {
			return nil, err
		}
		for _, hit := range hits {
			if _, exists := seen[hit.pageKey]; exists {
				continue
			}
			seen[hit.pageKey] = struct{}{}
			items = append(items, map[string]any{
				"pageKey": hit.pageKey, "title": hit.title, "kind": hit.kind,
				"summary": hit.summary, "snippet": extractWikiMatchSnippet(hit.contentMd, query, 180),
			})
			if len(items) >= limit {
				break
			}
		}
		if len(items) >= limit {
			break
		}
	}
	return map[string]any{"queries": queries, "items": items, "emptyMessage": "没有匹配的 Wiki 页面"}, nil
}

func searchPublicQaGraph(ctx context.Context, args map[string]any) (map[string]any, error) {
	query := strings.ToLower(qaRequiredString(args, "query", 200))
	if query == "" {
		return nil, badReq("query 不能为空")
	}
	maxHops := qaBoundedInt(args, "maxHops", 2, 1, 3)
	limit := qaBoundedInt(args, "limit", 6, 1, 10)
	payload, err := sitecontent.LoadPublicGraphPayload(ctx)
	if err != nil {
		return nil, err
	}
	type scoredNode struct {
		node  sitecontent.PayloadNode
		score int
	}
	ranked := []scoredNode{}
	for _, node := range payload.Nodes {
		haystack := strings.ToLower(node.Label + " " + node.Summary + " " + strings.Join(node.Aliases, " "))
		score := 0
		if strings.Contains(strings.ToLower(node.Label), query) {
			score += 10
		}
		if strings.Contains(haystack, query) {
			score += 4
		}
		for _, term := range strings.Fields(query) {
			if len([]rune(term)) >= 2 && strings.Contains(haystack, term) {
				score++
			}
		}
		if score > 0 {
			ranked = append(ranked, scoredNode{node: node, score: score})
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].score > ranked[j].score })
	if len(ranked) > limit {
		ranked = ranked[:limit]
	}
	selected := map[string]struct{}{}
	frontier := map[string]struct{}{}
	for _, item := range ranked {
		selected[item.node.ID] = struct{}{}
		frontier[item.node.ID] = struct{}{}
	}
	keptLinks := []sitecontent.PayloadLink{}
	for hop := 0; hop < maxHops; hop++ {
		next := map[string]struct{}{}
		for _, link := range payload.Links {
			_, from := frontier[link.Source]
			_, to := frontier[link.Target]
			if !from && !to {
				continue
			}
			keptLinks = append(keptLinks, link)
			selected[link.Source] = struct{}{}
			selected[link.Target] = struct{}{}
			if from {
				next[link.Target] = struct{}{}
			}
			if to {
				next[link.Source] = struct{}{}
			}
		}
		frontier = next
	}
	nodes := []sitecontent.PayloadNode{}
	articles := []map[string]any{}
	for _, node := range payload.Nodes {
		if _, exists := selected[node.ID]; !exists {
			continue
		}
		nodes = append(nodes, node)
		if node.Kind == "article" && node.Route != nil {
			articles = append(articles, map[string]any{"id": node.ID, "title": node.Label, "href": *node.Route, "summary": node.Summary})
		}
	}
	matches := make([]map[string]any, 0, len(ranked))
	for _, item := range ranked {
		matches = append(matches, map[string]any{"id": item.node.ID, "label": item.node.Label, "kind": item.node.Kind, "summary": item.node.Summary, "score": item.score})
	}
	return map[string]any{"query": query, "matches": matches, "nodes": nodes, "links": keptLinks, "articles": articles}, nil
}

func publicQaToolError(err error) string {
	if err == nil {
		return ""
	}
	var httpErr *httpx.HttpError
	if errors.As(err, &httpErr) && httpErr.Status < 500 {
		return httpErr.Message
	}
	slog.Warn("公开问答工具执行失败", "err", err)
	return "工具执行失败，请换一种检索方式"
}

func marshalPublicQaToolOutput(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		return `{"error":"工具结果序列化失败"}`
	}
	const maxRunes = 30000
	if len([]rune(string(raw))) <= maxRunes {
		return string(raw)
	}
	text := string([]rune(string(raw))[:maxRunes])
	clipped, _ := json.Marshal(map[string]any{"truncated": true, "content": text})
	return string(clipped)
}

func parsePublicQaToolArgs(raw string) (map[string]any, error) {
	args := map[string]any{}
	if strings.TrimSpace(raw) == "" {
		return args, nil
	}
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return nil, badReq("工具参数不是合法 JSON")
	}
	return args, nil
}
