package assistantsvc

// tools.go 负责 Agent 工具装配。
//
// 所有工具统一注册进 runtime.DefaultToolRegistry()；执行体走 ToolExecutor，
// 不存在绕过执行器的调用路径。

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	rt "petrichor/api/internal/assistantsvc/runtime"
)

func toolPtr(v bool) *bool { return &v }

func boolPtr(v bool) *bool { return &v }

func joinStrings(parts []string, sep string) string {
	return strings.Join(parts, sep)
}

func itoa(n int) string { return strconv.Itoa(n) }

func mustJSON(v any) json.RawMessage {
	raw, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage("null")
	}
	return raw
}

func trimSpace(s string) string { return strings.TrimSpace(s) }

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}

func floatPtr(v float64) *float64 { return &v }

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

func stringSliceValue(value any) []string {
	raw, _ := value.([]any)
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if text, ok := item.(string); ok && text != "" {
			out = append(out, text)
		}
	}
	return out
}

func intValue(value any) int {
	switch number := value.(type) {
	case float64:
		return int(number)
	case json.Number:
		parsed, _ := strconv.Atoi(number.String())
		return parsed
	case int:
		return number
	default:
		return 0
	}
}

func schemaJSON(schema string) json.RawMessage { return json.RawMessage(schema) }

func toolContext(ctx *rt.ToolExecutionContext) context.Context {
	if ctx != nil && ctx.Context != nil {
		return ctx.Context
	}
	return context.Background()
}

// RegisterAssistantTools 注册助手域全部工具与技能（进程内一次）。
func RegisterAssistantTools(registry interface {
	Register(tool *rt.AgentToolDefinition)
}, skills interface {
	Register(skill rt.AgentSkill)
}) {
	registerSystemTools(registry)
	registerKnowledgeTools(registry)
	registerDocumentTools(registry)
	registerGraphTools(registry)
	registerMemoryTools(registry)
	registerResearchTools(registry)
	registerWriterTools(registry)
	registerAdminTools(registry)
	registerAgentMetaTools(registry)
	registerConfirmationTools(registry)
	registerBuiltinSkills(skills)
}

// ===== knowledge 域 =====

const kbListSchema = `{"type":"object","properties":{"knowledgeBaseId":{"type":"string","description":"可选，限定知识库"},"articleId":{"type":"string","description":"可选，限定文章"}}}`

const searchSchema = `{"type":"object","properties":{"query":{"type":"string","description":"检索问题"},"knowledgeBaseId":{"type":"string","description":"可选，限定知识库"},"limit":{"type":"integer","minimum":1,"maximum":20,"description":"返回条数，缺省 10"},"subQueries":{"type":"array","maxItems":4,"items":{"type":"string"},"description":"复杂问题的补充检索词"}},"required":["query"]}`

const lookupSchema = `{"type":"object","properties":{"query":{"type":"string","description":"检索词"},"knowledgeBaseId":{"type":"string","description":"可选，限定知识库"}},"required":["query"]}`

const readManySchema = `{"type":"object","properties":{"nodes":{"type":"array","minItems":1,"maxItems":4,"items":{"type":"object","properties":{"knowledgeBaseId":{"type":"string"},"chunkId":{"type":"string"},"pageKey":{"type":"string"},"nodeKey":{"type":"string"},"articleId":{"type":"string"}}}}},"required":["nodes"]}`

const readOneSchema = `{"type":"object","properties":{"knowledgeBaseId":{"type":"string"},"chunkId":{"type":"string"},"pageKey":{"type":"string"},"nodeKey":{"type":"string"},"articleId":{"type":"string"}}}`

const listBasesSchema = `{"type":"object","properties":{}}`

func registerKnowledgeTools(registry interface {
	Register(tool *rt.AgentToolDefinition)
}) {
	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.list_bases", Name: "list_knowledge_bases", Namespace: rt.NamespaceKnowledge,
		Description: "列出当前用户全部知识库（id / 名称 / 描述）。",
		InputSchema: schemaJSON(listBasesSchema),
		RiskLevel:   rt.RiskLow, Core: true, Tags: []string{"retrieval"},
		Execute: executeKnowledgeListBases,
		Normalize: func(output any, input any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{Summary: "已列出全部知识库"}
		},
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.search", Name: "search_knowledge", Namespace: rt.NamespaceKnowledge,
		Description: "检索站内知识库，联合原始分片、推荐问题、Wiki 页面和存量目录，经过 BM25/向量融合、重排与去重后返回候选；不返回正文，需要证据时继续 read/read_many。",
		InputSchema: schemaJSON(searchSchema),
		RiskLevel:   rt.RiskLow, Core: true, Tags: []string{"retrieval"},
		Execute:   executeKnowledgeSearch,
		Normalize: normalizeSearchOutput,
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.lookup", Name: "lookup_knowledge", Namespace: rt.NamespaceKnowledge,
		Description: "一站式复合检索：混合召回并直接深读最相关的 1~2 个章节，返回独立可追溯证据。简单的定义、功能、用途、用法问题优先使用。",
		InputSchema: schemaJSON(lookupSchema),
		RiskLevel:   rt.RiskLow, Core: true, Tags: []string{"retrieval"},
		Execute:   executeKnowledgeLookup,
		Normalize: normalizeLookupOutput,
		TimeoutMs: 60000,
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.read_many", Name: "read_knowledge_nodes", Namespace: rt.NamespaceKnowledge,
		Description: "并行深读多个章节/文章，返回每个目标的正文片段（含层级上下文）。",
		InputSchema: schemaJSON(readManySchema),
		RiskLevel:   rt.RiskLow, Core: true, Tags: []string{"retrieval"},
		Execute:   executeKnowledgeReadMany,
		Normalize: normalizeReadOutput,
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.read", Name: "read_knowledge_node", Namespace: rt.NamespaceKnowledge,
		Description: "深读单个文章或章节，返回正文片段（含层级上下文）。只读一个明确章节时使用。",
		InputSchema: schemaJSON(readOneSchema),
		RiskLevel:   rt.RiskLow, Core: true, Tags: []string{"retrieval"},
		Execute:   executeKnowledgeReadOne,
		Normalize: normalizeReadOutput,
	})

	registerWikiTools(registry)
}

// ===== 工具实现 =====

type chunkHit struct {
	ArticleID       int64    `json:"articleId"`
	KnowledgeBaseID int64    `json:"knowledgeBaseId"`
	ChunkID         int64    `json:"chunkId,omitempty"`
	PageKey         string   `json:"pageKey,omitempty"`
	CandidateKind   string   `json:"candidateKind,omitempty"`
	Title           string   `json:"title"`
	NodeKey         string   `json:"nodeKey"`
	Path            string   `json:"path"`
	Snippet         string   `json:"snippet"`
	Score           float64  `json:"score"`
	RerankScore     *float64 `json:"rerankScore,omitempty"`
	RecallSources   []string `json:"recallSources,omitempty"`
	// Content 与 MatchedContent 只用于进程内重排，禁止直接进入工具输出。
	Content        string `json:"-"`
	MatchedContent string `json:"-"`
}

type queryEmbedding struct {
	Vector []float32
	Model  string
}

func vectorLiteral(vec []float32) string {
	parts := make([]string, 0, len(vec))
	for _, v := range vec {
		parts = append(parts, fmt.Sprintf("%g", v))
	}
	return "[" + strings.Join(parts, ",") + "]"
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// articleTitleFallback 分片未命中时按文章标题词元匹配，保证标题级召回。
func articleTitleFallback(ctx context.Context, userID int64, query string, kbID int64, hasKB bool, articleID int64, hasArticle bool, topK int) []chunkHit {
	tokens := buildQueryTokens(query)
	if len(tokens) == 0 {
		return nil
	}
	patterns := likePatterns(tokens)
	sql := `SELECT a.id, a.knowledge_base_id, a.title,
			       COALESCE(a.ai_summary, substring(a.content_md from 1 for 400)),
			       0.4::float8
			FROM petrichor_kb_article a
			WHERE a.user_id = $1 AND a.title ILIKE ANY($2)`
	args := []any{userID, patterns}
	if hasKB && kbID > 0 {
		sql += fmt.Sprintf(` AND a.knowledge_base_id = $%d`, len(args)+1)
		args = append(args, kbID)
	}
	if hasArticle && articleID > 0 {
		sql += fmt.Sprintf(` AND a.id = $%d`, len(args)+1)
		args = append(args, articleID)
	}
	sql += fmt.Sprintf(` LIMIT $%d`, len(args)+1)
	args = append(args, topK)
	rows, err := dbPool().Query(ctx, sql, args...)
	if err != nil {
		return nil
	}
	defer rows.Close()
	hits := []chunkHit{}
	for rows.Next() {
		var h chunkHit
		if err := rows.Scan(&h.ArticleID, &h.KnowledgeBaseID, &h.Title, &h.Snippet, &h.Score); err != nil {
			continue
		}
		h.CandidateKind = "article"
		h.RecallSources = []string{"article_title"}
		hits = append(hits, h)
	}
	return hits
}

func sanitizeLike(q string) string {
	q = strings.ReplaceAll(q, "%", "\\%")
	q = strings.ReplaceAll(q, "_", "\\_")
	return q
}

func focusInt(focus map[string]any, key string) (int64, bool) {
	if focus == nil {
		return 0, false
	}
	switch v := focus[key].(type) {
	case string:
		var id int64
		if _, err := fmt.Sscanf(v, "%d", &id); err == nil && id > 0 {
			return id, true
		}
	case float64:
		if v > 0 {
			return int64(v), true
		}
	}
	return 0, false
}

func parseID(v any) int64 {
	switch n := v.(type) {
	case string:
		var id int64
		if _, err := fmt.Sscanf(n, "%d", &id); err == nil {
			return id
		}
	case float64:
		return int64(n)
	}
	return 0
}

// executeKnowledgeListBases 列出知识库。
func executeKnowledgeListBases(ctx *rt.ToolExecutionContext, _ any) (any, error) {
	rows, err := dbPool().Query(toolContext(ctx),
		`SELECT id, name, COALESCE(description,'') FROM petrichor_kb_knowledge_base
		 WHERE user_id = $1 ORDER BY name ASC`, ctx.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bases := []map[string]any{}
	for rows.Next() {
		var id int64
		var name, description string
		if err := rows.Scan(&id, &name, &description); err != nil {
			continue
		}
		bases = append(bases, map[string]any{
			"id":          fmt.Sprintf("%d", id),
			"name":        name,
			"description": description,
		})
	}
	return map[string]any{"bases": bases}, rows.Err()
}

type knowledgeScope struct {
	KnowledgeBaseID  int64
	HasKnowledgeBase bool
	ArticleID        int64
	HasArticle       bool
}

func resolveKnowledgeScope(ctx *rt.ToolExecutionContext, params map[string]any) knowledgeScope {
	if value, exists := params["knowledgeBaseId"]; exists {
		if id := parseID(value); id > 0 {
			return knowledgeScope{KnowledgeBaseID: id, HasKnowledgeBase: true}
		}
	}
	scope := knowledgeScope{}
	if id, ok := focusInt(ctx.Focus, "knowledgeBaseId"); ok {
		scope.KnowledgeBaseID, scope.HasKnowledgeBase = id, true
	}
	if id, ok := focusInt(ctx.Focus, "articleId"); ok {
		scope.ArticleID, scope.HasArticle = id, true
	}
	return scope
}

func hitKey(hit chunkHit) string {
	switch {
	case hit.ChunkID > 0:
		return fmt.Sprintf("chunk:%d:%d", hit.KnowledgeBaseID, hit.ChunkID)
	case hit.PageKey != "":
		return fmt.Sprintf("wiki:%d:%s", hit.KnowledgeBaseID, hit.PageKey)
	case hit.NodeKey != "":
		return fmt.Sprintf("tree:%d:%s", hit.KnowledgeBaseID, hit.NodeKey)
	default:
		return fmt.Sprintf("article:%d:%d", hit.KnowledgeBaseID, hit.ArticleID)
	}
}

// fuseKnowledgeHits 用 RRF 融合分片语义、问题语义、词面与 Wiki 页面候选。
// 单路故障不会清空其它来源；相同 chunk 的推荐问题命中会回读同一原始分片。
func fuseKnowledgeHits(groups [][]chunkHit, limit int) []chunkHit {
	type fused struct {
		hit   chunkHit
		score float64
	}
	byKey := map[string]*fused{}
	order := []string{}
	for _, group := range groups {
		for rank, hit := range group {
			key := hitKey(hit)
			entry := byKey[key]
			if entry == nil {
				copyHit := hit
				entry = &fused{hit: copyHit}
				byKey[key] = entry
				order = append(order, key)
			} else if shouldPreferKnowledgeHit(hit, entry.hit) {
				// 同一 chunk 同时被推荐问题与原文命中时，排名贡献全部保留，
				// 但候选展示/重排必须使用原文分片，不能让问题别名冒充正文摘要。
				existingSources := entry.hit.RecallSources
				entry.hit = hit
				entry.hit.RecallSources = existingSources
			}
			entry.score += 1 / float64(60+rank+1)
			entry.hit.RecallSources = appendUniqueStrings(entry.hit.RecallSources, hit.RecallSources...)
			if hit.Score > entry.hit.Score {
				entry.hit.Score = hit.Score
			}
		}
	}
	out := make([]chunkHit, 0, len(byKey))
	for _, key := range order {
		entry := byKey[key]
		entry.hit.Score = entry.score
		out = append(out, entry.hit)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		// RRF 同分时，多路同时命中的候选更可靠。
		return len(out[i].RecallSources) > len(out[j].RecallSources)
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

func shouldPreferKnowledgeHit(candidate, current chunkHit) bool {
	if candidate.ChunkID == 0 || current.ChunkID == 0 {
		return false
	}
	return hasRecallSourcePrefix(candidate.RecallSources, "chunk_") &&
		!hasRecallSourcePrefix(current.RecallSources, "chunk_")
}

func hasRecallSourcePrefix(sources []string, prefix string) bool {
	for _, source := range sources {
		if strings.HasPrefix(source, prefix) {
			return true
		}
	}
	return false
}

func appendUniqueStrings(existing []string, values ...string) []string {
	seen := map[string]bool{}
	for _, item := range existing {
		seen[item] = true
	}
	for _, item := range values {
		if item != "" && !seen[item] {
			seen[item] = true
			existing = append(existing, item)
		}
	}
	return existing
}

// executeKnowledgeSearch 混合检索候选。
func executeKnowledgeSearch(ctx *rt.ToolExecutionContext, input any) (any, error) {
	return executeKnowledgeSearchV2(ctx, input)
}

func roundFloat(v float64) float64 { return float64(int(v*10000+0.5)) / 10000 }

// executeKnowledgeLookup 复合检索：search + 深读最相关 1~2 个章节。
func executeKnowledgeLookup(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	query, _ := params["query"].(string)
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, rt.ValidationError("query 不能为空")
	}
	searchInput := map[string]any{
		"query": query, "knowledgeBaseId": params["knowledgeBaseId"], "limit": float64(6),
	}
	if subQueries, ok := params["subQueries"]; ok {
		searchInput["subQueries"] = subQueries
	}
	searchOutput, err := executeKnowledgeSearch(ctx, searchInput)
	if err != nil {
		return nil, err
	}
	record, _ := searchOutput.(map[string]any)
	hits, _ := record["hits"].([]map[string]any)
	reads := make([]map[string]any, 0, 2)
	for _, hit := range hits {
		read, readErr := readKnowledgeTarget(ctx, hit)
		if readErr == nil && read != nil {
			reads = append(reads, read)
		}
		if len(reads) >= 2 {
			break
		}
	}
	return map[string]any{
		"mode": record["mode"], "hits": record["hits"], "diagnostics": record["diagnostics"],
		"reads": reads,
	}, nil
}

func readKnowledgeTarget(ctx *rt.ToolExecutionContext, target map[string]any) (map[string]any, error) {
	if target == nil {
		return nil, rt.ValidationError("读取目标不能为空")
	}
	kbID := parseID(target["knowledgeBaseId"])
	if kbID <= 0 {
		kbID, _ = focusInt(ctx.Focus, "knowledgeBaseId")
	}
	chunkID := parseID(target["chunkId"])
	articleID := parseID(target["articleId"])
	pageKey, _ := target["pageKey"].(string)
	nodeKey, _ := target["nodeKey"].(string)
	pageKey, nodeKey = strings.TrimSpace(pageKey), strings.TrimSpace(nodeKey)
	// 检索命中会同时携带 articleId 与更精确定位符；深读时优先最细粒度目标。
	if chunkID > 0 || pageKey != "" || nodeKey != "" {
		articleID = 0
	}
	locatorCount := 0
	for _, present := range []bool{chunkID > 0, pageKey != "", nodeKey != "", articleID > 0} {
		if present {
			locatorCount++
		}
	}
	if locatorCount != 1 {
		return nil, rt.ValidationError("chunkId、pageKey、nodeKey、articleId 必须且只能提供一个")
	}
	cctx := toolContext(ctx)

	if chunkID > 0 {
		var gotKB, gotArticle int64
		var articleTitle, heading, pathJSON, content string
		sql := `SELECT c.knowledge_base_id, c.article_id, a.title, c.heading,
		               COALESCE(c.heading_path_json, '[]'), c.content_md
		        FROM petrichor_kb_article_chunk c
		        JOIN petrichor_kb_article a ON a.id = c.article_id AND a.user_id = c.user_id
		        WHERE c.id = $1 AND c.user_id = $2`
		args := []any{chunkID, ctx.UserID}
		if kbID > 0 {
			sql += ` AND c.knowledge_base_id = $3`
			args = append(args, kbID)
		}
		err := dbPool().QueryRow(cctx, sql+` LIMIT 1`, args...).Scan(
			&gotKB, &gotArticle, &articleTitle, &heading, &pathJSON, &content)
		if err != nil {
			return nil, rt.ValidationError("知识分片不存在或不属于当前用户")
		}
		path := []string{}
		_ = json.Unmarshal([]byte(pathJSON), &path)
		if len(path) == 0 && heading != "" {
			path = []string{heading}
		}
		title := heading
		if title == "" {
			title = articleTitle
		}
		return map[string]any{
			"kind": "chunk", "title": title, "articleTitle": articleTitle,
			"chunkId": fmt.Sprintf("%d", chunkID), "articleId": fmt.Sprintf("%d", gotArticle),
			"knowledgeBaseId": fmt.Sprintf("%d", gotKB), "path": path,
			"content": content, "contentFrom": "chunk",
		}, nil
	}

	if pageKey != "" {
		detail, err := kbWikiPageDetailByPageKey(cctx, ctx.UserID, kbID, pageKey)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"kind": "wiki_page", "title": detail["title"], "pageKey": detail["pageKey"],
			"pageKind": detail["kind"], "aliases": detail["aliases"],
			"knowledgeBaseId": detail["knowledgeBaseId"], "content": detail["contentMd"],
			"contentFrom": "wiki_page", "links": detail["links"], "inLinks": detail["inLinks"],
		}, nil
	}

	if nodeKey != "" {
		var gotKB, gotArticle int64
		var title, content string
		var parentKey *string
		sql := `SELECT knowledge_base_id, article_id, title, parent_key, content_md
		        FROM petrichor_kb_wiki_tree_node WHERE user_id = $1 AND node_key = $2`
		args := []any{ctx.UserID, nodeKey}
		if kbID > 0 {
			sql += ` AND knowledge_base_id = $3`
			args = append(args, kbID)
		}
		if err := dbPool().QueryRow(cctx, sql+` ORDER BY id ASC LIMIT 1`, args...).Scan(
			&gotKB, &gotArticle, &title, &parentKey, &content); err != nil {
			return nil, rt.ValidationError("知识节点不存在或不属于当前用户")
		}
		contentFrom := "node"
		if strings.TrimSpace(content) == "" {
			// 空父节点读取其完整子树，避免退化成整篇文章并引入无关正文。
			_ = dbPool().QueryRow(cctx, `WITH RECURSIVE subtree AS (
				SELECT node_key, parent_key, depth, position, content_md
				FROM petrichor_kb_wiki_tree_node
				WHERE user_id = $1 AND knowledge_base_id = $2 AND node_key = $3
				UNION ALL
				SELECT child.node_key, child.parent_key, child.depth, child.position, child.content_md
				FROM petrichor_kb_wiki_tree_node child
				JOIN subtree parent ON child.parent_key = parent.node_key
				WHERE child.user_id = $1 AND child.knowledge_base_id = $2
			)
			SELECT COALESCE(string_agg(NULLIF(content_md, ''), E'\n\n' ORDER BY depth, position), '')
			FROM subtree`, ctx.UserID, gotKB, nodeKey).Scan(&content)
			contentFrom = "subtree"
		}
		path := []string{title}
		if parentKey != nil && strings.TrimSpace(*parentKey) != "" {
			path = []string{*parentKey, title}
		}
		return map[string]any{
			"kind": "tree_node", "title": title, "nodeKey": nodeKey,
			"articleId": fmt.Sprintf("%d", gotArticle), "knowledgeBaseId": fmt.Sprintf("%d", gotKB),
			"path": path, "content": content, "contentFrom": contentFrom,
		}, nil
	}

	var gotKB int64
	var title, content string
	sql := `SELECT knowledge_base_id, title, content_md FROM petrichor_kb_article
	        WHERE id = $1 AND user_id = $2`
	args := []any{articleID, ctx.UserID}
	if kbID > 0 {
		sql += ` AND knowledge_base_id = $3`
		args = append(args, kbID)
	}
	if err := dbPool().QueryRow(cctx, sql+` LIMIT 1`, args...).Scan(&gotKB, &title, &content); err != nil {
		return nil, rt.ValidationError("文章不存在或不属于当前用户")
	}
	return map[string]any{
		"kind": "article", "title": title, "articleId": fmt.Sprintf("%d", articleID),
		"knowledgeBaseId": fmt.Sprintf("%d", gotKB), "path": []string{title},
		"content": content, "contentFrom": "article",
	}, nil
}

// executeKnowledgeReadMany 批量深读。
func executeKnowledgeReadMany(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	targetsRaw, _ := params["nodes"].([]any)
	if len(targetsRaw) == 0 {
		// 兼容早期 Go 草案的 targets 字段；对外主契约使用 TS 的 nodes。
		targetsRaw, _ = params["targets"].([]any)
	}
	if len(targetsRaw) == 0 {
		return nil, rt.ValidationError("nodes 不能为空")
	}
	limit := 4
	if ctx.State != nil && ctx.State.Complexity == rt.ComplexitySimple {
		limit = 2
	}
	results := make([]map[string]any, 0, minIntLocal(len(targetsRaw), limit))
	failures := []string{}
	for _, t := range targetsRaw[:minIntLocal(len(targetsRaw), limit)] {
		target, _ := t.(map[string]any)
		entry, err := readKnowledgeTarget(ctx, target)
		if err != nil {
			failures = append(failures, err.Error())
			continue
		}
		results = append(results, entry)
	}
	return map[string]any{
		"results": results, "requestedCount": len(targetsRaw),
		"skippedCount": maxInt(0, len(targetsRaw)-limit), "failures": failures,
	}, nil
}

func minIntLocal(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// executeKnowledgeReadOne 单个深读。
func executeKnowledgeReadOne(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	target, _ := params["target"].(map[string]any)
	if target == nil {
		target = params
	}
	result, err := readKnowledgeTarget(ctx, target)
	if err != nil {
		return nil, err
	}
	return map[string]any{"results": []map[string]any{result}, "requestedCount": 1, "skippedCount": 0}, nil
}

// ===== 归一化器 =====

func evidenceFromHits(hits []chunkHit) []rt.EvidenceInput {
	evidence := make([]rt.EvidenceInput, 0, len(hits))
	for _, h := range hits {
		meta := map[string]any{
			"articleId":       fmt.Sprintf("%d", h.ArticleID),
			"knowledgeBaseId": fmt.Sprintf("%d", h.KnowledgeBaseID),
		}
		if h.Path != "" {
			meta["nodeKey"] = h.Path
		}
		evidence = append(evidence, rt.EvidenceInput{
			Source:     rt.EvidenceKnowledge,
			Title:      h.Title,
			Content:    h.Snippet,
			URL:        "",
			Relevance:  floatPtr(clamp01(h.Score)),
			Confidence: floatPtr(0.7),
			Metadata:   meta,
		})
	}
	return evidence
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func normalizeSearchOutput(output any, _ any) rt.ToolNormalizerResult {
	raw, _ := json.Marshal(output)
	var parsed struct {
		Mode        string           `json:"mode"`
		Hits        []map[string]any `json:"hits"`
		Diagnostics map[string]any   `json:"diagnostics"`
	}
	_ = json.Unmarshal(raw, &parsed)
	if len(parsed.Hits) == 0 {
		return rt.ToolNormalizerResult{
			Summary: "知识库中未检索到相关内容",
			Data: mustJSON(map[string]any{
				"mode": parsed.Mode, "hits": []map[string]any{},
			}),
			SuggestedActions: []string{"rewrite_query", "load_skill:research"},
			Progress:         boolPtr(false),
		}
	}
	return rt.ToolNormalizerResult{
		Summary: fmt.Sprintf("找到 %d 个相关章节（%s）", len(parsed.Hits), knowledgeRetrievalDisplaySummary(parsed.Diagnostics)),
		Data: mustJSON(map[string]any{
			"mode": parsed.Mode, "hits": compactKnowledgeObservationHits(parsed.Hits),
		}),
		SuggestedActions: []string{"knowledge.read_many", "knowledge.read"},
		Progress:         boolPtr(true),
	}
}

func compactKnowledgeObservationHits(hits []map[string]any) []map[string]any {
	keys := []string{
		"nodeKey", "chunkId", "pageKey", "articleId", "knowledgeBaseId",
		"title", "path", "summary", "recallSources",
	}
	out := make([]map[string]any, 0, len(hits))
	for _, hit := range hits {
		item := map[string]any{}
		for _, key := range keys {
			if value, exists := hit[key]; exists && value != nil {
				item[key] = value
			}
		}
		out = append(out, item)
	}
	return out
}

func knowledgeRetrievalDisplaySummary(diagnostics map[string]any) string {
	if diagnostics == nil {
		return "混合检索"
	}
	methods := []string{}
	if diagnosticListCount(diagnostics["chunkVectorKeys"]) > 0 {
		methods = append(methods, "分片语义")
	}
	if diagnosticListCount(diagnostics["questionVectorKeys"]) > 0 {
		methods = append(methods, "问题语义")
	}
	if diagnosticListCount(diagnostics["bm25Keys"]) > 0 {
		methods = append(methods, "分片关键词")
	}
	if diagnosticListCount(diagnostics["wikiKeys"]) > 0 {
		methods = append(methods, "Wiki 页面")
	}
	if len(methods) == 0 && diagnosticListCount(diagnostics["vectorKeys"]) > 0 {
		methods = append(methods, "存量章节语义")
	}
	treeAttempted, _ := diagnostics["treeAttempted"].(bool)
	if treeAttempted {
		methods = append(methods, "存量目录导航")
	}
	if len(methods) == 0 {
		methods = append(methods, "兼容检索")
	}
	parts := []string{strings.Join(methods, " + ")}
	strategy, _ := diagnostics["rerankStrategy"].(string)
	switch strategy {
	case "external":
		parts = append(parts, "模型重排")
	case "local_fallback":
		parts = append(parts, "本地重排（外部服务已降级）")
	case "local":
		parts = append(parts, "本地重排")
	}
	if degraded, ok := diagnostics["degraded"].(map[string]any); ok && len(degraded) > 0 {
		parts = append(parts, "部分召回已降级")
	} else if degraded, ok := diagnostics["degraded"].(map[string]string); ok && len(degraded) > 0 {
		parts = append(parts, "部分召回已降级")
	}
	return strings.Join(parts, "；")
}

func diagnosticListCount(value any) int {
	switch list := value.(type) {
	case []any:
		return len(list)
	case []string:
		return len(list)
	default:
		return 0
	}
}

func normalizeLookupOutput(output any, _ any) rt.ToolNormalizerResult {
	raw, _ := json.Marshal(output)
	var parsed struct {
		Mode        string           `json:"mode"`
		Hits        []map[string]any `json:"hits"`
		Reads       []map[string]any `json:"reads"`
		Diagnostics map[string]any   `json:"diagnostics"`
	}
	_ = json.Unmarshal(raw, &parsed)
	readNormalized := normalizeReadOutput(map[string]any{"results": parsed.Reads}, nil)
	evidence := readNormalized.Evidence
	var readData map[string]any
	_ = json.Unmarshal(readNormalized.Data, &readData)
	pages := []wikiMentionObservationPage{}
	if readPages, ok := readData["pages"].([]any); ok {
		rawPages, _ := json.Marshal(readPages)
		_ = json.Unmarshal(rawPages, &pages)
	}
	summary := "复合检索未命中"
	if len(parsed.Hits) > 0 {
		retrieval := knowledgeRetrievalDisplaySummary(parsed.Diagnostics)
		if len(evidence) > 0 {
			summary = fmt.Sprintf("找到 %d 个相关章节并深读 %d 个（%s）", len(parsed.Hits), len(evidence), retrieval)
		} else {
			summary = fmt.Sprintf("找到 %d 个候选章节，但没有读到可引用正文（%s）", len(parsed.Hits), retrieval)
		}
	}
	suggested := []string{"knowledge.read_many", "knowledge.read"}
	if len(parsed.Hits) == 0 {
		suggested = []string{"rewrite_query", "load_skill:research"}
	} else if len(evidence) > 0 {
		suggested = []string{}
	}
	return rt.ToolNormalizerResult{
		Summary: summary,
		Data: mustJSON(map[string]any{
			"mode": parsed.Mode, "hits": compactKnowledgeObservationHits(parsed.Hits),
			"reads": readData, "pages": pages,
		}),
		Evidence: evidence, Progress: boolPtr(len(parsed.Hits) > 0),
		SuggestedActions: suggested,
	}
}

// wikiMentionObservationPage 是工具 Observation 中供普通问答渲染使用的轻量 Wiki 词典项。
// 这里只保留识别裸文本所需字段，正文和关联摘要仍只进入 Evidence，避免重复扩大上下文。
type wikiMentionObservationPage struct {
	PageKey string   `json:"pageKey"`
	Title   string   `json:"title"`
	Kind    string   `json:"kind,omitempty"`
	Aliases []string `json:"aliases"`
}

func appendWikiMentionObservationPage(
	pages []wikiMentionObservationPage,
	byKey map[string]int,
	page wikiMentionObservationPage,
) []wikiMentionObservationPage {
	page.PageKey = strings.TrimSpace(page.PageKey)
	page.Title = strings.TrimSpace(page.Title)
	page.Kind = strings.ToLower(strings.TrimSpace(page.Kind))
	if page.PageKey == "" {
		return pages
	}
	if page.Title == "" {
		page.Title = page.PageKey
	}
	cleanAliases := make([]string, 0, len(page.Aliases))
	aliasSeen := map[string]bool{}
	for _, alias := range page.Aliases {
		alias = strings.TrimSpace(alias)
		key := strings.ToLower(alias)
		if alias == "" || aliasSeen[key] {
			continue
		}
		aliasSeen[key] = true
		cleanAliases = append(cleanAliases, alias)
	}
	page.Aliases = cleanAliases

	key := strings.ToLower(page.PageKey)
	if index, exists := byKey[key]; exists {
		current := &pages[index]
		if current.Title == current.PageKey && page.Title != page.PageKey {
			current.Title = page.Title
		}
		if current.Kind == "" && page.Kind != "" {
			current.Kind = page.Kind
		}
		for _, alias := range page.Aliases {
			aliasKey := strings.ToLower(alias)
			found := false
			for _, currentAlias := range current.Aliases {
				if strings.ToLower(currentAlias) == aliasKey {
					found = true
					break
				}
			}
			if !found {
				current.Aliases = append(current.Aliases, alias)
			}
		}
		return pages
	}
	byKey[key] = len(pages)
	return append(pages, page)
}

func normalizeReadOutput(output any, _ any) rt.ToolNormalizerResult {
	raw, _ := json.Marshal(output)
	var parsed struct {
		Results []struct {
			Kind        string                       `json:"kind"`
			PageKind    string                       `json:"pageKind"`
			Title       string                       `json:"title"`
			Aliases     []string                     `json:"aliases"`
			Path        json.RawMessage              `json:"path"`
			Content     string                       `json:"content"`
			KbID        string                       `json:"knowledgeBaseId"`
			ArticleID   string                       `json:"articleId"`
			ChunkID     string                       `json:"chunkId"`
			PageKey     string                       `json:"pageKey"`
			NodeKey     string                       `json:"nodeKey"`
			ContentFrom string                       `json:"contentFrom"`
			Links       []wikiMentionObservationPage `json:"links"`
			InLinks     []wikiMentionObservationPage `json:"inLinks"`
		} `json:"results"`
		RequestedCount int      `json:"requestedCount"`
		SkippedCount   int      `json:"skippedCount"`
		Failures       []string `json:"failures"`
	}
	_ = json.Unmarshal(raw, &parsed)
	totalChars := 0
	evidence := make([]rt.EvidenceInput, 0, len(parsed.Results))
	pages := make([]wikiMentionObservationPage, 0, 16)
	pageIndex := map[string]int{}
	for _, r := range parsed.Results {
		if r.PageKey != "" {
			kind := r.PageKind
			if kind == "" {
				kind = r.Kind
			}
			pages = appendWikiMentionObservationPage(pages, pageIndex, wikiMentionObservationPage{
				PageKey: r.PageKey, Title: r.Title, Kind: kind, Aliases: r.Aliases,
			})
		}
		for _, page := range r.Links {
			pages = appendWikiMentionObservationPage(pages, pageIndex, page)
		}
		for _, page := range r.InLinks {
			pages = appendWikiMentionObservationPage(pages, pageIndex, page)
		}
		totalChars += len([]rune(r.Content))
		if strings.TrimSpace(r.Content) == "" {
			continue
		}
		mentionKind := r.PageKind
		if mentionKind == "" {
			mentionKind = r.Kind
		}
		meta := map[string]any{"kind": mentionKind}
		if r.ArticleID != "" {
			meta["articleId"] = r.ArticleID
		}
		if r.KbID != "" {
			meta["knowledgeBaseId"] = r.KbID
		}
		if r.ChunkID != "" {
			meta["chunkId"] = r.ChunkID
		}
		if r.PageKey != "" {
			meta["pageKey"] = r.PageKey
		}
		if len(r.Aliases) > 0 {
			meta["aliases"] = r.Aliases
		}
		if r.NodeKey != "" {
			meta["nodeKey"] = r.NodeKey
		}
		if r.ContentFrom != "" {
			meta["contentFrom"] = r.ContentFrom
		}
		var path []string
		if len(r.Path) > 0 {
			if json.Unmarshal(r.Path, &path) != nil {
				var pathText string
				if json.Unmarshal(r.Path, &pathText) == nil && pathText != "" {
					path = strings.Split(pathText, " › ")
				}
			}
		}
		if len(path) > 0 {
			meta["path"] = path
		}
		content := trimSpace(r.Content)
		if r.Kind == "wiki_page" && r.PageKey != "" {
			content = "[Wiki 页面 " + r.Title + "]\n\n" + content
		} else {
			content = truncateRunes(content, 4000)
		}
		evidence = append(evidence, rt.EvidenceInput{
			Source: map[bool]rt.EvidenceSourceAlias{true: rt.EvidenceWiki, false: rt.EvidenceKnowledge}[r.Kind == "wiki_page"], Title: r.Title,
			Content: content, Relevance: floatPtr(0.8), Confidence: floatPtr(0.8),
			FullRead: r.Kind == "wiki_page", SourceID: firstNonEmpty(r.ChunkID, r.NodeKey, r.PageKey), Metadata: meta,
		})
	}
	summary := "读取结果为空"
	if len(evidence) > 0 {
		summary = fmt.Sprintf("已读取 %d 个目标（合计 %d 字）", len(evidence), totalChars)
		if len(parsed.Failures) > 0 || parsed.SkippedCount > 0 {
			summary += fmt.Sprintf("；%d 个失败，%d 个按复杂度跳过", len(parsed.Failures), parsed.SkippedCount)
		}
	}
	return rt.ToolNormalizerResult{
		Summary: summary, Evidence: evidence, Progress: boolPtr(len(evidence) > 0),
		Data: mustJSON(map[string]any{
			"requestedCount": parsed.RequestedCount, "readCount": len(evidence),
			"skippedCount": parsed.SkippedCount, "failureCount": len(parsed.Failures),
			"pages": pages,
		}),
		SuggestedActions: map[bool][]string{true: {}, false: {"knowledge.search"}}[len(evidence) > 0],
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func extractHits(output any) []map[string]any {
	raw, _ := json.Marshal(output)
	var parsed struct {
		Hits []map[string]any `json:"hits"`
	}
	_ = json.Unmarshal(raw, &parsed)
	return parsed.Hits
}

func boolPtr2(v bool) *bool { return &v }

// ===== Wiki 域工具 =====

func registerWikiTools(registry interface {
	Register(tool *rt.AgentToolDefinition)
}) {
	wikiTag := []string{"wiki"}

	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.wiki_overview", Name: "wiki_overview", Namespace: rt.NamespaceKnowledge,
		Description: "列出 Wiki 页面分组概览：主题与知识页（概念/实体/对比/答案）+ 源文档页，每页含 pageKey、标题与摘要。" +
			"何时用：Wiki 问答的第一步，先掌握全貌再决定读哪些页面。" +
			"输入：无；可选 knowledgeBaseId 限定库（缺省沿用当前提问范围，未指定时跨全部知识库）。" +
			"输出：分组页面目录。已知 pageKey 时可直接 read_wiki_page_detail。",
		InputSchema: schemaJSON(`{"type":"object","properties":{"knowledgeBaseId":{"type":"string","description":"可选，限定知识库"}}}`),
		RiskLevel:   rt.RiskLow, Tags: wikiTag,
		Execute: executeWikiOverview,
		Normalize: func(output any, _ any) rt.ToolNormalizerResult {
			raw, _ := json.Marshal(output)
			var parsed struct {
				Total  int `json:"total"`
				Groups []struct {
					Key   string           `json:"key"`
					Label string           `json:"label"`
					Pages []map[string]any `json:"pages"`
				} `json:"groups"`
			}
			_ = json.Unmarshal(raw, &parsed)
			if parsed.Total == 0 {
				return rt.ToolNormalizerResult{Summary: "当前范围内还没有可用的 Wiki 页面"}
			}
			pages := []map[string]any{}
			labels := []string{}
			for _, group := range parsed.Groups {
				for _, page := range group.Pages {
					if len(pages) < 60 {
						pages = append(pages, map[string]any{
							"pageKey": page["pageKey"], "title": page["title"],
							"kind": page["kind"], "summary": page["summary"],
						})
					}
				}
				labels = append(labels, fmt.Sprintf("%s%d", group.Label, len(group.Pages)))
			}
			data, _ := json.Marshal(map[string]any{"total": parsed.Total, "pages": pages})
			return rt.ToolNormalizerResult{
				Summary:          "Wiki 共 " + itoa(parsed.Total) + " 个页面：" + joinStrings(labels, "、"),
				Data:             data,
				SuggestedActions: []string{"search_wiki_pages", "read_wiki_page_detail"},
				Progress:         boolPtr(true),
			}
		},
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.search_wiki_pages", Name: "search_wiki_pages", Namespace: rt.NamespaceKnowledge,
		Description: "在 Wiki 页面里做多关键词检索：queries 一次传多个词（同义概念、别名词一起搜），" +
			"命中标题/摘要/别名/正文，返回 pageKey、标题、类型、别名、摘要与正文命中片段。" +
			"何时用：不知道确切 pageKey 时定位 Wiki 页面。未指定库时跨全部知识库检索。" +
			"何时不用：要浏览全貌用 wiki_overview；要正文用 read_wiki_page_detail。",
		InputSchema: schemaJSON(`{"type":"object","properties":{"knowledgeBaseId":{"type":"string","description":"可选，限定知识库"},"queries":{"type":"array","items":{"type":"string"},"minItems":1},"limit":{"type":"integer"}},"required":["queries"]}`),
		RiskLevel:   rt.RiskLow, Tags: wikiTag,
		Execute:   executeWikiSearchPages,
		Normalize: normalizeWikiPageSearch,
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.read_wiki_page_detail", Name: "read_wiki_page_detail", Namespace: rt.NamespaceKnowledge,
		Description: "读 Wiki 页面全文（含关联页面链接与摘要），支持多跳。",
		InputSchema: schemaJSON(`{"type":"object","properties":{"knowledgeBaseId":{"type":"string"},"pageKey":{"type":"string"}},"required":["knowledgeBaseId","pageKey"]}`),
		RiskLevel:   rt.RiskLow, Tags: wikiTag,
		Execute:   executeWikiReadPage,
		Normalize: normalizeWikiPageRead,
	})
}

func executeWikiOverview(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	kbID := parseID(params["knowledgeBaseId"])
	if kbID <= 0 {
		if id, ok := focusInt(ctx.Focus, "knowledgeBaseId"); ok {
			kbID = id
		}
	}
	// 未指定库时跨用户全部知识库（与 TS listUserWikiOverview 一致）
	return kbListWikiOverview(toolContext(ctx), ctx.UserID, kbID), nil
}

func executeWikiSearchPages(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	kbID := parseID(params["knowledgeBaseId"])
	if kbID <= 0 {
		if id, ok := focusInt(ctx.Focus, "knowledgeBaseId"); ok {
			kbID = id
		}
	}
	queriesRaw, _ := params["queries"].([]any)
	queries := make([]string, 0, len(queriesRaw))
	for _, q := range queriesRaw {
		if s, ok := q.(string); ok && trimSpace(s) != "" {
			queries = append(queries, s)
		}
	}
	if len(queries) == 0 {
		return nil, rt.ValidationError("至少提供一个搜索关键词")
	}
	limit := 8
	if v, ok := params["limit"].(float64); ok && v > 0 {
		limit = int(v)
	}
	cleaned, items := kbSearchWikiPages(toolContext(ctx), ctx.UserID, kbID, queries, limit)
	return map[string]any{"query": cleaned, "items": items}, nil
}

func executeWikiReadPage(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	kbID := parseID(params["knowledgeBaseId"])
	if kbID <= 0 {
		if id, ok := focusInt(ctx.Focus, "knowledgeBaseId"); ok {
			kbID = id
		}
	}
	pageKey, _ := params["pageKey"].(string)
	if pageKey == "" {
		return nil, rt.ValidationError("pageKey 不能为空")
	}
	detail, err := kbWikiPageDetailByPageKey(toolContext(ctx), ctx.UserID, kbID, pageKey)
	if err != nil {
		return nil, err
	}
	return detail, nil
}

func normalizeWikiPageSearch(output any, _ any) rt.ToolNormalizerResult {
	raw, _ := json.Marshal(output)
	var parsed struct {
		Query []string         `json:"query"`
		Items []map[string]any `json:"items"`
	}
	_ = json.Unmarshal(raw, &parsed)
	if len(parsed.Items) == 0 {
		return rt.ToolNormalizerResult{
			Summary:          "没有匹配的 Wiki 页面",
			Data:             mustJSON(map[string]any{"items": []any{}}),
			SuggestedActions: []string{"wiki_overview", "rewrite_query"},
		}
	}
	items := make([]map[string]any, 0, len(parsed.Items))
	for _, item := range parsed.Items {
		items = append(items, map[string]any{
			"pageKey": item["pageKey"], "title": item["title"],
			"kind": item["kind"], "aliases": item["aliases"],
			"summary": item["summary"], "snippet": item["snippet"],
		})
	}
	data := mustJSON(map[string]any{"items": items})
	return rt.ToolNormalizerResult{
		Summary:          "命中 " + itoa(len(items)) + " 个 Wiki 页面（关键词：" + joinStrings(parsed.Query, " / ") + "）",
		Data:             data,
		SuggestedActions: []string{"read_wiki_page_detail"},
		Progress:         boolPtr(true),
	}
}

func normalizeWikiPageRead(output any, _ any) rt.ToolNormalizerResult {
	raw, _ := json.Marshal(output)
	var parsed struct {
		PageKey   string           `json:"pageKey"`
		Title     string           `json:"title"`
		Kind      string           `json:"kind"`
		Aliases   []string         `json:"aliases"`
		ContentMd string           `json:"contentMd"`
		Links     []map[string]any `json:"links"`
		InLinks   []map[string]any `json:"inLinks"`
	}
	_ = json.Unmarshal(raw, &parsed)
	title := parsed.Title
	if title == "" {
		title = parsed.PageKey
		if title == "" {
			title = "Wiki 页面"
		}
	}
	content := trimSpace(parsed.ContentMd)
	if content == "" {
		return rt.ToolNormalizerResult{
			Summary: "「" + title + "」没有可引用的正文内容",
			Data:    mustJSON(map[string]any{"pageKey": parsed.PageKey, "title": title}),
		}
	}
	neighborCount := len(parsed.Links) + len(parsed.InLinks)
	pages := make([]wikiMentionObservationPage, 0, neighborCount+1)
	pageIndex := map[string]int{}
	pages = appendWikiMentionObservationPage(pages, pageIndex, wikiMentionObservationPage{
		PageKey: parsed.PageKey, Title: title, Kind: parsed.Kind, Aliases: parsed.Aliases,
	})
	for _, neighbors := range [][]map[string]any{parsed.Links, parsed.InLinks} {
		for _, neighbor := range neighbors {
			rawNeighbor, _ := json.Marshal(neighbor)
			var page wikiMentionObservationPage
			if json.Unmarshal(rawNeighbor, &page) == nil {
				pages = appendWikiMentionObservationPage(pages, pageIndex, page)
			}
		}
	}
	// 全文读取：正文完整进证据，不在这里裁（与 TS 一致，体积由段内回传与证据预算统一兜底）
	evidenceContent := "[Wiki 页面 " + title + "]\n\n" + content
	meta := map[string]any{"kind": parsed.Kind}
	if parsed.PageKey != "" {
		meta["pageKey"] = parsed.PageKey
	}
	if len(parsed.Aliases) > 0 {
		meta["aliases"] = parsed.Aliases
	}
	return rt.ToolNormalizerResult{
		Summary: fmt.Sprintf("已读取 Wiki 页面「%s」（%d 字%s），回答时请用 [[%s|%s]] 引用",
			title, len([]rune(content)),
			map[bool]string{true: fmt.Sprintf("，%d 个关联页面", neighborCount), false: ""}[neighborCount > 0],
			parsed.PageKey, title),
		Data: mustJSON(map[string]any{
			"pageKey": parsed.PageKey, "title": title, "kind": parsed.Kind,
			"aliases": parsed.Aliases, "excerpt": truncateRunes(content, 400), "pages": pages,
		}),
		Evidence: []rt.EvidenceInput{{
			Source: rt.EvidenceWiki, Title: title, Content: evidenceContent,
			FullRead: true, SourceID: parsed.PageKey,
			Relevance: floatPtr(0.85), Confidence: floatPtr(0.85),
			Metadata: meta,
		}},
		SuggestedActions: []string{"read_wiki_page_detail"},
	}
}

// ===== agent 元工具 =====

func registerAgentMetaTools(registry interface {
	Register(tool *rt.AgentToolDefinition)
}) {
	registry.Register(&rt.AgentToolDefinition{
		ID: "agent.load_skill", Name: "load_skill", Namespace: rt.NamespaceAgent,
		Description: "加载一个能力包（技能），获得对应工具集与操作说明。",
		InputSchema: schemaJSON(`{"type":"object","properties":{"skill":{"type":"string","minLength":1,"maxLength":64,"enum":["knowledge","graph","research","memory","writer","documents","admin","system"]},"skillId":{"type":"string","minLength":1,"maxLength":64,"description":"兼容旧调用；优先使用 skill"}},"anyOf":[{"required":["skill"]},{"required":["skillId"]}]}`),
		RiskLevel:   rt.RiskLow, Core: true, AllowedInSubAgent: toolPtr(false),
		Execute: executeLoadSkill,
		Normalize: func(_ any, input any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{Summary: "技能加载请求已完成", Progress: boolPtr(false)}
		},
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "agent.delegate", Name: "delegate_task", Namespace: rt.NamespaceAgent,
		Description: "把彼此独立的复杂子任务委派给最多 3 个并行子代理。简单问答或单次检索不要委派。",
		InputSchema: schemaJSON(`{"type":"object","properties":{"tasks":{"type":"array","minItems":1,"maxItems":5,"items":{"type":"object","properties":{"objective":{"type":"string","minLength":1,"maxLength":2000},"context":{"type":"string","maxLength":4000},"skillIds":{"type":"array","maxItems":4,"items":{"type":"string","minLength":1}},"allowedToolIds":{"type":"array","maxItems":16,"items":{"type":"string","minLength":1}},"expectedOutput":{"type":"string","maxLength":500},"maxToolCalls":{"type":"integer","minimum":1,"maximum":12}},"required":["objective"]}}},"required":["tasks"]}`),
		RiskLevel:   rt.RiskMedium, Core: true, AllowedInSubAgent: toolPtr(false),
		Execute: executeDelegateTasks,
		Normalize: func(output any, _ any) rt.ToolNormalizerResult {
			payload, _ := output.(map[string]any)
			results, _ := payload["results"].([]map[string]any)
			done := 0
			for _, result := range results {
				if result["status"] == "completed" {
					done++
				}
			}
			normalized := rt.ToolNormalizerResult{
				Summary: fmt.Sprintf("委派 %d 个子任务，完成 %d 个", len(results), done),
				Data:    mustJSON(map[string]any{"results": results}),
			}
			if done < len(results) {
				normalized.SuggestedActions = []string{"handle_failed_subtask_inline"}
			}
			return normalized
		},
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "agent.list_skills", Name: "list_skills", Namespace: rt.NamespaceAgent,
		Description: "列出全部可加载的能力及加载状态。",
		InputSchema: schemaJSON(`{"type":"object","properties":{}}`),
		RiskLevel:   rt.RiskLow, Core: true, AllowedInSubAgent: toolPtr(false),
		Execute: executeListSkills,
		Normalize: func(_ any, _ any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{Summary: "已列出可用能力目录", Progress: boolPtr(false)}
		},
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "agent.get_plan", Name: "get_plan", Namespace: rt.NamespaceAgent,
		Description: "查看当前任务计划与步骤状态。",
		InputSchema: schemaJSON(`{"type":"object","properties":{}}`),
		RiskLevel:   rt.RiskLow, Core: true, AllowedInSubAgent: toolPtr(false),
		Execute: executeGetPlan,
		Normalize: func(_ any, _ any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{Summary: "已返回当前计划", Progress: boolPtr(false)}
		},
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "agent.update_plan", Name: "update_plan", Namespace: rt.NamespaceAgent,
		Description: "增删改查当前计划步骤（op: set/add/update/remove/reorder）。",
		InputSchema: schemaJSON(`{"type":"object","properties":{"ops":{"type":"array","minItems":1,"maxItems":10,"items":{"oneOf":[{"type":"object","properties":{"op":{"const":"set"},"steps":{"type":"array","minItems":1,"maxItems":12,"items":{"type":"object","properties":{"goal":{"type":"string","minLength":1,"maxLength":300},"dependsOn":{"type":"array","maxItems":8,"items":{"type":"string"}}},"required":["goal"]}}},"required":["op","steps"]},{"type":"object","properties":{"op":{"const":"add"},"goal":{"type":"string","minLength":1,"maxLength":300},"afterId":{"type":"string"},"dependsOn":{"type":"array","maxItems":8,"items":{"type":"string"}}},"required":["op","goal"]},{"type":"object","properties":{"op":{"const":"update"},"id":{"type":"string","minLength":1},"goal":{"type":"string","minLength":1,"maxLength":300},"status":{"type":"string","enum":["pending","running","completed","skipped","failed"]},"resultSummary":{"type":"string","maxLength":500}},"required":["op","id"]},{"type":"object","properties":{"op":{"const":"remove"},"id":{"type":"string","minLength":1}},"required":["op","id"]},{"type":"object","properties":{"op":{"const":"reorder"},"orderedIds":{"type":"array","minItems":2,"items":{"type":"string","minLength":1}}},"required":["op","orderedIds"]}]}}},"required":["ops"]}`),
		RiskLevel:   rt.RiskLow, Core: true, AllowedInSubAgent: toolPtr(false),
		Execute: executeUpdatePlan,
		Normalize: func(_ any, _ any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{Summary: "计划已更新", Progress: boolPtr(false)}
		},
	})
}

func executeLoadSkill(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	skillID, _ := params["skill"].(string)
	if skillID == "" {
		skillID, _ = params["skillId"].(string)
	}
	if ctx.Services == nil {
		return nil, rt.PermissionDenied("服务面不可用")
	}
	result := ctx.Services.LoadSkill(skillID)
	payload, _ := json.Marshal(result)
	return json.RawMessage(payload), nil
}

func executeDelegateTasks(ctx *rt.ToolExecutionContext, input any) (any, error) {
	if ctx.Services == nil {
		return nil, rt.PermissionDenied("服务面不可用")
	}
	params, _ := input.(map[string]any)
	rawTasks, _ := params["tasks"].([]any)
	tasks := make([]rt.DelegateTaskInput, 0, len(rawTasks))
	for _, rawTask := range rawTasks {
		taskMap, ok := rawTask.(map[string]any)
		if !ok {
			continue
		}
		task := rt.DelegateTaskInput{
			Objective:      stringValue(taskMap["objective"]),
			Context:        stringValue(taskMap["context"]),
			SkillIDs:       stringSliceValue(taskMap["skillIds"]),
			AllowedToolIDs: stringSliceValue(taskMap["allowedToolIds"]),
			ExpectedOutput: stringValue(taskMap["expectedOutput"]),
			MaxToolCalls:   intValue(taskMap["maxToolCalls"]),
		}
		tasks = append(tasks, task)
	}
	results := ctx.Services.Delegate(tasks)
	publicResults := make([]map[string]any, 0, len(results))
	ok := false
	for _, result := range results {
		if result.Status == "completed" {
			ok = true
		}
		publicResults = append(publicResults, map[string]any{
			"taskId": result.TaskID, "status": result.Status, "summary": result.Summary,
			"evidenceCount": len(result.Evidence),
		})
	}
	return map[string]any{"ok": ok, "results": publicResults}, nil
}

func executeListSkills(ctx *rt.ToolExecutionContext, _ any) (any, error) {
	if ctx.Services == nil {
		return nil, rt.PermissionDenied("服务面不可用")
	}
	return map[string]any{"skills": ctx.Services.ListSkills()}, nil
}

func executeGetPlan(ctx *rt.ToolExecutionContext, _ any) (any, error) {
	if ctx.Services == nil {
		return nil, rt.PermissionDenied("服务面不可用")
	}
	return map[string]any{"plan": ctx.Services.GetPlan()}, nil
}

func executeUpdatePlan(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	opsRaw, _ := params["ops"].([]any)
	ops := make([]rt.PlanUpdateOp, 0, len(opsRaw))
	for _, rawOp := range opsRaw {
		opMap, ok := rawOp.(map[string]any)
		if !ok {
			continue
		}
		op := rt.PlanUpdateOp{}
		op.Op, _ = opMap["op"].(string)
		op.Goal, _ = opMap["goal"].(string)
		op.ID, _ = opMap["id"].(string)
		op.Summary, _ = opMap["resultSummary"].(string)
		op.DependsOn = stringSliceValue(opMap["dependsOn"])
		op.OrderedID = stringSliceValue(opMap["orderedIds"])
		if status, ok := opMap["status"].(string); ok {
			op.Status = rt.AgentPlanStepStatus(status)
		}
		if afterID, ok := opMap["afterId"].(string); ok {
			op.AfterID = afterID
		}
		if steps, ok := opMap["steps"].([]any); ok {
			for _, s := range steps {
				stepMap, ok := s.(map[string]any)
				if !ok {
					continue
				}
				goal, _ := stepMap["goal"].(string)
				op.Steps = append(op.Steps, rt.PlanStepDraft{
					Goal: goal, DependsOn: stringSliceValue(stepMap["dependsOn"]),
				})
			}
		}
		ops = append(ops, op)
	}
	if ctx.Services == nil {
		return nil, rt.PermissionDenied("服务面不可用")
	}
	plan := ctx.Services.UpdatePlan(ops)
	return map[string]any{"plan": plan}, nil
}

// ===== 内置技能 =====

func registerBuiltinSkills(skills interface{ Register(skill rt.AgentSkill) }) {
	skills.Register(rt.AgentSkill{
		ID: "knowledge", Name: "知识库", Description: "检索并深读站内知识库内容",
		Instructions: joinStrings([]string{
			"## 知识库检索与阅读",
			"1. 简单的定义、功能、用途、用法问题优先调用 knowledge.lookup；它会一次完成检索与最相关 1~2 个章节的深读，不要再重复调用 search/read。",
			"2. 复杂比较、跨主题研究或需要自主挑选章节时，使用 knowledge.search 定位候选，再调用 knowledge.read_many 并行深读。",
			"3. knowledge.search 只返回候选（标题/路径/摘要/命中来源），不能当作正文证据。简单问题深读最相关的 1~2 个章节；多步/复杂问题按覆盖面深读 2~4 个。",
			"4. read 返回的层级上下文只用于理解章节位置；事实结论优先依据目标章节正文。",
			"5. 读完发现缺少某个概念或前置信息时，用新的查询词再检索一次，这是被鼓励的多轮检索。",
			"6. 复杂问题可以拆成多个子查询分别检索，系统会自动融合多路召回结果。",
			"7. 当前对话已锁定知识库时沿用该范围；用户明确要求跨库时不要传 knowledgeBaseId。",
			"8. 跨库检索命中的条目，回读时必须把该条目的 knowledgeBaseId 一起传回。",
			"9. 检索不到就如实说明知识库中没有，不要用常识补全内部实现细节。",
			"10. 证据里出现 [本章节可引用的媒体] 时，按 kind 输出对应标签，src 一律用原值（通常是 s4key:…）：image 用 ![说明](src)；video 用自闭合 <video src=\"src\" />；audio 用自闭合 <audio src=\"src\" />；file 用自闭合 <file src=\"src\" name=\"文件名\" />。",
		}, "\n"),
		ToolIDs: []string{"knowledge.lookup", "knowledge.search", "knowledge.read_many", "knowledge.read", "knowledge.list_bases"},
		Tags:    []string{"retrieval"},
	})

	skills.Register(rt.AgentSkill{
		ID: "documents", Name: "文档与内容管理", Description: "文档检索、阅读、文章创建更新、移动与分享",
		Instructions: joinStrings([]string{
			"## 文档操作",
			"1. document.search / document.read 用于检索与阅读文档库内容。",
			"2. create_article / update_article / move_article / create_article_share 只有在用户明确要求实际落库时才能调用，不要把讨论或草稿误当成执行授权。",
			"3. 大段修改文章正文前必须先 preview_article_update，把 diff 给用户审核；小范围、明确的改动可直接更新。",
			"4. update_article 是部分更新：只传需要变更的 title/contentMd，不要为了改标题覆盖正文。",
			"5. 删除、撤销必须调用 request_user_confirmation：删除文章用 action.toolName=delete_article；撤销分享用 revoke_article_share；删除文档库文档用 delete_document。禁止直接调用或假装已执行。",
		}, "\n"),
		ToolIDs: []string{
			"document.list_libraries", "document.search", "document.read", "document.export",
			"document.create", "document.update", "document.preview_update", "document.move", "document.share",
			"agent.request_confirmation",
		},
		Tags: []string{"document"},
	})

	skills.Register(rt.AgentSkill{
		ID: "research", Name: "外部研究", Description: "搜索与阅读站外公开资料",
		Instructions: joinStrings([]string{
			"## 外部资料研究",
			"1. research.search 拿候选来源，research.fetch 抓取正文，research.extract 提取要点。",
			"2. 不要只凭搜索摘要下重要结论：关键结论必须 fetch 原文后再判断。",
			"3. 涉及\"最新 / 当前 / 官方推荐\"的问题，优先官方文档与一手来源，并留意发布时间。",
			"4. 单个来源抓取失败不要放弃整个任务，换一个来源继续。",
		}, "\n"),
		ToolIDs: []string{"research.search", "research.fetch", "research.extract"},
		Tags:    []string{"external"},
	})

	skills.Register(rt.AgentSkill{
		ID: "memory", Name: "长期记忆", Description: "跨会话的长期记忆检索与维护",
		Instructions: joinStrings([]string{
			"## 长期记忆",
			"1. memory.search 检索用户的长期记忆；对话里已经说过的内容不需要再去记忆里查。",
			"2. 只有用户明确要求记住、或该信息长期有效且影响后续协作时才写入记忆。",
			"3. 写入/更新/删除都是有副作用的操作，先确认再执行；不要把敏感凭据写进记忆。",
		}, "\n"),
		ToolIDs: []string{"memory.search", "memory.write", "memory.update", "memory.delete"},
		Tags:    []string{"memory"},
	})

	skills.Register(rt.AgentSkill{
		ID: "writer", Name: "写作", Description: "长文撰写、改写、归纳与结构梳理",
		Instructions: joinStrings([]string{
			"## 写作",
			"1. 写作是操作能力，不是任务分类：先把资料查够，再进入写作。",
			"2. 长篇写作前先确定结构与信息来源；正文中的事实必须来自已获取的证据。",
		}, "\n"),
		ToolIDs: []string{"writer.compose", "writer.rewrite", "writer.summarize", "writer.structure", "writer.save_artifact"},
		Tags:    []string{"generation"},
	})

	skills.Register(rt.AgentSkill{
		ID: "graph", Name: "知识图谱", Description: "实体关系、依赖与关联文章的图谱查询",
		Instructions: joinStrings([]string{
			"## 知识图谱",
			"1. 图谱适合关系型问题：实体依赖、关联文章、路径查询、多跳关系。",
			"2. 图谱不替代普通知识检索：它只覆盖已公开分享的内容，查不到私有知识库正文。",
			"3. 典型组合：knowledge.search → 图谱扩散 → knowledge.read。",
		}, "\n"),
		ToolIDs: []string{"graph.search", "graph.expand", "graph.get_entity", "graph.get_relations"},
		Deps:    []string{"knowledge"},
		Tags:    []string{"retrieval"},
	})

	skills.Register(rt.AgentSkill{
		ID: "admin", Name: "管理", Description: "模型配置、API Key 与站点开关等管理操作",
		Instructions: joinStrings([]string{
			"## 管理操作",
			"1. 管理能力仅限操作员；没有权限时如实说明，不要绕路尝试。",
			"2. bind_ai_model 可在用户明确要求时直接执行；删除供应商、轮换凭证、吊销 Agent Key、修改公开问答开关必须调用 request_user_confirmation。",
			"3. 对应 action.toolName 分别是 delete_ai_provider、update_ai_credential、revoke_agent_api_key、set_public_qa_enabled。",
		}, "\n"),
		ToolIDs: []string{"admin.list_models", "admin.bind_model", "admin.list_api_keys", "admin.get_public_qa", "agent.request_confirmation"},
		Tags:    []string{"admin"},
	})

	skills.Register(rt.AgentSkill{
		ID: "system", Name: "站点概览", Description: "系统与资源清单概览",
		Instructions: joinStrings([]string{
			"## 站点概览",
			"1. 回答\"有多少知识库/文档库/文章\"这类计数与清单问题时，优先用概览类工具，不要对每个库分别做一次检索。",
			"2. 概览结果只说明有什么，不说明内容；要回答内容问题仍需检索。",
		}, "\n"),
		ToolIDs: []string{"system.overview"},
		Tags:    []string{"system"},
	})
}

var _ = context.Background
