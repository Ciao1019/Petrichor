package assistantsvc

// public_tools.go 前台公开问答档位的工具与技能注册表。
//
// 工具 ID、名称、入参与归一化器与后台助手一致，Runtime 的检索策略、计划、证据与质量门
// 因此完全相同；执行体只经 publicapi 读取匿名公开文章与安全 Wiki，不使用任何用户身份，
// 也不注册写入、记忆、文档库、系统、管理、MCP、沙箱与确认类工具。

import (
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strings"
	"sync"

	rt "petrichor/api/internal/assistantsvc/runtime"
	"petrichor/api/internal/publicapi"
)

const publicQaProfileInstructions = `## 公开问答边界

- 你正在本站前台为匿名访客回答问题，只能检索、阅读和引用本站公开文章与公开 Wiki。工具已限定在公开范围内，不存在私人知识库、文档库、长期记忆或管理能力。
- 不要声称能访问私人资料、执行写入或修改站点；公开资料里没有的内容，直接说明本站暂无相关公开资料，不要用常识补全站内事实。
- 引用链接只使用工具返回的 href（文章 /p/…，Wiki /wiki/…），不要自行拼接后台地址。`

var (
	publicQaRegistryOnce sync.Once
	publicQaToolRegistry *rt.AgentToolRegistry
	publicQaSkillCatalog *rt.SkillRegistryImpl
)

// publicQaRuntimeProfile 公开问答的 Runtime 档位（进程内构造一次）。
func publicQaRuntimeProfile() rt.RuntimeProfile {
	publicQaRegistryOnce.Do(func() {
		publicQaToolRegistry = rt.NewToolRegistry()
		publicQaSkillCatalog = rt.NewSkillRegistry()
		registerAgentMetaTools(publicQaToolRegistry)
		registerPublicKnowledgeTools(publicQaToolRegistry)
		publicQaSkillCatalog.Register(knowledgeSkill())
	})
	return rt.RuntimeProfile{Tools: publicQaToolRegistry, Skills: publicQaSkillCatalog, Instructions: publicQaProfileInstructions}
}

const publicWikiOverviewSchema = `{"type":"object","properties":{"knowledgeBaseId":{"type":"string","description":"可选，限定知识库"}}}`

const publicWikiSearchSchema = `{"type":"object","properties":{"knowledgeBaseId":{"type":"string","description":"可选，限定知识库"},"queries":{"type":"array","items":{"type":"string"},"minItems":1},"limit":{"type":"integer"}},"required":["queries"]}`

const publicWikiReadSchema = `{"type":"object","properties":{"knowledgeBaseId":{"type":"string"},"pageKey":{"type":"string"}},"required":["pageKey"]}`

func registerPublicKnowledgeTools(registry interface {
	Register(tool *rt.AgentToolDefinition)
}) {
	retrieval := []string{"retrieval"}
	wiki := []string{"wiki"}
	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.list_bases", Name: "list_knowledge_bases", Namespace: rt.NamespaceKnowledge,
		Description: "列出含公开资料的知识库（id / 名称 / 公开文章数 / Wiki 页数）。",
		InputSchema: schemaJSON(listBasesSchema), RiskLevel: rt.RiskLow, Core: true, Tags: retrieval,
		Execute: executePublicListBases,
		Normalize: func(any, any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{Summary: "已列出全部公开知识库"}
		},
	})
	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.search", Name: "search_knowledge", Namespace: rt.NamespaceKnowledge,
		Description: "检索本站公开文章与公开 Wiki，融合全文与语义召回后返回候选；不返回正文，需要证据时继续 read/read_many。",
		InputSchema: schemaJSON(searchSchema), RiskLevel: rt.RiskLow, Core: true, Tags: retrieval,
		Execute: executePublicKnowledgeSearch, Normalize: withPublicEvidenceLinks(normalizeSearchOutput),
	})
	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.lookup", Name: "lookup_knowledge", Namespace: rt.NamespaceKnowledge,
		Description: "一站式复合检索：在公开资料中混合召回并直接深读最相关的 1~2 个章节，返回独立可追溯证据。简单的定义、功能、用途、用法问题优先使用。",
		InputSchema: schemaJSON(lookupSchema), RiskLevel: rt.RiskLow, Core: true, Tags: retrieval, TimeoutMs: 60000,
		Execute: executePublicKnowledgeLookup, Normalize: withPublicEvidenceLinks(normalizeLookupOutput),
	})
	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.read_many", Name: "read_knowledge_nodes", Namespace: rt.NamespaceKnowledge,
		Description: "并行深读多个公开章节/文章/Wiki 页面，返回正文片段（含层级上下文）。",
		InputSchema: schemaJSON(readManySchema), RiskLevel: rt.RiskLow, Core: true, Tags: retrieval,
		Execute: executePublicKnowledgeReadMany, Normalize: withPublicEvidenceLinks(normalizeReadOutput),
	})
	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.read", Name: "read_knowledge_node", Namespace: rt.NamespaceKnowledge,
		Description: "深读单个公开文章、章节或 Wiki 页面，返回正文片段（含层级上下文）。只读一个明确章节时使用。",
		InputSchema: schemaJSON(readOneSchema), RiskLevel: rt.RiskLow, Core: true, Tags: retrieval,
		Execute: executePublicKnowledgeReadOne, Normalize: withPublicEvidenceLinks(normalizeReadOutput),
	})
	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.outline", Name: "read_document_outline", Namespace: rt.NamespaceKnowledge,
		Description: "读取一篇公开文章的完整目录（章节标题、层级、篇幅估算与推荐问题），不返回正文。" +
			"适合结构性问题；拿到目录后用返回的 chunkId 调 knowledge.read / read_many 深读。",
		InputSchema: schemaJSON(outlineSchema), RiskLevel: rt.RiskLow, Core: true, Tags: retrieval,
		Execute: executePublicKnowledgeOutline, Normalize: normalizeOutlineOutput,
	})
	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.wiki_overview", Name: "wiki_overview", Namespace: rt.NamespaceKnowledge,
		Description: "列出公开 Wiki 页面分组概览：主题与知识页 + 源文档页，每页含 pageKey、标题与摘要。不了解有哪些页面时先看全貌；已知道找什么就直接 search_wiki_pages。",
		InputSchema: schemaJSON(publicWikiOverviewSchema), RiskLevel: rt.RiskLow, Tags: wiki,
		Execute: executePublicWikiOverview, Normalize: normalizeWikiOverview,
	})
	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.search_wiki_pages", Name: "search_wiki_pages", Namespace: rt.NamespaceKnowledge,
		Description: "在公开 Wiki 页面里做多关键词检索：queries 一次传多个词（同义概念、别名一起搜），返回 pageKey、标题、类型、摘要与命中片段。",
		InputSchema: schemaJSON(publicWikiSearchSchema), RiskLevel: rt.RiskLow, Tags: wiki,
		Execute: executePublicWikiSearch, Normalize: normalizeWikiPageSearch,
	})
	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.read_wiki_page_detail", Name: "read_wiki_page_detail", Namespace: rt.NamespaceKnowledge,
		Description: "读公开 Wiki 页面全文（含公开可达的关联页面与来源文章），支持多跳。",
		InputSchema: schemaJSON(publicWikiReadSchema), RiskLevel: rt.RiskLow, Tags: wiki,
		Execute: executePublicWikiRead, Normalize: withPublicEvidenceLinks(normalizeWikiPageRead),
	})
}

// publicQaScope 解析知识库范围并实时加载公开资料：访客锁定知识库时工具不能越过该范围。
func publicQaScope(ctx *rt.ToolExecutionContext, params map[string]any) (*publicapi.PublicKnowledgeScope, int64, error) {
	kbID := parseID(params["knowledgeBaseId"])
	if focused, ok := focusInt(ctx.Focus, "knowledgeBaseId"); ok {
		kbID = focused
	}
	scope, err := publicapi.LoadPublicKnowledgeScope(toolContext(ctx), kbID)
	return scope, kbID, err
}

func executePublicListBases(ctx *rt.ToolExecutionContext, _ any) (any, error) {
	scope, err := publicapi.LoadPublicKnowledgeScope(toolContext(ctx), 0)
	if err != nil {
		return nil, err
	}
	bases := []map[string]any{}
	for _, base := range scope.KnowledgeBases() {
		bases = append(bases, map[string]any{
			"id": publicapi.FormatPublicID(base.ID), "name": base.Name,
			"articleCount": base.ArticleCount, "wikiPageCount": base.WikiPageCount,
		})
	}
	return map[string]any{"bases": bases}, nil
}

// publicQaRecall 多查询融合检索，按命中键去重保留最高分。
func publicQaRecall(ctx *rt.ToolExecutionContext, scope *publicapi.PublicKnowledgeScope, queries []string, kind string, limit int) ([]publicapi.PublicKnowledgeHit, publicapi.PublicRecallStats, error) {
	merged := map[string]publicapi.PublicKnowledgeHit{}
	order := []string{}
	total := publicapi.PublicRecallStats{Strategy: "fulltext"}
	for _, query := range queries {
		hits, stats, err := scope.Search(toolContext(ctx), query, kind, limit)
		if err != nil {
			return nil, total, err
		}
		if stats.Strategy == "hybrid" {
			total.Strategy = "hybrid"
		}
		total.LexicalArticle += stats.LexicalArticle
		total.LexicalWiki += stats.LexicalWiki
		total.Semantic += stats.Semantic
		for _, hit := range hits {
			key := publicQaHitKey(hit)
			if current, exists := merged[key]; !exists || hit.Score > current.Score {
				if !exists {
					order = append(order, key)
				}
				merged[key] = hit
			}
		}
	}
	out := make([]publicapi.PublicKnowledgeHit, 0, len(order))
	for _, key := range order {
		out = append(out, merged[key])
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, total, nil
}

func publicQaHitKey(hit publicapi.PublicKnowledgeHit) string {
	if hit.Type == "article" {
		return fmt.Sprintf("article:%d", hit.ArticleID)
	}
	return fmt.Sprintf("wiki:%d:%s", hit.KnowledgeBaseID, hit.PageKey)
}

func publicQaQueries(params map[string]any, primary string, withSubQueries bool) []string {
	queries := []string{primary}
	if withSubQueries {
		for _, query := range stringSliceValue(params["subQueries"]) {
			if query = strings.TrimSpace(query); query != "" && !slices.Contains(queries, query) && len(queries) < 5 {
				queries = append(queries, query)
			}
		}
	}
	return queries
}

// publicQaHitMap 输出与后台检索命中同构，额外带公开 href。
func publicQaHitMap(hit publicapi.PublicKnowledgeHit) map[string]any {
	summary := firstNonEmpty(strings.TrimSpace(hit.Snippet), strings.TrimSpace(hit.Summary))
	item := map[string]any{
		"knowledgeBaseId": publicapi.FormatPublicID(hit.KnowledgeBaseID), "knowledgeBaseName": hit.KnowledgeBaseName,
		"title": hit.Title, "summary": summary, "score": roundFloat(hit.Score),
		"recallSources": []string{"public_" + hit.Type}, "href": hit.Href,
	}
	if hit.Type == "article" {
		item["articleId"] = publicapi.FormatPublicID(hit.ArticleID)
		item["path"] = []string{hit.Title}
	} else {
		item["pageKey"], item["kind"] = hit.PageKey, hit.Kind
		item["path"] = []string{"Wiki", hit.Title}
	}
	return item
}

// publicQaDiagnostics 用各召回路命中数表达检索方式，供归一化器生成「分片语义 + 分片关键词 + Wiki 页面」说明。
func publicQaDiagnostics(stats publicapi.PublicRecallStats) map[string]any {
	diagnostics := map[string]any{"strategy": stats.Strategy, "rerankStrategy": "rrf"}
	if stats.Semantic > 0 {
		diagnostics["chunkVectorKeys"] = []string{fmt.Sprintf("semantic:%d", stats.Semantic)}
	}
	if stats.LexicalArticle > 0 {
		diagnostics["bm25Keys"] = []string{fmt.Sprintf("fulltext:%d", stats.LexicalArticle)}
	}
	if stats.LexicalWiki > 0 {
		diagnostics["wikiKeys"] = []string{fmt.Sprintf("wiki:%d", stats.LexicalWiki)}
	}
	return diagnostics
}

func publicQaSearchOutput(scope *publicapi.PublicKnowledgeScope, kbID int64, hits []publicapi.PublicKnowledgeHit, stats publicapi.PublicRecallStats) map[string]any {
	items := make([]map[string]any, 0, len(hits))
	for _, hit := range hits {
		items = append(items, publicQaHitMap(hit))
	}
	output := map[string]any{"mode": "cross_kb", "retrievalMode": "hybrid", "hits": items, "diagnostics": publicQaDiagnostics(stats)}
	if kbID > 0 {
		output["mode"] = "hybrid"
		output["knowledgeBaseId"] = publicapi.FormatPublicID(kbID)
		output["knowledgeBaseName"] = scope.KnowledgeBaseName(kbID)
	}
	return output
}

func executePublicKnowledgeSearch(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	query := strings.TrimSpace(stringValue(params["query"]))
	if query == "" {
		return nil, rt.ValidationError("query 不能为空")
	}
	limit := intValue(params["limit"])
	if limit < 1 || limit > 20 {
		limit = 10
	}
	scope, kbID, err := publicQaScope(ctx, params)
	if err != nil {
		return nil, err
	}
	hits, stats, err := publicQaRecall(ctx, scope, publicQaQueries(params, query, true), "all", limit)
	if err != nil {
		return nil, err
	}
	return publicQaSearchOutput(scope, kbID, hits, stats), nil
}

// executePublicKnowledgeLookup 检索后直接深读最相关的 1~2 个目标：文章读最相关分片，Wiki 读全文。
func executePublicKnowledgeLookup(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	query := strings.TrimSpace(stringValue(params["query"]))
	if query == "" {
		return nil, rt.ValidationError("query 不能为空")
	}
	scope, kbID, err := publicQaScope(ctx, params)
	if err != nil {
		return nil, err
	}
	hits, stats, err := publicQaRecall(ctx, scope, []string{query}, "all", 8)
	if err != nil {
		return nil, err
	}
	reads := []map[string]any{}
	for _, hit := range hits {
		if len(reads) >= 2 {
			break
		}
		var read map[string]any
		var readErr error
		if hit.Type == "article" {
			read, readErr = publicQaArticleBestRead(ctx, scope, hit.ArticleID, query)
		} else {
			read, readErr = publicQaWikiRead(ctx, scope, hit.PageKey, hit.KnowledgeBaseID)
		}
		if readErr == nil && read != nil {
			reads = append(reads, read)
		}
	}
	output := publicQaSearchOutput(scope, kbID, hits, stats)
	output["reads"] = reads
	return output, nil
}

func publicQaArticleBestRead(ctx *rt.ToolExecutionContext, scope *publicapi.PublicKnowledgeScope, articleID int64, query string) (map[string]any, error) {
	chunks, err := scope.BestChunks(toolContext(ctx), articleID, query, 1)
	if err != nil {
		return nil, err
	}
	if len(chunks) > 0 {
		return publicQaChunkRead(chunks[0]), nil
	}
	// 文章尚未分片时退回读全文，与后台未构建索引时的兜底一致。
	return publicQaArticleRead(ctx, scope, articleID)
}

func publicQaChunkRead(chunk publicapi.PublicChunk) map[string]any {
	title := chunk.Heading
	if title == "" {
		title = chunk.ArticleTitle
	}
	return map[string]any{
		"kind": "chunk", "title": title, "articleTitle": chunk.ArticleTitle,
		"chunkId": publicapi.FormatPublicID(chunk.ChunkID), "articleId": publicapi.FormatPublicID(chunk.ArticleID),
		"knowledgeBaseId": publicapi.FormatPublicID(chunk.KnowledgeBaseID), "path": chunk.Path,
		"content": chunk.Content, "contentFrom": "chunk", "href": chunk.Href,
	}
}

func publicQaArticleRead(ctx *rt.ToolExecutionContext, scope *publicapi.PublicKnowledgeScope, articleID int64) (map[string]any, error) {
	detail, err := scope.ReadArticle(toolContext(ctx), articleID)
	if err != nil {
		return nil, err
	}
	ref := scope.Article(articleID)
	title := stringValue(detail["title"])
	return map[string]any{
		"kind": "article", "title": title, "articleId": publicapi.FormatPublicID(articleID),
		"knowledgeBaseId": publicapi.FormatPublicID(ref.KnowledgeBaseID), "path": []string{title},
		"content": stringValue(detail["contentMd"]), "contentFrom": "article", "href": publicapi.PublicArticleHref(ref),
	}, nil
}

// publicQaWikiRead 读取安全 Wiki 页面并转成与后台 read 结果同构的结构。
func publicQaWikiRead(ctx *rt.ToolExecutionContext, scope *publicapi.PublicKnowledgeScope, pageKey string, kbID int64) (map[string]any, error) {
	kbID, err := publicQaResolveWikiBase(scope, pageKey, kbID)
	if err != nil {
		return nil, err
	}
	detail, err := scope.ReadWikiPage(toolContext(ctx), pageKey, kbID)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"kind": "wiki_page", "title": detail["title"], "pageKey": detail["pageKey"],
		"pageKind": detail["kind"], "aliases": detail["aliases"],
		"knowledgeBaseId": detail["knowledgeBaseId"], "content": detail["contentMd"],
		"contentFrom": "wiki_page", "links": detail["links"], "inLinks": detail["inLinks"],
		"href": detail["href"],
	}, nil
}

// publicQaResolveWikiBase 未给知识库时，按 pageKey 在公开范围内唯一定位。
func publicQaResolveWikiBase(scope *publicapi.PublicKnowledgeScope, pageKey string, kbID int64) (int64, error) {
	pageKey = strings.TrimSpace(pageKey)
	if pageKey == "" {
		return 0, rt.ValidationError("pageKey 不能为空")
	}
	if kbID > 0 {
		return kbID, nil
	}
	found := int64(0)
	for _, page := range scope.WikiPages() {
		if page.PageKey != pageKey {
			continue
		}
		if found > 0 && found != page.KnowledgeBaseID {
			return 0, rt.ValidationError("多个公开知识库存在同名 Wiki 页面，请传入 knowledgeBaseId")
		}
		found = page.KnowledgeBaseID
	}
	if found == 0 {
		return 0, rt.ValidationError("Wiki 页面不存在或不在公开范围内")
	}
	return found, nil
}

// publicQaReadTarget 与后台 readKnowledgeTarget 相同的定位规则：chunkId、pageKey、nodeKey、articleId 取最细一个。
func publicQaReadTarget(ctx *rt.ToolExecutionContext, scope *publicapi.PublicKnowledgeScope, target map[string]any, focusKB int64) (map[string]any, error) {
	if target == nil {
		return nil, rt.ValidationError("读取目标不能为空")
	}
	kbID := parseID(target["knowledgeBaseId"])
	if focusKB > 0 {
		kbID = focusKB
	}
	chunkID := parseID(target["chunkId"])
	articleID := parseID(target["articleId"])
	pageKey := strings.TrimSpace(stringValue(target["pageKey"]))
	nodeKey := strings.TrimSpace(stringValue(target["nodeKey"]))
	switch {
	case chunkID > 0:
		chunk, err := scope.Chunk(toolContext(ctx), chunkID)
		if err != nil {
			return nil, err
		}
		return publicQaChunkRead(*chunk), nil
	case pageKey != "":
		return publicQaWikiRead(ctx, scope, pageKey, kbID)
	case nodeKey != "":
		if articleID <= 0 {
			return nil, rt.ValidationError("公开目录节点需要同时提供 articleId")
		}
		node, err := scope.ReadTreeNode(toolContext(ctx), nodeKey, articleID)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"kind": "tree_node", "title": node["title"], "nodeKey": nodeKey,
			"articleId": node["articleId"], "knowledgeBaseId": publicapi.FormatPublicID(scope.Article(articleID).KnowledgeBaseID),
			"path": node["path"], "content": node["contentMd"], "contentFrom": "node", "href": node["href"],
		}, nil
	case articleID > 0:
		return publicQaArticleRead(ctx, scope, articleID)
	}
	return nil, rt.ValidationError("chunkId、pageKey、nodeKey、articleId 必须且只能提供一个")
}

func executePublicKnowledgeReadOne(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	target, _ := params["target"].(map[string]any)
	if target == nil {
		target = params
	}
	scope, kbID, err := publicQaScope(ctx, target)
	if err != nil {
		return nil, err
	}
	result, err := publicQaReadTarget(ctx, scope, target, kbID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"results": []map[string]any{result}, "requestedCount": 1, "skippedCount": 0}, nil
}

func executePublicKnowledgeReadMany(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	rawNodes, _ := params["nodes"].([]any)
	if len(rawNodes) == 0 {
		return nil, rt.ValidationError("nodes 不能为空")
	}
	if len(rawNodes) > 4 {
		rawNodes = rawNodes[:4]
	}
	scope, focusKB, err := publicQaScope(ctx, map[string]any{})
	if err != nil {
		return nil, err
	}
	results := []map[string]any{}
	failures := []string{}
	for _, raw := range rawNodes {
		target, _ := raw.(map[string]any)
		result, readErr := publicQaReadTarget(ctx, scope, target, focusKB)
		if readErr != nil {
			failures = append(failures, rt.NormalizeAgentError(readErr).Message)
			continue
		}
		results = append(results, result)
	}
	return map[string]any{"results": results, "requestedCount": len(rawNodes), "skippedCount": 0, "failures": failures}, nil
}

func executePublicKnowledgeOutline(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	articleID := parseID(params["articleId"])
	if articleID <= 0 {
		if id, ok := focusInt(ctx.Focus, "articleId"); ok {
			articleID = id
		}
	}
	if articleID <= 0 {
		return nil, rt.ValidationError("需要 articleId 才能读取文档目录")
	}
	maxNodes := outlineDefaultMaxNodes
	if value := parseID(params["maxNodes"]); value >= 10 && value <= 300 {
		maxNodes = int(value)
	}
	scope, _, err := publicQaScope(ctx, params)
	if err != nil {
		return nil, err
	}
	ref, publicNodes, err := scope.ArticleOutline(toolContext(ctx), articleID, maxNodes)
	if err != nil {
		return nil, err
	}
	nodes := make([]outlineNode, 0, len(publicNodes))
	for _, node := range publicNodes {
		nodes = append(nodes, outlineNode{
			ChunkID: publicapi.FormatPublicID(node.ChunkID), Depth: node.Depth, Title: node.Title,
			Path: node.Path, TokenEstimate: node.TokenEstimate, Questions: node.Questions,
		})
	}
	return map[string]any{
		"articleId": publicapi.FormatPublicID(articleID), "knowledgeBaseId": publicapi.FormatPublicID(ref.KnowledgeBaseID),
		"title": ref.Title, "source": "chunk_headings", "nodeCount": len(nodes),
		"truncated": len(nodes) >= maxNodes, "nodes": nodes, "href": publicapi.PublicArticleHref(ref),
	}, nil
}

func executePublicWikiOverview(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	scope, _, err := publicQaScope(ctx, params)
	if err != nil {
		return nil, err
	}
	knowledgePages, sourcePages := []map[string]any{}, []map[string]any{}
	for _, page := range scope.WikiPages() {
		card := map[string]any{
			"pageKey": page.PageKey, "title": page.Title, "kind": page.Kind, "summary": page.Summary,
			"knowledgeBaseId": publicapi.FormatPublicID(page.KnowledgeBaseID), "href": page.Href,
		}
		if page.Kind == "source" {
			sourcePages = append(sourcePages, card)
		} else {
			knowledgePages = append(knowledgePages, card)
		}
	}
	groups := []map[string]any{}
	if len(knowledgePages) > 0 {
		groups = append(groups, map[string]any{"key": "knowledge", "label": "主题与知识页", "pages": knowledgePages})
	}
	if len(sourcePages) > 0 {
		groups = append(groups, map[string]any{"key": "source", "label": "源文档页", "pages": sourcePages})
	}
	return map[string]any{"total": len(knowledgePages) + len(sourcePages), "groups": groups}, nil
}

func executePublicWikiSearch(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	queries := []string{}
	for _, query := range stringSliceValue(params["queries"]) {
		if query = strings.TrimSpace(query); query != "" && !slices.Contains(queries, query) && len(queries) < 5 {
			queries = append(queries, query)
		}
	}
	if len(queries) == 0 {
		return nil, rt.ValidationError("queries 至少包含一个检索词")
	}
	limit := intValue(params["limit"])
	if limit < 1 || limit > 20 {
		limit = 8
	}
	scope, _, err := publicQaScope(ctx, params)
	if err != nil {
		return nil, err
	}
	hits, _, err := publicQaRecall(ctx, scope, queries, "wiki", limit)
	if err != nil {
		return nil, err
	}
	items := make([]map[string]any, 0, len(hits))
	for _, hit := range hits {
		items = append(items, map[string]any{
			"pageKey": hit.PageKey, "title": hit.Title, "kind": hit.Kind,
			"summary": hit.Summary, "snippet": hit.Snippet,
			"knowledgeBaseId": publicapi.FormatPublicID(hit.KnowledgeBaseID), "href": hit.Href,
		})
	}
	return map[string]any{"query": queries, "items": items}, nil
}

func executePublicWikiRead(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	scope, kbID, err := publicQaScope(ctx, params)
	if err != nil {
		return nil, err
	}
	pageKey := strings.TrimSpace(stringValue(params["pageKey"]))
	kbID, err = publicQaResolveWikiBase(scope, pageKey, kbID)
	if err != nil {
		return nil, err
	}
	return scope.ReadWikiPage(toolContext(ctx), pageKey, kbID)
}

// withPublicEvidenceLinks 在后台归一化器的证据上补公开链接，让来源条跳到 /p/… 或 /wiki/…。
func withPublicEvidenceLinks(normalize rt.ToolNormalizer) rt.ToolNormalizer {
	return func(output any, input any) rt.ToolNormalizerResult {
		result := normalize(output, input)
		if len(result.Evidence) == 0 {
			return result
		}
		links := map[string]string{}
		collectPublicEvidenceLinks(output, links)
		for index := range result.Evidence {
			evidence := &result.Evidence[index]
			if evidence.URL != "" {
				continue
			}
			for _, key := range publicEvidenceLinkKeys(evidence.Metadata) {
				if href := links[key]; href != "" {
					evidence.URL = href
					break
				}
			}
		}
		return result
	}
}

func publicEvidenceLinkKeys(metadata map[string]any) []string {
	keys := []string{}
	for _, field := range []string{"chunkId", "pageKey", "nodeKey", "articleId"} {
		if value := strings.TrimSpace(fmt.Sprint(metadata[field])); metadata[field] != nil && value != "" {
			keys = append(keys, field+":"+value)
		}
	}
	return keys
}

func collectPublicEvidenceLinks(value any, links map[string]string) {
	raw, err := json.Marshal(value)
	if err != nil {
		return
	}
	var decoded any
	if json.Unmarshal(raw, &decoded) != nil {
		return
	}
	var walk func(node any)
	walk = func(node any) {
		switch typed := node.(type) {
		case map[string]any:
			if href, _ := typed["href"].(string); strings.HasPrefix(href, "/p/") || strings.HasPrefix(href, "/wiki/") {
				for _, field := range []string{"chunkId", "pageKey", "nodeKey", "articleId"} {
					if id := strings.TrimSpace(fmt.Sprint(typed[field])); typed[field] != nil && id != "" {
						if _, exists := links[field+":"+id]; !exists {
							links[field+":"+id] = href
						}
					}
				}
			}
			for _, child := range typed {
				walk(child)
			}
		case []any:
			for _, child := range typed {
				walk(child)
			}
		}
	}
	walk(decoded)
}
