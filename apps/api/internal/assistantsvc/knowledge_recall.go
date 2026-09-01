package assistantsvc

// knowledge_recall.go 是 Agent 知识召回主链路。
//
// 目标不是把不同召回源简单拼接，而是保持以下稳定语义：
//   原始分片向量 / 推荐问题向量 / 原始分片 BM25 / 推荐问题 BM25 / Wiki
//     -> RRF -> 文章级筛选 -> 本地重排 -> 多样性过滤 -> 候选章节
//
// 新版分片索引尚未生成时，再降级到存量 Tree 的向量、BM25 和目录推理。

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"petrichor/api/internal/aicore"
	rt "petrichor/api/internal/assistantsvc/runtime"
)

const (
	knowledgeArticleTopK    = 3
	knowledgePerArticleTopK = 4
	knowledgeMaxPerArticle  = 3
	knowledgeVectorTopK     = 10
	knowledgeBM25TopK       = 10
	knowledgeFusionTopK     = 30
	knowledgeRerankTopK     = 10
	knowledgeLexicalPool    = 400
	knowledgeTreeMaxNodes   = 240
	knowledgeTreeTimeout    = 12 * time.Second
)

var (
	knowledgeQuestionSplit = regexp.MustCompile(`[，,；;。？?！!]+\s*`)
	knowledgeConjunction   = regexp.MustCompile(`(?i)(，以及|，还有|，并且|，同时|以及|、并|；|;|，再|，然后|\band\b)`)
	knowledgeQuestionWords = regexp.MustCompile(`(是什么|为什么|怎么样|怎么办|如何|怎样|哪些|哪个|多少|吗|呢|？|\?)`)
)

type knowledgeRecallGroup struct {
	Source string
	Hits   []chunkHit
}

type knowledgeBM25Document struct {
	Hit     chunkHit
	Title   string
	Summary string
	Content string
}

type knowledgeBM25Stat struct {
	doc    knowledgeBM25Document
	counts map[string]float64
	length float64
}

type knowledgeRecallDiagnostics struct {
	Query                string
	RewrittenQueries     []string
	ChunkVectorKeys      []string
	QuestionVectorKeys   []string
	ChunkBM25Keys        []string
	QuestionBM25Keys     []string
	WikiKeys             []string
	TreeKeys             []string
	LegacyVectorKeys     []string
	LegacyBM25Keys       []string
	FusionKeys           []string
	FinalKeys            []string
	SelectedArticleIDs   []string
	DiversityDroppedKeys []string
	TreeAttempted        bool
	TreeReason           string
	RetrievalScope       string
	Degraded             map[string]string
	RetrievalMs          int64
	RerankMs             int64
}

// executeKnowledgeSearchV2 保留原工具输入/输出字段，同时补齐 TS 版本的召回质量链路。
func executeKnowledgeSearchV2(ctx *rt.ToolExecutionContext, input any) (any, error) {
	startedAt := time.Now()
	params, _ := input.(map[string]any)
	query := strings.TrimSpace(stringValue(params["query"]))
	if query == "" {
		return nil, rt.ValidationError("query 不能为空")
	}

	limit := intValue(params["limit"])
	if limit <= 0 {
		limit = intValue(params["topK"])
	}
	if limit <= 0 {
		limit = 10
	}
	if limit > 20 {
		limit = 20
	}

	scope := resolveKnowledgeScope(ctx, params)
	queries, rewritten := buildKnowledgeQueries(query, params["subQueries"])
	diagnostics := knowledgeRecallDiagnostics{
		Query: query, RewrittenQueries: rewritten, Degraded: map[string]string{},
		RetrievalScope: knowledgeRetrievalScope(scope),
	}

	groups := make([]knowledgeRecallGroup, 0, len(queries)*5)
	embeddings, embeddingErr := embedKnowledgeQueries(toolContext(ctx), ctx.UserID, queries)
	if embeddingErr != nil {
		diagnostics.Degraded["chunk_vector"] = embeddingErr.Error()
		diagnostics.Degraded["question_vector"] = embeddingErr.Error()
	}
	for _, current := range queries {
		if embedding := embeddings[current]; embedding != nil {
			for _, source := range []string{"chunk", "question"} {
				hits, searchErr := semanticKnowledgeSource(toolContext(ctx), ctx.UserID, embedding, scope, source, knowledgeVectorTopK)
				name := source + "_vector"
				if searchErr != nil {
					diagnostics.Degraded[name] = searchErr.Error()
					continue
				}
				appendKnowledgeGroup(&groups, name, hits)
			}
		}

		lexicalHitCount := 0
		for _, source := range []string{"chunk", "question"} {
			hits, searchErr := lexicalKnowledgeSource(toolContext(ctx), ctx.UserID, current, scope, source, knowledgeBM25TopK)
			name := source + "_bm25"
			if searchErr != nil {
				diagnostics.Degraded[name] = searchErr.Error()
				continue
			}
			lexicalHitCount += len(hits)
			appendKnowledgeGroup(&groups, name, hits)
		}
		if lexicalHitCount == 0 {
			appendKnowledgeGroup(&groups, "article_title",
				articleTitleFallback(toolContext(ctx), ctx.UserID, current,
					scope.KnowledgeBaseID, scope.HasKnowledgeBase,
					scope.ArticleID, scope.HasArticle, knowledgeBM25TopK))
		}

		if !scope.HasArticle {
			wikiHits, wikiErr := wikiKnowledgeSource(toolContext(ctx), ctx.UserID, current, scope, knowledgeBM25TopK)
			if wikiErr != nil {
				diagnostics.Degraded["wiki"] = wikiErr.Error()
			} else {
				appendKnowledgeGroup(&groups, "wiki", wikiHits)
			}
		}
	}

	// 只有新版分片/Wiki 完全未命中才读取存量 Tree，避免旧目录节点遮住精确分片。
	if !knowledgeGroupsHaveModernHits(groups) {
		legacyGroups := make([]knowledgeRecallGroup, 0, len(queries)*2)
		for _, current := range queries {
			if embedding := embeddings[current]; embedding != nil {
				hits, err := semanticLegacyTreeSource(toolContext(ctx), ctx.UserID, embedding, scope, knowledgeVectorTopK)
				if err != nil {
					diagnostics.Degraded["vector"] = err.Error()
				} else {
					appendKnowledgeGroup(&legacyGroups, "vector", hits)
				}
			}
			hits, err := lexicalLegacyTreeSource(toolContext(ctx), ctx.UserID, current, scope, knowledgeBM25TopK)
			if err != nil {
				diagnostics.Degraded["bm25"] = err.Error()
			} else {
				appendKnowledgeGroup(&legacyGroups, "bm25", hits)
			}
		}
		groups = append(groups, legacyGroups...)

		complex := ctx != nil && ctx.State != nil && ctx.State.Complexity == rt.ComplexityComplex
		if scope.HasKnowledgeBase && (complex || !knowledgeGroupsHaveHits(legacyGroups)) {
			diagnostics.TreeAttempted = true
			if complex {
				diagnostics.TreeReason = "complex_query"
			} else {
				diagnostics.TreeReason = "fast_recall_empty"
			}
			treeHits, err := llmTreeKnowledgeSource(ctx, query, scope, knowledgeVectorTopK)
			if err != nil {
				diagnostics.Degraded["tree"] = err.Error()
			} else {
				appendKnowledgeGroup(&groups, "tree", treeHits)
			}
		}
	}

	diagnostics.collectGroupKeys(groups)
	plainGroups := make([][]chunkHit, 0, len(groups))
	for _, group := range groups {
		if len(group.Hits) > 0 {
			plainGroups = append(plainGroups, group.Hits)
		}
	}
	fused := fuseKnowledgeHits(plainGroups, knowledgeFusionTopK)
	diagnostics.FusionKeys = knowledgeHitKeys(fused)

	articleCandidates, selectedArticles := selectKnowledgeArticleStage(
		fused,
		map[bool]int{true: 1, false: knowledgeArticleTopK}[scope.HasArticle],
		knowledgePerArticleTopK,
	)
	diagnostics.SelectedArticleIDs = selectedArticles

	rerankStartedAt := time.Now()
	rerankCount := knowledgeRerankTopK
	if rerankCount > len(articleCandidates) {
		rerankCount = len(articleCandidates)
	}
	reranked := rerankKnowledgeLocally(query, append([]chunkHit{}, articleCandidates[:rerankCount]...))
	rerankApplied := rerankCount > 1
	diagnostics.RerankMs = time.Since(rerankStartedAt).Milliseconds()

	maxPerArticle := knowledgeMaxPerArticle
	if scope.HasArticle {
		maxPerArticle = limit
	}
	finalHits, dropped := selectDiverseKnowledgeHits(reranked, limit, maxPerArticle)
	for _, candidate := range articleCandidates {
		if len(finalHits) >= limit {
			break
		}
		if containsKnowledgeHit(finalHits, candidate) || !canAppendKnowledgeHit(finalHits, candidate, maxPerArticle) {
			continue
		}
		finalHits = append(finalHits, candidate)
	}
	diagnostics.DiversityDroppedKeys = dropped
	diagnostics.FinalKeys = knowledgeHitKeys(finalHits)
	diagnostics.RetrievalMs = time.Since(startedAt).Milliseconds()

	knowledgeBaseNames := loadKnowledgeBaseNames(toolContext(ctx), ctx.UserID)
	items := make([]map[string]any, 0, len(finalHits))
	for _, hit := range finalHits {
		knowledgeBaseName, hasKnowledgeBaseName := knowledgeBaseNames[hit.KnowledgeBaseID]
		item := map[string]any{
			"knowledgeBaseId": fmt.Sprintf("%d", hit.KnowledgeBaseID),
			"title":           hit.Title, "summary": hit.Snippet,
			"score": roundFloat(hit.Score), "recallSources": hit.RecallSources,
		}
		if hasKnowledgeBaseName {
			item["knowledgeBaseName"] = knowledgeBaseName
		} else {
			item["knowledgeBaseName"] = nil
		}
		if hit.Path != "" {
			item["path"] = strings.Split(hit.Path, " › ")
		}
		if hit.ArticleID > 0 {
			item["articleId"] = fmt.Sprintf("%d", hit.ArticleID)
			item["href"] = fmt.Sprintf("/dashboard/knowledge/%d/articles/%d", hit.KnowledgeBaseID, hit.ArticleID)
		} else {
			item["href"] = fmt.Sprintf("/dashboard/knowledge/%d", hit.KnowledgeBaseID)
		}
		if hit.ChunkID > 0 {
			item["chunkId"] = fmt.Sprintf("%d", hit.ChunkID)
		}
		if hit.PageKey != "" {
			item["pageKey"] = hit.PageKey
		}
		if hit.NodeKey != "" {
			item["nodeKey"] = hit.NodeKey
		}
		if hit.RerankScore != nil {
			item["rerankScore"] = roundFloat(*hit.RerankScore)
		}
		items = append(items, item)
	}

	output := map[string]any{
		"mode": "hybrid", "hits": items, "diagnostics": diagnostics.toMap(rerankApplied),
	}
	if scope.HasKnowledgeBase {
		output["knowledgeBaseId"] = fmt.Sprintf("%d", scope.KnowledgeBaseID)
		if name, exists := knowledgeBaseNames[scope.KnowledgeBaseID]; exists {
			output["knowledgeBaseName"] = name
		} else {
			output["knowledgeBaseName"] = nil
		}
	} else {
		output["mode"] = "cross_kb"
		output["retrievalMode"] = "hybrid"
	}
	return output, nil
}

func loadKnowledgeBaseNames(ctx context.Context, userID int64) map[int64]string {
	rows, err := dbPool().Query(ctx,
		`SELECT id, name FROM petrichor_kb_knowledge_base WHERE user_id = $1`, userID)
	if err != nil {
		return map[int64]string{}
	}
	defer rows.Close()
	out := map[int64]string{}
	for rows.Next() {
		var id int64
		var name string
		if rows.Scan(&id, &name) == nil {
			out[id] = name
		}
	}
	return out
}

func knowledgeRetrievalScope(scope knowledgeScope) string {
	if scope.HasArticle {
		return "focused_article"
	}
	if scope.HasKnowledgeBase {
		return "article_then_chapter"
	}
	return "cross_kb_article_then_chapter"
}

func appendKnowledgeGroup(groups *[]knowledgeRecallGroup, source string, hits []chunkHit) {
	if len(hits) == 0 {
		return
	}
	for index := range hits {
		hits[index].RecallSources = []string{source}
	}
	*groups = append(*groups, knowledgeRecallGroup{Source: source, Hits: hits})
}

func knowledgeGroupsHaveHits(groups []knowledgeRecallGroup) bool {
	for _, group := range groups {
		if len(group.Hits) > 0 {
			return true
		}
	}
	return false
}

func knowledgeGroupsHaveModernHits(groups []knowledgeRecallGroup) bool {
	for _, group := range groups {
		if len(group.Hits) == 0 {
			continue
		}
		switch group.Source {
		case "chunk_vector", "question_vector", "chunk_bm25", "question_bm25", "wiki":
			return true
		}
	}
	return false
}

func buildKnowledgeQueries(primary string, raw any) ([]string, []string) {
	primary = strings.TrimSpace(primary)
	explicit := stringValues(raw)
	if len(explicit) == 0 {
		explicit = rewriteKnowledgeQuery(primary, 3)
	}
	queries := []string{primary}
	seen := map[string]bool{strings.ToLower(primary): true}
	for _, value := range explicit {
		value = strings.TrimSpace(value)
		key := strings.ToLower(value)
		if len([]rune(value)) < 2 || seen[key] {
			continue
		}
		seen[key] = true
		queries = append(queries, value)
		if len(queries) >= 4 {
			break
		}
	}
	return queries, append([]string{}, queries[1:]...)
}

func stringValues(raw any) []string {
	switch values := raw.(type) {
	case []any:
		out := make([]string, 0, len(values))
		for _, value := range values {
			if text, ok := value.(string); ok {
				out = append(out, text)
			}
		}
		return out
	case []string:
		return append([]string{}, values...)
	default:
		return nil
	}
}

func rewriteKnowledgeQuery(query string, max int) []string {
	text := strings.TrimSpace(query)
	if len([]rune(text)) < 18 {
		return nil
	}
	parts := knowledgeQuestionSplit.Split(text, -1)
	longParts := 0
	for _, part := range parts {
		if len([]rune(strings.TrimSpace(part))) >= 4 {
			longParts++
		}
	}
	if longParts < 2 && !knowledgeConjunction.MatchString(text) {
		return nil
	}
	replaced := knowledgeConjunction.ReplaceAllString(text, "|")
	clauses := strings.FieldsFunc(replaced, func(r rune) bool {
		return strings.ContainsRune("|，,；;。？?！!", r)
	})
	out := make([]string, 0, max)
	seen := map[string]bool{}
	for _, clause := range clauses {
		clause = trimKnowledgeQuestionPrefix(strings.TrimSpace(clause))
		clause = strings.TrimSpace(knowledgeQuestionWords.ReplaceAllString(clause, " "))
		if len([]rune(clause)) < 4 || clause == text || seen[clause] {
			continue
		}
		seen[clause] = true
		out = append(out, clause)
		if len(out) >= max {
			break
		}
	}
	return out
}

func trimKnowledgeQuestionPrefix(value string) string {
	for _, prefix := range []string{"请问", "想知道", "帮我", "麻烦", "我想", "能否", "可以", "请", "那么", "另外", "以及", "还有"} {
		if strings.HasPrefix(value, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(value, prefix))
		}
	}
	return value
}

func embedKnowledgeQueries(ctx context.Context, userID int64, queries []string) (map[string]*queryEmbedding, error) {
	out := make(map[string]*queryEmbedding, len(queries))
	if len(queries) == 0 {
		return out, nil
	}
	resolved, err := aicore.ResolveModelForPurpose(ctx, userID, aicore.PurposeEmbedding, nil)
	if err != nil {
		return out, err
	}
	vectors, err := aicore.Embeddings(ctx, resolved.Runtime, resolved.ModelRef, queries)
	if err != nil {
		return out, err
	}
	for index, query := range queries {
		if index >= len(vectors) || len(vectors[index]) == 0 {
			continue
		}
		out[query] = &queryEmbedding{Vector: vectors[index], Model: resolved.ModelRef}
	}
	if len(out) == 0 {
		return out, fmt.Errorf("向量模型返回空向量")
	}
	return out, nil
}

func semanticKnowledgeSource(
	ctx context.Context,
	userID int64,
	embedding *queryEmbedding,
	scope knowledgeScope,
	sourceType string,
	topK int,
) ([]chunkHit, error) {
	if embedding == nil || len(embedding.Vector) == 0 {
		return nil, nil
	}
	fetchLimit := topK
	if sourceType == "question" {
		fetchLimit *= 3
	}
	sqlText := `SELECT i.article_id, i.knowledge_base_id, i.chunk_id, a.title,
		       COALESCE(c.heading, ''), COALESCE(c.heading_path_json, '[]'),
		       i.content, c.content_md,
		       (1 - (i.embedding <=> $2::vector))::float8 AS score
		FROM petrichor_kb_article_chunk_index i
		JOIN petrichor_kb_article_chunk c ON c.id = i.chunk_id AND c.user_id = i.user_id
		JOIN petrichor_kb_article a ON a.id = i.article_id AND a.user_id = i.user_id
		WHERE i.user_id = $1 AND i.embedding_status = 'ready'
		  AND i.embedding_model = $3 AND i.embedding_dimensions = $4
		  AND i.embedding_version = 1 AND i.source_type = $5`
	args := []any{userID, vectorLiteral(embedding.Vector), embedding.Model, len(embedding.Vector), sourceType}
	if scope.HasKnowledgeBase {
		sqlText += fmt.Sprintf(` AND i.knowledge_base_id = $%d`, len(args)+1)
		args = append(args, scope.KnowledgeBaseID)
	}
	if scope.HasArticle {
		sqlText += fmt.Sprintf(` AND i.article_id = $%d`, len(args)+1)
		args = append(args, scope.ArticleID)
	}
	sqlText += fmt.Sprintf(` ORDER BY i.embedding <=> $2::vector LIMIT $%d`, len(args)+1)
	args = append(args, fetchLimit)

	rows, err := dbPool().Query(ctx, sqlText, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hits := make([]chunkHit, 0, topK)
	seen := map[int64]bool{}
	for rows.Next() {
		var articleID, knowledgeBaseID, chunkID int64
		var articleTitle, heading, pathJSON, matchedContent, content string
		var score float64
		if err := rows.Scan(&articleID, &knowledgeBaseID, &chunkID, &articleTitle,
			&heading, &pathJSON, &matchedContent, &content, &score); err != nil {
			return nil, err
		}
		if seen[chunkID] {
			continue
		}
		seen[chunkID] = true
		hits = append(hits, makeChunkKnowledgeHit(articleID, knowledgeBaseID, chunkID,
			articleTitle, heading, pathJSON, sourceType, matchedContent, content, score))
		if len(hits) >= topK {
			break
		}
	}
	return hits, rows.Err()
}

func lexicalKnowledgeSource(
	ctx context.Context,
	userID int64,
	query string,
	scope knowledgeScope,
	sourceType string,
	topK int,
) ([]chunkHit, error) {
	tokens := buildQueryTokens(query)
	patterns := likePatterns(tokens)
	if len(patterns) == 0 {
		return nil, nil
	}
	load := func(filter string, filterArg any, ranked bool) ([]knowledgeBM25Document, error) {
		sqlText := `SELECT i.article_id, i.knowledge_base_id, i.chunk_id, a.title,
		       COALESCE(c.heading, ''), COALESCE(c.heading_path_json, '[]'),
		       i.content, i.embedding_text, c.content_md
		FROM petrichor_kb_article_chunk_index i
		JOIN petrichor_kb_article_chunk c ON c.id = i.chunk_id AND c.user_id = i.user_id
		JOIN petrichor_kb_article a ON a.id = i.article_id AND a.user_id = i.user_id
		WHERE i.user_id = $1 AND ` + filter + ` AND i.source_type = $3`
		args := []any{userID, filterArg, sourceType}
		if scope.HasKnowledgeBase {
			sqlText += fmt.Sprintf(` AND i.knowledge_base_id = $%d`, len(args)+1)
			args = append(args, scope.KnowledgeBaseID)
		}
		if scope.HasArticle {
			sqlText += fmt.Sprintf(` AND i.article_id = $%d`, len(args)+1)
			args = append(args, scope.ArticleID)
		}
		if ranked {
			sqlText += ` ORDER BY ts_rank_cd(i.search_vector, to_tsquery('simple', $2)) DESC`
		}
		sqlText += fmt.Sprintf(` LIMIT $%d`, len(args)+1)
		args = append(args, knowledgeLexicalPool)

		rows, err := dbPool().Query(ctx, sqlText, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		docs := make([]knowledgeBM25Document, 0, knowledgeLexicalPool)
		for rows.Next() {
			var articleID, knowledgeBaseID, chunkID int64
			var articleTitle, heading, pathJSON, matchedContent, embeddingText, content string
			if err := rows.Scan(&articleID, &knowledgeBaseID, &chunkID, &articleTitle,
				&heading, &pathJSON, &matchedContent, &embeddingText, &content); err != nil {
				return nil, err
			}
			hit := makeChunkKnowledgeHit(articleID, knowledgeBaseID, chunkID,
				articleTitle, heading, pathJSON, sourceType, matchedContent, content, 0)
			docs = append(docs, knowledgeBM25Document{
				Hit: hit, Title: strings.TrimSpace(articleTitle + " " + heading),
				Summary: hit.Path, Content: embeddingText,
			})
		}
		return docs, rows.Err()
	}

	// 优先走 GIN 候选池；迁移尚未执行或索引没有返回结果时，退回全表 n-gram 条件。
	if tsquery := buildKnowledgeTSQuery(tokens); tsquery != "" {
		docs, err := load(`i.search_vector @@ to_tsquery('simple', $2)`, tsquery, true)
		if err == nil && len(docs) > 0 {
			return rankKnowledgeBM25(docs, query, topK), nil
		}
	}
	docs, err := load(`i.search_tokens ILIKE ANY($2)`, patterns, false)
	if err != nil {
		return nil, err
	}
	return rankKnowledgeBM25(docs, query, topK), nil
}

func buildKnowledgeTSQuery(tokens []string) string {
	if len(tokens) > 48 {
		tokens = tokens[:48]
	}
	clean := make([]string, 0, len(tokens))
	for _, token := range tokens {
		var builder strings.Builder
		for _, r := range token {
			if unicodeKnowledgeTokenRune(r) {
				builder.WriteRune(r)
			}
		}
		if builder.Len() > 0 {
			clean = append(clean, builder.String())
		}
	}
	return strings.Join(clean, " | ")
}

func unicodeKnowledgeTokenRune(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
		(r >= '0' && r <= '9') || cjkRange(r)
}

func makeChunkKnowledgeHit(
	articleID, knowledgeBaseID, chunkID int64,
	articleTitle, heading, pathJSON, sourceType, matchedContent, content string,
	score float64,
) chunkHit {
	title := strings.TrimSpace(heading)
	if title == "" {
		title = articleTitle
	}
	snippet := compactKnowledgeText(content, 220)
	if sourceType == "question" && strings.TrimSpace(matchedContent) != "" {
		snippet = "用户问法：" + compactKnowledgeText(matchedContent, 220)
	}
	return chunkHit{
		ArticleID: articleID, KnowledgeBaseID: knowledgeBaseID, ChunkID: chunkID,
		CandidateKind: "chunk", Title: title,
		Path:    renderKnowledgeChunkPath(articleTitle, pathJSON, heading),
		Snippet: snippet, Score: score, Content: content, MatchedContent: matchedContent,
	}
}

func renderKnowledgeChunkPath(articleTitle, raw, heading string) string {
	var path []string
	_ = json.Unmarshal([]byte(raw), &path)
	if len(path) == 0 && strings.TrimSpace(heading) != "" {
		path = []string{heading}
	}
	parts := []string{}
	for _, value := range append([]string{articleTitle}, path...) {
		value = strings.TrimSpace(value)
		if value == "" || (len(parts) > 0 && parts[len(parts)-1] == value) {
			continue
		}
		parts = append(parts, value)
	}
	return strings.Join(parts, " › ")
}

func compactKnowledgeText(value string, max int) string {
	value = strings.Join(strings.Fields(value), " ")
	if len([]rune(value)) <= max {
		return value
	}
	return string([]rune(value)[:max]) + "…"
}

func rankKnowledgeBM25(documents []knowledgeBM25Document, query string, topK int) []chunkHit {
	terms := buildQueryTokens(query)
	if len(terms) == 0 || len(documents) == 0 {
		return nil
	}
	termSet := map[string]bool{}
	for _, term := range terms {
		termSet[term] = true
	}
	stats := make([]knowledgeBM25Stat, 0, len(documents))
	for _, doc := range documents {
		stat := knowledgeBM25Stat{doc: doc, counts: map[string]float64{}}
		accumulate := func(text string, weight float64) {
			if strings.TrimSpace(text) == "" || weight <= 0 {
				return
			}
			for _, token := range buildIndexTokens(text) {
				stat.length += weight
				if termSet[token] {
					stat.counts[token] += weight
				}
			}
		}
		accumulate(doc.Title, 3)
		accumulate(doc.Summary, 2)
		accumulate(doc.Content, 1)
		stats = append(stats, stat)
	}
	docFreq := map[string]int{}
	avgLength := float64(0)
	for _, stat := range stats {
		avgLength += stat.length
		for term := range stat.counts {
			docFreq[term]++
		}
	}
	avgLength /= float64(maxInt(1, len(stats)))
	type scored struct {
		hit   chunkHit
		score float64
		index int
	}
	ranked := make([]scored, 0, len(stats))
	for index, stat := range stats {
		score := float64(0)
		for _, term := range terms {
			tf := stat.counts[term]
			if tf == 0 {
				continue
			}
			df := float64(maxInt(1, docFreq[term]))
			corpus := float64(len(stats))
			idf := math.Log(1 + (corpus-df+0.5)/(df+0.5))
			norm := tf * 2.5 / (tf + 1.5*(1-0.75+0.75*(stat.length/math.Max(1, avgLength))))
			score += idf * norm
		}
		if score > 0 {
			hit := stat.doc.Hit
			hit.Score = score
			ranked = append(ranked, scored{hit: hit, score: score, index: index})
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].score != ranked[j].score {
			return ranked[i].score > ranked[j].score
		}
		return ranked[i].index < ranked[j].index
	})
	hits := make([]chunkHit, 0, topK)
	seen := map[string]bool{}
	for _, item := range ranked {
		key := hitKey(item.hit)
		if seen[key] {
			continue
		}
		seen[key] = true
		hits = append(hits, item.hit)
		if len(hits) >= topK {
			break
		}
	}
	return hits
}
