package assistantsvc

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	rt "petrichor/api/internal/assistantsvc/runtime"
)

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

// selectKnowledgeLookupReadTargets 保留最高相关候选，并尽量补读一个 Wiki 页面。
// Wiki 详情会带回关联页词典，回答渲染才能把正文和表格里的相关概念都补成可点击内链；
// 若只按总排序读取前两个普通分片，命中的 Wiki 页面稍靠后时就只会高亮主实体。
func selectKnowledgeLookupReadTargets(hits []map[string]any, limit int) []map[string]any {
	if limit <= 0 || len(hits) == 0 {
		return nil
	}
	selected := make([]map[string]any, 0, minIntLocal(len(hits), limit))
	selected = append(selected, hits[0])
	if limit > 1 && strings.TrimSpace(stringValue(hits[0]["pageKey"])) == "" {
		for _, hit := range hits[1:] {
			if strings.TrimSpace(stringValue(hit["pageKey"])) != "" {
				selected = append(selected, hit)
				break
			}
		}
	}
	for _, hit := range hits[1:] {
		if len(selected) >= limit {
			break
		}
		alreadySelected := false
		for _, current := range selected {
			if hitKeyFromMap(current) == hitKeyFromMap(hit) {
				alreadySelected = true
				break
			}
		}
		if !alreadySelected {
			selected = append(selected, hit)
		}
	}
	return selected
}

func hitKeyFromMap(hit map[string]any) string {
	for _, key := range []string{"chunkId", "pageKey", "nodeKey", "articleId"} {
		if value := strings.TrimSpace(stringValue(hit[key])); value != "" {
			return key + ":" + value
		}
	}
	raw, _ := json.Marshal(hit)
	return string(raw)
}

// executeKnowledgeLookup 复合检索：search + 深读最相关候选，并优先覆盖一个 Wiki 页面。
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
	for _, hit := range selectKnowledgeLookupReadTargets(hits, len(hits)) {
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
