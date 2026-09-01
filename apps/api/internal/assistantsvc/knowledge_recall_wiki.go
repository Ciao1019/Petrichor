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
	"sort"
	"strings"

	rt "petrichor/api/internal/assistantsvc/runtime"
	"petrichor/api/internal/kb"
)

func wikiKnowledgeSource(ctx context.Context, userID int64, query string, scope knowledgeScope, topK int) ([]chunkHit, error) {
	patterns := likePatterns(buildQueryTokens(query))
	if len(patterns) == 0 {
		return nil, nil
	}
	sqlText := `SELECT id, user_id, knowledge_base_id, page_key, title, kind,
		       content_md, summary, frontmatter_json,
		       COALESCE(EXTRACT(EPOCH FROM updated_at)::bigint, 0)
		FROM petrichor_kb_wiki_page
		WHERE user_id = $1 AND archived_at IS NULL
		  AND kind NOT IN ('source', 'index', 'log')
		  AND (title ILIKE ANY($2) OR page_key ILIKE ANY($2)
		       OR COALESCE(summary, '') ILIKE ANY($2)
		       OR content_md ILIKE ANY($2)
		       OR COALESCE(frontmatter_json, '') ILIKE ANY($2))`
	args := []any{userID, patterns}
	if scope.HasKnowledgeBase {
		sqlText += fmt.Sprintf(` AND knowledge_base_id = $%d`, len(args)+1)
		args = append(args, scope.KnowledgeBaseID)
	}
	sqlText += fmt.Sprintf(` LIMIT $%d`, len(args)+1)
	args = append(args, knowledgeLexicalPool)
	rows, err := dbPool().Query(ctx, sqlText, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	pages := scanWikiPageRows(rows)
	if err := rows.Err(); err != nil {
		return nil, err
	}
	type scored struct {
		hit   chunkHit
		score float64
		index int
	}
	ranked := make([]scored, 0, len(pages))
	for index, page := range pages {
		if page.Kind == "source" || page.Kind == "index" || page.Kind == "log" {
			continue
		}
		summary := ""
		if page.Summary != nil {
			summary = *page.Summary
		}
		extra := page.PageKey + " " + strings.Join(bridgeFrontmatterAliases(page.FrontmatterJSON), " ")
		score := scoreKnowledgeFields(page.Title, summary, page.ContentMd, extra, query)
		if score <= 0 {
			continue
		}
		snippet := compactKnowledgeText(summary, 220)
		if snippet == "" {
			snippet = compactKnowledgeText(page.ContentMd, 220)
		}
		ranked = append(ranked, scored{hit: chunkHit{
			KnowledgeBaseID: page.KnowledgeBaseID, PageKey: page.PageKey,
			CandidateKind: "wiki_page", Title: page.Title, Snippet: snippet,
			Content: page.ContentMd, Score: score,
		}, score: score, index: index})
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].score != ranked[j].score {
			return ranked[i].score > ranked[j].score
		}
		return ranked[i].index < ranked[j].index
	})
	if len(ranked) > topK {
		ranked = ranked[:topK]
	}
	hits := make([]chunkHit, 0, len(ranked))
	for _, item := range ranked {
		hits = append(hits, item.hit)
	}
	return hits, nil
}

func scoreKnowledgeFields(title, summary, content, extra, query string) float64 {
	normalizedQuery := normalizeKnowledgeText(query)
	titleNorm := normalizeKnowledgeText(title)
	summaryNorm := normalizeKnowledgeText(summary)
	contentNorm := normalizeKnowledgeText(content)
	extraNorm := normalizeKnowledgeText(extra)
	score := float64(0)
	if normalizedQuery != "" {
		if strings.Contains(titleNorm, normalizedQuery) {
			score += 8
		}
		if strings.Contains(summaryNorm, normalizedQuery) {
			score += 4
		}
		if strings.Contains(contentNorm, normalizedQuery) {
			score += 2
		}
		if strings.Contains(extraNorm, normalizedQuery) {
			score += 2
		}
	}
	for _, token := range buildQueryTokens(query) {
		token = normalizeKnowledgeText(token)
		if token == "" {
			continue
		}
		if strings.Contains(titleNorm, token) {
			score += 4
		}
		if strings.Contains(summaryNorm, token) {
			score += 2
		}
		if strings.Contains(contentNorm, token) {
			score += 1
		}
		if strings.Contains(extraNorm, token) {
			score += 1
		}
	}
	return score
}

func semanticLegacyTreeSource(ctx context.Context, userID int64, embedding *queryEmbedding, scope knowledgeScope, topK int) ([]chunkHit, error) {
	sqlText := `SELECT node_key, article_id, knowledge_base_id, title,
		       COALESCE(summary, ''), content_md,
		       (1 - (embedding <=> $2::vector))::float8 AS score
		FROM petrichor_kb_wiki_tree_node
		WHERE user_id = $1 AND embedding IS NOT NULL AND embedding_status = 'ready'
		  AND embedding_model = $3 AND embedding_dimensions = $4
		  AND embedding_version = 1`
	args := []any{userID, vectorLiteral(embedding.Vector), embedding.Model, len(embedding.Vector)}
	if scope.HasKnowledgeBase {
		sqlText += fmt.Sprintf(` AND knowledge_base_id = $%d`, len(args)+1)
		args = append(args, scope.KnowledgeBaseID)
	}
	if scope.HasArticle {
		sqlText += fmt.Sprintf(` AND article_id = $%d`, len(args)+1)
		args = append(args, scope.ArticleID)
	}
	sqlText += fmt.Sprintf(` ORDER BY embedding <=> $2::vector LIMIT $%d`, len(args)+1)
	args = append(args, topK)
	rows, err := dbPool().Query(ctx, sqlText, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hits := []chunkHit{}
	for rows.Next() {
		var hit chunkHit
		if err := rows.Scan(&hit.NodeKey, &hit.ArticleID, &hit.KnowledgeBaseID,
			&hit.Title, &hit.Snippet, &hit.Content, &hit.Score); err != nil {
			return nil, err
		}
		hit.CandidateKind = "tree"
		hit.Path = hit.Title
		if strings.TrimSpace(hit.Snippet) == "" {
			hit.Snippet = compactKnowledgeText(hit.Content, 220)
		}
		hits = append(hits, hit)
	}
	return hits, rows.Err()
}

func lexicalLegacyTreeSource(ctx context.Context, userID int64, query string, scope knowledgeScope, topK int) ([]chunkHit, error) {
	tokens := buildQueryTokens(query)
	patterns := likePatterns(tokens)
	if len(patterns) == 0 {
		return nil, nil
	}
	load := func(filter string, filterArg any, ranked bool) ([]knowledgeBM25Document, error) {
		sqlText := `SELECT node_key, article_id, knowledge_base_id, title,
		       COALESCE(summary, ''), content_md
		FROM petrichor_kb_wiki_tree_node
		WHERE user_id = $1 AND ` + filter
		args := []any{userID, filterArg}
		if scope.HasKnowledgeBase {
			sqlText += fmt.Sprintf(` AND knowledge_base_id = $%d`, len(args)+1)
			args = append(args, scope.KnowledgeBaseID)
		}
		if scope.HasArticle {
			sqlText += fmt.Sprintf(` AND article_id = $%d`, len(args)+1)
			args = append(args, scope.ArticleID)
		}
		if ranked {
			sqlText += ` ORDER BY ts_rank_cd(search_vector, to_tsquery('simple', $2)) DESC`
		}
		sqlText += fmt.Sprintf(` LIMIT $%d`, len(args)+1)
		args = append(args, knowledgeLexicalPool)
		rows, err := dbPool().Query(ctx, sqlText, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		docs := []knowledgeBM25Document{}
		for rows.Next() {
			var hit chunkHit
			if err := rows.Scan(&hit.NodeKey, &hit.ArticleID, &hit.KnowledgeBaseID,
				&hit.Title, &hit.Snippet, &hit.Content); err != nil {
				return nil, err
			}
			hit.CandidateKind = "tree"
			hit.Path = hit.Title
			docs = append(docs, knowledgeBM25Document{Hit: hit, Title: hit.Title, Summary: hit.Snippet, Content: hit.Content})
		}
		return docs, rows.Err()
	}
	if tsquery := buildKnowledgeTSQuery(tokens); tsquery != "" {
		docs, err := load(`search_vector @@ to_tsquery('simple', $2)`, tsquery, true)
		if err == nil && len(docs) > 0 {
			return rankKnowledgeBM25(docs, query, topK), nil
		}
	}
	fallback := `(COALESCE(search_title_tokens, '') ILIKE ANY($2)
		OR COALESCE(search_summary_tokens, '') ILIKE ANY($2)
		OR COALESCE(search_content_tokens, '') ILIKE ANY($2))`
	docs, err := load(fallback, patterns, false)
	if err != nil {
		return nil, err
	}
	return rankKnowledgeBM25(docs, query, topK), nil
}

func llmTreeKnowledgeSource(ctx *rt.ToolExecutionContext, query string, scope knowledgeScope, limit int) ([]chunkHit, error) {
	if !scope.HasKnowledgeBase || kb.ChatInvoker == nil {
		return nil, nil
	}
	var articleID *int64
	if scope.HasArticle {
		articleID = &scope.ArticleID
	}
	nodes, err := kb.LoadTreeNodesForAgent(toolContext(ctx), dbPool(), ctx.UserID, scope.KnowledgeBaseID, articleID)
	if err != nil || len(nodes) == 0 {
		return nil, err
	}
	if len(nodes) > knowledgeTreeMaxNodes {
		return nil, fmt.Errorf("目录节点过多，已跳过模型导航")
	}
	byKey := map[string]*kb.TreeNodeRow{}
	outline := make([]string, 0, len(nodes))
	for index := range nodes {
		node := &nodes[index]
		byKey[node.NodeKey] = node
		summary := ""
		if node.Summary != nil && strings.TrimSpace(*node.Summary) != "" {
			summary = " — " + strings.TrimSpace(*node.Summary)
		}
		outline = append(outline, strings.Repeat("  ", int(node.Depth))+"- ["+node.NodeKey+"] "+node.Title+summary)
	}
	callCtx, cancel := context.WithTimeout(toolContext(ctx), knowledgeTreeTimeout)
	defer cancel()
	answer, err := kb.ChatInvoker(callCtx, kb.ChatRequest{
		UserID: ctx.UserID,
		SystemPrompt: strings.Join([]string{
			"你在用推理式检索浏览文档目录树。",
			"请选择最能直接回答问题的节点，按相关度排序。",
			"只输出 JSON：{\"nodes\":[{\"nodeKey\":\"...\",\"reason\":\"...\"}]}。",
			"nodeKey 必须来自目录，最多选择要求的数量。",
		}, "\n"),
		Message: "问题：" + query + "\n最多选择 " + fmt.Sprintf("%d", limit) + " 个节点。\n\n目录：\n" + strings.Join(outline, "\n"),
		Op:      "kb.doc.tree.retrieve",
	})
	if err != nil {
		return nil, err
	}
	parsed := struct {
		Nodes []struct {
			NodeKey string `json:"nodeKey"`
			Reason  string `json:"reason"`
		} `json:"nodes"`
	}{}
	if err := json.Unmarshal([]byte(extractKnowledgeJSONObject(answer)), &parsed); err != nil {
		return nil, fmt.Errorf("目录导航结果无法解析: %w", err)
	}
	hits := []chunkHit{}
	seen := map[string]bool{}
	for _, selected := range parsed.Nodes {
		node := byKey[selected.NodeKey]
		if node == nil || seen[node.NodeKey] {
			continue
		}
		seen[node.NodeKey] = true
		summary := ""
		if node.Summary != nil {
			summary = strings.TrimSpace(*node.Summary)
		}
		if summary == "" {
			summary = compactKnowledgeText(node.ContentMd, 220)
		}
		hits = append(hits, chunkHit{
			ArticleID: node.ArticleID, KnowledgeBaseID: node.KnowledgeBaseID,
			NodeKey: node.NodeKey, CandidateKind: "tree", Title: node.Title,
			Path: treeKnowledgePath(node, byKey), Snippet: summary,
			Content: node.ContentMd, Score: 1 / float64(len(hits)+1),
		})
		if len(hits) >= limit {
			break
		}
	}
	return hits, nil
}

func extractKnowledgeJSONObject(value string) string {
	start := strings.Index(value, "{")
	end := strings.LastIndex(value, "}")
	if start < 0 || end < start {
		return value
	}
	return value[start : end+1]
}

func treeKnowledgePath(node *kb.TreeNodeRow, byKey map[string]*kb.TreeNodeRow) string {
	parts := []string{}
	seen := map[string]bool{}
	current := node
	for current != nil && !seen[current.NodeKey] {
		seen[current.NodeKey] = true
		parts = append([]string{current.Title}, parts...)
		if current.ParentKey == nil {
			break
		}
		current = byKey[*current.ParentKey]
	}
	return strings.Join(parts, " › ")
}

func selectKnowledgeArticleStage(hits []chunkHit, articleTopK, perArticleTopK int) ([]chunkHit, []string) {
	type indexed struct {
		hit   chunkHit
		index int
	}
	type articleGroup struct {
		key        string
		items      []indexed
		score      float64
		firstIndex int
	}
	groups := map[string][]indexed{}
	order := []string{}
	for index, hit := range hits {
		key := knowledgeArticleKey(hit)
		if _, exists := groups[key]; !exists {
			order = append(order, key)
		}
		groups[key] = append(groups[key], indexed{hit: hit, index: index})
	}
	ranked := make([]articleGroup, 0, len(groups))
	for _, key := range order {
		items := groups[key]
		scores := make([]float64, 0, len(items))
		maxSources := 0
		firstIndex := len(hits)
		for _, item := range items {
			scores = append(scores, item.hit.Score)
			if len(item.hit.RecallSources) > maxSources {
				maxSources = len(item.hit.RecallSources)
			}
			if item.index < firstIndex {
				firstIndex = item.index
			}
		}
		sort.Sort(sort.Reverse(sort.Float64Slice(scores)))
		score := scores[0]
		if len(scores) > 1 {
			score += scores[1] * 0.35
		}
		if len(scores) > 2 {
			score += scores[2] * 0.15
		}
		score += float64(maxSources) * 0.000001
		ranked = append(ranked, articleGroup{key: key, items: items, score: score, firstIndex: firstIndex})
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].score != ranked[j].score {
			return ranked[i].score > ranked[j].score
		}
		return ranked[i].firstIndex < ranked[j].firstIndex
	})
	if len(ranked) > articleTopK {
		ranked = ranked[:articleTopK]
	}
	balanced := []chunkHit{}
	for offset := 0; offset < perArticleTopK; offset++ {
		for _, article := range ranked {
			if offset < len(article.items) {
				balanced = append(balanced, article.items[offset].hit)
			}
		}
	}
	articleIDs := make([]string, 0, len(ranked))
	for _, article := range ranked {
		articleIDs = append(articleIDs, article.key)
	}
	return balanced, articleIDs
}

func rerankKnowledgeLocally(query string, hits []chunkHit) []chunkHit {
	if len(hits) <= 1 {
		return hits
	}
	normalizedQuery := normalizeKnowledgeText(query)
	tokens := buildQueryTokens(query)
	type scored struct {
		hit   chunkHit
		score float64
		index int
	}
	items := make([]scored, 0, len(hits))
	for index, hit := range hits {
		title := normalizeKnowledgeText(hit.Title)
		summary := normalizeKnowledgeText(hit.Path + " " + hit.Snippet)
		content := normalizeKnowledgeText(truncateRunes(hit.Content, 1200))
		score := 1 / float64(index+2)
		if normalizedQuery != "" {
			if strings.Contains(title, normalizedQuery) {
				score += 8
			}
			if strings.Contains(summary, normalizedQuery) {
				score += 4
			}
			if strings.Contains(content, normalizedQuery) {
				score += 2
			}
		}
		for _, token := range tokens {
			token = normalizeKnowledgeText(token)
			if token == "" {
				continue
			}
			if strings.Contains(title, token) {
				score += 4
			}
			if strings.Contains(summary, token) {
				score += 2
			}
			if strings.Contains(content, token) {
				score += 1
			}
		}
		hit.RerankScore = floatPtr(score)
		items = append(items, scored{hit: hit, score: score, index: index})
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].score != items[j].score {
			return items[i].score > items[j].score
		}
		return items[i].index < items[j].index
	})
	out := make([]chunkHit, 0, len(items))
	for _, item := range items {
		out = append(out, item.hit)
	}
	return out
}

func selectDiverseKnowledgeHits(hits []chunkHit, limit, maxPerArticle int) ([]chunkHit, []string) {
	selected := []chunkHit{}
	dropped := []string{}
	for _, hit := range hits {
		if len(selected) >= limit {
			break
		}
		if !canAppendKnowledgeHit(selected, hit, maxPerArticle) {
			dropped = append(dropped, hitKey(hit))
			continue
		}
		selected = append(selected, hit)
	}
	return selected, dropped
}

func canAppendKnowledgeHit(selected []chunkHit, candidate chunkHit, maxPerArticle int) bool {
	articleKey := knowledgeArticleKey(candidate)
	count := 0
	for _, hit := range selected {
		if knowledgeArticleKey(hit) == articleKey {
			count++
		}
		if knowledgeHitSimilarity(hit, candidate) >= 0.88 {
			return false
		}
	}
	return count < maxPerArticle
}

func containsKnowledgeHit(hits []chunkHit, candidate chunkHit) bool {
	key := hitKey(candidate)
	for _, hit := range hits {
		if hitKey(hit) == key {
			return true
		}
	}
	return false
}

func knowledgeHitSimilarity(left, right chunkHit) float64 {
	leftTitle := normalizeKnowledgeText(left.Title)
	rightTitle := normalizeKnowledgeText(right.Title)
	if leftTitle != "" && leftTitle == rightTitle {
		return 1
	}
	leftTokens := tokenSet(left.Title + " " + left.Snippet + " " + truncateRunes(left.Content, 800))
	rightTokens := tokenSet(right.Title + " " + right.Snippet + " " + truncateRunes(right.Content, 800))
	if len(leftTokens) == 0 || len(rightTokens) == 0 {
		return 0
	}
	intersection := 0
	for token := range leftTokens {
		if rightTokens[token] {
			intersection++
		}
	}
	union := len(leftTokens) + len(rightTokens) - intersection
	if union == 0 {
		return 0
	}
	return float64(intersection) / float64(union)
}

func tokenSet(value string) map[string]bool {
	out := map[string]bool{}
	for _, token := range buildQueryTokens(value) {
		out[token] = true
	}
	return out
}

func normalizeKnowledgeText(value string) string {
	var builder strings.Builder
	for _, r := range strings.ToLower(value) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || cjkRange(r) {
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

func knowledgeArticleKey(hit chunkHit) string {
	if hit.ArticleID > 0 {
		return fmt.Sprintf("%d:%d", hit.KnowledgeBaseID, hit.ArticleID)
	}
	return hitKey(hit)
}

func knowledgeHitKeys(hits []chunkHit) []string {
	keys := make([]string, 0, len(hits))
	for _, hit := range hits {
		keys = append(keys, hitKey(hit))
	}
	return keys
}

func (diagnostics *knowledgeRecallDiagnostics) collectGroupKeys(groups []knowledgeRecallGroup) {
	for _, group := range groups {
		keys := knowledgeHitKeys(group.Hits)
		switch group.Source {
		case "chunk_vector":
			diagnostics.ChunkVectorKeys = append(diagnostics.ChunkVectorKeys, keys...)
		case "question_vector":
			diagnostics.QuestionVectorKeys = append(diagnostics.QuestionVectorKeys, keys...)
		case "chunk_bm25":
			diagnostics.ChunkBM25Keys = append(diagnostics.ChunkBM25Keys, keys...)
		case "question_bm25":
			diagnostics.QuestionBM25Keys = append(diagnostics.QuestionBM25Keys, keys...)
		case "wiki":
			diagnostics.WikiKeys = append(diagnostics.WikiKeys, keys...)
		case "tree":
			diagnostics.TreeKeys = append(diagnostics.TreeKeys, keys...)
		case "vector":
			diagnostics.LegacyVectorKeys = append(diagnostics.LegacyVectorKeys, keys...)
		case "bm25", "article_title":
			diagnostics.LegacyBM25Keys = append(diagnostics.LegacyBM25Keys, keys...)
		}
	}
}

func (diagnostics knowledgeRecallDiagnostics) toMap(rerankApplied bool) map[string]any {
	vectorKeys := append(append([]string{}, diagnostics.ChunkVectorKeys...), diagnostics.QuestionVectorKeys...)
	vectorKeys = append(vectorKeys, diagnostics.LegacyVectorKeys...)
	bm25Keys := append(append([]string{}, diagnostics.ChunkBM25Keys...), diagnostics.QuestionBM25Keys...)
	bm25Keys = append(bm25Keys, diagnostics.LegacyBM25Keys...)
	result := map[string]any{
		"query": diagnostics.Query, "rewrittenQueries": diagnostics.RewrittenQueries,
		"treeKeys": diagnostics.TreeKeys, "vectorKeys": vectorKeys, "bm25Keys": bm25Keys,
		"chunkVectorKeys": diagnostics.ChunkVectorKeys, "questionVectorKeys": diagnostics.QuestionVectorKeys,
		"chunkBm25Keys": diagnostics.ChunkBM25Keys, "questionBm25Keys": diagnostics.QuestionBM25Keys,
		"wikiKeys": diagnostics.WikiKeys, "fusionKeys": diagnostics.FusionKeys,
		"finalKeys": diagnostics.FinalKeys, "selectedArticleIds": diagnostics.SelectedArticleIDs,
		"diversityDroppedKeys": diagnostics.DiversityDroppedKeys,
		"rerankApplied":        rerankApplied, "rerankStrategy": map[bool]string{true: "local", false: "skipped"}[rerankApplied],
		"treeAttempted": diagnostics.TreeAttempted, "retrievalScope": diagnostics.RetrievalScope,
		"degraded": diagnostics.Degraded, "retrievalMs": diagnostics.RetrievalMs, "rerankMs": diagnostics.RerankMs,
		"semanticCount": len(vectorKeys), "lexicalCount": len(bm25Keys), "wikiCount": len(diagnostics.WikiKeys),
		"subQueryCount": len(diagnostics.RewrittenQueries),
	}
	if diagnostics.TreeReason != "" {
		result["treeReason"] = diagnostics.TreeReason
	}
	return result
}
