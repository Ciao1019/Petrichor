// retrieval.go 对照 handlers.ts 的 document/search、tree、semantic-search、view、qa，
// 以及 wiki-tree.ts / article-knowledge-index.ts / knowledge-recall.ts 的对应检索 SQL。
package agentapi

import (
	"context"
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/kb"
)

var (
	cjkRunRe           = regexp.MustCompile(`[\x{3400}-\x{4DBF}\x{4E00}-\x{9FFF}\x{F900}-\x{FAFF}]+`)
	sourceKeyExtractRe = regexp.MustCompile(`^source-(\d+)$`)
)

// ===== 轻量打分（对照 search-terms.ts scoreSearchFields）=====

func makeNgramList(text []rune, n int) []string {
	if n < 1 || len(text) < n {
		return nil
	}
	grams := make([]string, 0, len(text)-n+1)
	for i := 0; i+n <= len(text); i++ {
		grams = append(grams, string(text[i:i+n]))
	}
	return grams
}

func splitQueryParts(normalized string) []string {
	return strings.FieldsFunc(normalized, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\n' || r == '\r' ||
			strings.ContainsRune("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~", r)
	})
}

func scoreSearchFields(title string, summary *string, content string, extra *string, query string) float64 {
	normalized := strings.ToLower(strings.TrimSpace(query))
	if normalized == "" {
		return 1
	}
	t := strings.ToLower(title)
	s := strings.ToLower(deref(summary))
	c := strings.ToLower(content)
	e := strings.ToLower(deref(extra))
	haystack := t + "\n" + s + "\n" + c + "\n" + e

	if strings.Contains(haystack, normalized) {
		score := float64(100 + utf16Len(normalized)*4)
		if strings.Contains(t, normalized) {
			score += 40
		}
		return score
	}
	spaceParts := splitQueryParts(normalized)
	if len(spaceParts) == 0 {
		return 0
	}
	score := 0.0
	for _, part := range spaceParts {
		score += scoreOnePart(t, s, c, e, haystack, part)
	}
	return score
}

func scoreOnePart(title, summary, content, extra, haystack, part string) float64 {
	if part == "" {
		return 0
	}
	if strings.Contains(title, part) {
		return float64(utf16Len(part) * 6)
	}
	if strings.Contains(summary, part) || strings.Contains(extra, part) {
		return float64(utf16Len(part) * 3)
	}
	if strings.Contains(content, part) || strings.Contains(haystack, part) {
		return float64(utf16Len(part))
	}
	runes := []rune(part)
	hasCJK := false
	for _, r := range runes {
		if r >= 0x4e00 && r <= 0x9fff {
			hasCJK = true
			break
		}
	}
	if !hasCJK || len(runes) < 3 {
		return 0
	}
	bigrams := makeNgramList(runes, 2)
	if len(bigrams) == 0 {
		return 0
	}
	titleMatched := 0
	for _, g := range bigrams {
		if strings.Contains(title, g) {
			titleMatched++
		}
	}
	if ratio := float64(titleMatched) / float64(len(bigrams)); ratio >= 0.5 {
		return float64(int(float64(len(runes))*5*ratio + 0.5))
	}
	allMatched := 0
	for _, g := range bigrams {
		if strings.Contains(haystack, g) {
			allMatched++
		}
	}
	if ratio := float64(allMatched) / float64(len(bigrams)); ratio >= 0.6 {
		return float64(int(float64(len(runes))*2*ratio + 0.5))
	}
	return 0
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xffff {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// buildQueryTokens 查询侧词元（对照 retrieval/tokenize.ts，去重）。
func buildQueryTokens(query string) []string {
	normalized := strings.ToLower(strings.TrimSpace(query))
	if normalized == "" {
		return nil
	}
	var tokens []string
	seen := map[string]struct{}{}
	add := func(token string) {
		if token == "" {
			return
		}
		if _, dup := seen[token]; dup {
			return
		}
		seen[token] = struct{}{}
		tokens = append(tokens, token)
	}
	for _, part := range splitQueryParts(normalized) {
		runes := []rune(part)
		runs := cjkRunRe.FindAllString(part, -1)
		if len(runs) == 0 {
			if len(runes) >= 2 {
				add(part)
			}
			continue
		}
		for _, run := range runs {
			runRunes := []rune(run)
			if len(runRunes) == 1 {
				add(run)
				continue
			}
			for _, gram := range makeNgramList(runRunes, 2) {
				add(gram)
			}
			for _, gram := range makeNgramList(runRunes, 3) {
				add(gram)
			}
		}
		for _, latin := range cjkRunRe.Split(part, -1) {
			if latin != "" && len([]rune(latin)) >= 2 {
				add(latin)
			}
		}
	}
	return tokens
}

// ===== 文档命中模型（对照 AgentDocumentHit）=====

type documentHit struct {
	hitType           string // wiki | article | chunk | tree
	knowledgeBaseID   string
	knowledgeBaseName *string
	articleID         *string
	chunkID           *string
	pageKey           *string
	title             string
	summary           *string
	contentMd         string
	sortScore         float64
}

func (h *documentHit) toCitationMap() map[string]any {
	return map[string]any{
		"type":              h.hitType,
		"knowledgeBaseId":   h.knowledgeBaseID,
		"knowledgeBaseName": h.knowledgeBaseName,
		"articleId":         h.articleID,
		"chunkId":           h.chunkID,
		"pageKey":           h.pageKey,
		"title":             h.title,
		"summary":           h.summary,
		"updatedAt":         nil,
	}
}

// ===== document/search =====

// searchAgentDocuments 对照 handlers.ts searchAgentDocuments：
// 知识召回管线的 Go 简化版——分片索引词面候选 + Wiki 页面词面打分；
// 两路全空时按 TS 存量兼容路径回退旧 Wiki Tree 关键词召回。
// 偏差：未移植 BM25 / RRF / Rerank 全管线与向量分片检索，排序以词面打分为准。
func searchAgentDocuments(q *pgxpool.Pool, userID int64, knowledgeBaseID *int64, query string, limit int) ([]documentHit, error) {
	var candidates []documentHit

	chunkHits, err := lexicalChunkSearch(q, userID, knowledgeBaseID, nil, query, limit)
	if err != nil {
		return nil, err
	}
	candidates = append(candidates, chunkHits...)

	wikiHits, err := searchKnowledgeWikiPages(q, userID, knowledgeBaseID, query, limit)
	if err != nil {
		return nil, err
	}
	candidates = append(candidates, wikiHits...)

	if len(candidates) == 0 {
		if knowledgeBaseID != nil {
			treeHits, terr := legacyTreeKeywordFallback(q, userID, *knowledgeBaseID, nil, query, limit)
			if terr != nil {
				return nil, terr
			}
			candidates = append(candidates, treeHits...)
		} else {
			owned, oerr := listUserKnowledgeBases(q, userID)
			if oerr != nil {
				return nil, oerr
			}
			for _, item := range owned {
				id, perr := strconv.ParseInt(item["id"].(string), 10, 64)
				if perr != nil {
					continue
				}
				treeHits, terr := legacyTreeKeywordFallback(q, userID, id, nil, query, limit)
				if terr != nil {
					return nil, terr
				}
				name := item["name"].(string)
				for i := range treeHits {
					treeHits[i].knowledgeBaseName = &name
				}
				candidates = append(candidates, treeHits...)
			}
		}
	}

	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].sortScore > candidates[j].sortScore })
	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	attachKBNames(q, userID, candidates)
	return candidates, nil
}

func attachKBNames(q *pgxpool.Pool, userID int64, hits []documentHit) {
	items, err := listUserKnowledgeBases(q, userID)
	if err != nil {
		return
	}
	names := map[string]string{}
	for _, item := range items {
		names[item["id"].(string)] = item["name"].(string)
	}
	for i := range hits {
		if name, ok := names[hits[i].knowledgeBaseID]; ok && hits[i].knowledgeBaseName == nil {
			n := name
			hits[i].knowledgeBaseName = &n
		}
	}
}

// lexicalChunkSearch 分片索引词面检索（对照 article-knowledge-index.ts loadLexicalPool +
// rankLexicalRows；BM25 简化为 scoreSearchFields 打分，GIN/tsvector 未建时 LIKE 兜底）。
func lexicalChunkSearch(q *pgxpool.Pool, userID int64, knowledgeBaseID, articleID *int64, query string, limit int) ([]documentHit, error) {
	tokens := buildQueryTokens(query)
	if len(tokens) == 0 {
		return nil, nil
	}
	if len(tokens) > 16 {
		tokens = tokens[:16]
	}
	args := []any{userID}
	argIdx := 2
	sqlText := `SELECT i.chunk_id, i.article_id, i.knowledge_base_id, i.source_type,
		    i.content, a.title, COALESCE(c.heading, ''), c.content_md
		FROM petrichor_kb_article_chunk_index i
		JOIN petrichor_kb_article_chunk c ON c.id = i.chunk_id
		JOIN petrichor_kb_article a ON a.id = i.article_id
		WHERE i.user_id = $1`
	if knowledgeBaseID != nil {
		args = append(args, *knowledgeBaseID)
		sqlText += ` AND i.knowledge_base_id = $` + strconv.Itoa(argIdx)
		argIdx++
	}
	if articleID != nil {
		args = append(args, *articleID)
		sqlText += ` AND i.article_id = $` + strconv.Itoa(argIdx)
		argIdx++
	}
	clauses := make([]string, 0, len(tokens))
	for _, token := range tokens {
		args = append(args, "%"+escapeLike(token)+"%")
		clauses = append(clauses, `i.embedding_text ILIKE $`+strconv.Itoa(argIdx))
		argIdx++
	}
	sqlText += ` AND (` + strings.Join(clauses, " OR ") + `) LIMIT 400`

	rows, err := q.Query(context.Background(), sqlText, args...)
	if err != nil {
		return nil, err
	}
	type indexRow struct {
		chunkID         int64
		knowledgeBaseID int64
		articleID       int64
		sourceType      string
		matchedContent  string
		articleTitle    string
		heading         string
		contentMd       string
		score           float64
	}
	var rankedRows []indexRow
	for rows.Next() {
		var row indexRow
		if err := rows.Scan(&row.chunkID, &row.articleID, &row.knowledgeBaseID,
			&row.sourceType, &row.matchedContent, &row.articleTitle, &row.heading, &row.contentMd); err != nil {
			rows.Close()
			return nil, err
		}
		row.score = scoreSearchFields(row.articleTitle+" "+row.heading, nil, row.matchedContent, nil, query)
		rankedRows = append(rankedRows, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(rankedRows, func(i, j int) bool { return rankedRows[i].score > rankedRows[j].score })

	seen := map[string]struct{}{}
	hits := []documentHit{}
	for _, row := range rankedRows {
		key := idStr(row.knowledgeBaseID) + ":" + idStr(row.chunkID)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		title := row.heading
		if title == "" {
			title = row.articleTitle
		}
		summary := collapseSpaces(row.contentMd)
		if len([]rune(summary)) > 220 {
			summary = string([]rune(summary)[:220])
		}
		chunkIDStr := idStr(row.chunkID)
		articleIDStr := idStr(row.articleID)
		hits = append(hits, documentHit{
			hitType:         "chunk",
			knowledgeBaseID: idStr(row.knowledgeBaseID),
			articleID:       &articleIDStr,
			chunkID:         &chunkIDStr,
			title:           title,
			summary:         &summary,
			contentMd:       row.contentMd,
			sortScore:       row.score,
		})
		if len(hits) >= limit {
			break
		}
	}
	return hits, nil
}

func collapseSpaces(s string) string {
	return strings.TrimSpace(spaceCollapse.ReplaceAllString(s, " "))
}

// searchKnowledgeWikiPages 对照 article-knowledge-index.ts 同名函数。
func searchKnowledgeWikiPages(q *pgxpool.Pool, userID int64, knowledgeBaseID *int64, query string, limit int) ([]documentHit, error) {
	tokens := buildQueryTokens(query)
	if len(tokens) == 0 {
		return nil, nil
	}
	if len(tokens) > 16 {
		tokens = tokens[:16]
	}
	args := []any{userID}
	argIdx := 2
	clauses := make([]string, 0, len(tokens)*4)
	sqlText := `SELECT id, knowledge_base_id, page_key, title, kind, summary, content_md
		FROM petrichor_kb_wiki_page
		WHERE user_id = $1 AND archived_at IS NULL
		  AND kind NOT IN ('source', 'index', 'log')`
	if knowledgeBaseID != nil {
		args = append(args, *knowledgeBaseID)
		sqlText += ` AND knowledge_base_id = $` + strconv.Itoa(argIdx)
		argIdx++
	}
	for _, token := range tokens {
		args = append(args, "%"+escapeLike(token)+"%")
		clauses = append(clauses,
			`title ILIKE $`+strconv.Itoa(argIdx),
			`page_key ILIKE $`+strconv.Itoa(argIdx),
			`summary ILIKE $`+strconv.Itoa(argIdx),
			`content_md ILIKE $`+strconv.Itoa(argIdx))
		argIdx++
	}
	sqlText += ` AND (` + strings.Join(clauses, " OR ") + `) LIMIT 400`

	rows, err := q.Query(context.Background(), sqlText, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type pageRow struct {
		id        int64
		kbID      int64
		pageKey   string
		title     string
		kind      string
		summary   *string
		contentMd string
		score     float64
	}
	var pages []pageRow
	for rows.Next() {
		var row pageRow
		if err := rows.Scan(&row.id, &row.kbID, &row.pageKey, &row.title, &row.kind, &row.summary, &row.contentMd); err != nil {
			return nil, err
		}
		row.score = scoreSearchFields(row.title, row.summary, row.contentMd, strPtr(row.pageKey), query)
		if row.score <= 0 {
			continue
		}
		pages = append(pages, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(pages, func(i, j int) bool { return pages[i].score > pages[j].score })
	if len(pages) > limit {
		pages = pages[:limit]
	}

	hits := []documentHit{}
	for i := range pages {
		row := &pages[i]
		summary := ""
		if row.summary != nil && strings.TrimSpace(*row.summary) != "" {
			summary = strings.TrimSpace(*row.summary)
		} else {
			summary = collapseSpaces(row.contentMd)
			if len([]rune(summary)) > 220 {
				summary = string([]rune(summary)[:220])
			}
		}
		pageKey := row.pageKey
		hits = append(hits, documentHit{
			hitType:         "wiki",
			knowledgeBaseID: idStr(row.kbID),
			pageKey:         &pageKey,
			articleID:       extractArticleIDFromSourceKey(row.pageKey),
			title:           row.title,
			summary:         &summary,
			contentMd:       row.contentMd,
			sortScore:       row.score,
		})
	}
	return hits, nil
}

func strPtr(s string) *string { return &s }

func extractArticleIDFromSourceKey(pageKey string) *string {
	m := sourceKeyExtractRe.FindStringSubmatch(pageKey)
	if m == nil {
		return nil
	}
	s := m[1]
	return &s
}

// ===== document/tree 与 semantic-search =====

const maxOutlineNodes = 200
const treeMaxContentChars = 1600

type treeHitOut struct {
	nodeKey   string
	articleID string
	kbID      string
	title     string
	path      string
	summary   *string
	contentMd string
	reason    *string
	depth     int32
}

func (h *treeHitOut) toMap() map[string]any {
	m := map[string]any{
		"nodeKey":         h.nodeKey,
		"articleId":       h.articleID,
		"knowledgeBaseId": h.kbID,
		"title":           h.title,
		"path":            h.path,
		"summary":         h.summary,
		"contentMd":       h.contentMd,
		"depth":           h.depth,
	}
	if h.reason != nil {
		m["reason"] = h.reason
	}
	return m
}

func loadTreeNodesLite(q *pgxpool.Pool, userID, kbID int64, articleID *int64) ([]kb.TreeNodeRow, error) {
	return kb.LoadTreeNodesForAgent(q, userID, kbID, articleID)
}

func buildNodePathOf(node *kb.TreeNodeRow, byKey map[string]*kb.TreeNodeRow) string {
	var titles []string
	current := node
	guard := map[string]struct{}{}
	for current != nil {
		if _, seen := guard[current.NodeKey]; seen {
			break
		}
		guard[current.NodeKey] = struct{}{}
		titles = append([]string{current.Title}, titles...)
		if current.ParentKey == nil {
			break
		}
		current = byKey[*current.ParentKey]
	}
	return strings.Join(titles, " › ")
}

func clipTreeContent(contentMd string) string {
	if len([]rune(contentMd)) > treeMaxContentChars {
		return truncateRunesCopy(contentMd, treeMaxContentChars) + "…"
	}
	return contentMd
}

// retrieveTreeNodesForAgentCore 对照 wiki-tree.ts retrieveTreeNodesForAgent：
// LLM 在目录树上推理导航选节点；LLM 不可用或解析失败退回关键词打分。
func retrieveTreeNodesForAgentCore(q *pgxpool.Pool, userID, kbID int64, query string, limit int, articleID *int64) ([]map[string]any, error) {
	if _, err := kb.AssertKnowledgeBaseOwnerForAgent(q, userID, kbID); err != nil {
		return nil, err
	}
	nodes, err := loadTreeNodesLite(q, userID, kbID, articleID)
	if err != nil {
		return nil, err
	}
	if len(nodes) == 0 {
		return []map[string]any{}, nil
	}
	byKey := map[string]*kb.TreeNodeRow{}
	for i := range nodes {
		byKey[nodes[i].NodeKey] = &nodes[i]
	}

	selected := selectNodeKeysByLLM(userID, query, nodes, limit)
	out := []map[string]any{}
	appendHit := func(node *kb.TreeNodeRow, reason *string) {
		out = append(out, (&treeHitOut{
			nodeKey:   node.NodeKey,
			articleID: idStr(node.ArticleID),
			kbID:      idStr(node.KnowledgeBaseID),
			title:     node.Title,
			path:      buildNodePathOf(node, byKey),
			summary:   node.Summary,
			contentMd: clipTreeContent(node.ContentMd),
			reason:    reason,
			depth:     node.Depth,
		}).toMap())
	}
	if len(selected) > 0 {
		count := 0
		for _, entry := range selected {
			if count >= limit {
				break
			}
			if node, ok := byKey[entry.nodeKey]; ok {
				appendHit(node, entry.reason)
				count++
			}
		}
	} else {
		fallback := keywordTreeFallback(nodes, query, limit)
		for _, node := range fallback {
			appendHit(node, nil)
		}
	}
	return out, nil
}

type selectedNode struct {
	nodeKey string
	reason  *string
}

// selectNodeKeysByLLM 对照 wiki-tree.ts selectNodeKeys。
func selectNodeKeysByLLM(userID int64, query string, nodes []kb.TreeNodeRow, limit int) []selectedNode {
	if len(nodes) > maxOutlineNodes || kb.ChatInvoker == nil {
		return nil
	}
	var outlineLines []string
	for i := range nodes {
		node := &nodes[i]
		indent := strings.Repeat("  ", maxInt(0, int(node.Depth)))
		summaryPart := ""
		if node.Summary != nil && *node.Summary != "" {
			summaryPart = " — " + *node.Summary
		}
		outlineLines = append(outlineLines, indent+"- ["+node.NodeKey+"] "+node.Title+summaryPart)
	}
	answer, err := kb.ChatInvoker(context.Background(), kb.ChatRequest{
		UserID: userID,
		SystemPrompt: strings.Join([]string{
			"你在用「推理式检索」浏览文档目录树来回答问题。",
			"目录里每个节点形如 `[nodeKey] 标题 — 摘要`。",
			"请基于问题推理出最相关的若干节点（按相关度排序，最多按要求数量），优先选信息密度高、能直接支撑答案的节点。",
			"只输出 JSON，不要 Markdown 围栏。",
			`JSON 结构：{"nodes": [{"nodeKey": "...", "reason": "为什么相关"}]}。nodeKey 必须来自目录里出现过的值。`,
		}, "\n"),
		Message: strings.Join([]string{
			"问题：" + query,
			"最多选择 " + strconv.Itoa(limit) + " 个节点。",
			"文档目录树：",
			strings.Join(outlineLines, "\n"),
		}, "\n\n"),
		Op: "kb.doc.tree.retrieve",
	})
	if err != nil {
		return nil
	}
	jsonText, jerr := extractJSONObjectText(answer)
	if jerr != nil {
		return nil
	}
	valid := map[string]struct{}{}
	for i := range nodes {
		valid[nodes[i].NodeKey] = struct{}{}
	}
	var parsed struct {
		Nodes []struct {
			NodeKey string `json:"nodeKey"`
			Reason  string `json:"reason"`
		} `json:"nodes"`
	}
	if json.Unmarshal([]byte(jsonText), &parsed) != nil {
		return nil
	}
	seen := map[string]struct{}{}
	result := []selectedNode{}
	for _, item := range parsed.Nodes {
		if _, ok := valid[item.NodeKey]; !ok {
			continue
		}
		if _, dup := seen[item.NodeKey]; dup {
			continue
		}
		seen[item.NodeKey] = struct{}{}
		entry := selectedNode{nodeKey: item.NodeKey}
		if strings.TrimSpace(item.Reason) != "" {
			r := strings.TrimSpace(item.Reason)
			entry.reason = &r
		}
		result = append(result, entry)
	}
	return result
}

// keywordTreeFallback 对照 wiki-tree.ts keywordFallback。
func keywordTreeFallback(nodes []kb.TreeNodeRow, query string, limit int) []*kb.TreeNodeRow {
	normalized := strings.TrimSpace(query)
	type scored struct {
		node  *kb.TreeNodeRow
		score float64
	}
	var scoredNodes []scored
	for i := range nodes {
		score := scoreSearchFields(nodes[i].Title, nodes[i].Summary, nodes[i].ContentMd, nil, normalized)
		if score > 0 || normalized == "" {
			scoredNodes = append(scoredNodes, scored{node: &nodes[i], score: score})
		}
	}
	sort.SliceStable(scoredNodes, func(i, j int) bool {
		if scoredNodes[i].score != scoredNodes[j].score {
			return scoredNodes[i].score > scoredNodes[j].score
		}
		return scoredNodes[i].node.Position < scoredNodes[j].node.Position
	})
	if len(scoredNodes) > limit {
		scoredNodes = scoredNodes[:limit]
	}
	out := make([]*kb.TreeNodeRow, 0, len(scoredNodes))
	for _, item := range scoredNodes {
		out = append(out, item.node)
	}
	return out
}

// semanticSearchTreeNodesCore 对照 wiki-tree.ts semanticSearchTreeNodes（pgvector 余弦相似度）。
func semanticSearchTreeNodesCore(q *pgxpool.Pool, userID, kbID int64, query string, limit int, articleID *int64) ([]map[string]any, error) {
	if _, err := kb.AssertKnowledgeBaseOwnerForAgent(q, userID, kbID); err != nil {
		return nil, err
	}
	keyword := strings.TrimSpace(query)
	if keyword == "" {
		return []map[string]any{}, nil
	}
	if kb.EmbedInvoker == nil {
		return nil, httpx.BadRequest("向量语义检索需要配置 PostgreSQL 与向量模型")
	}
	vectors, err := kb.EmbedInvoker(context.Background(), kb.EmbedRequest{UserID: userID, Texts: []string{keyword}, Op: "kb.doc.semantic"})
	if err != nil {
		return nil, err
	}
	if len(vectors) == 0 || vectors[0] == nil {
		return []map[string]any{}, nil
	}
	vec := vectors[0]
	dims := len(vec)

	ctx := context.Background()
	modelID := ""
	if err := q.QueryRow(ctx,
		`SELECT m.model_id FROM petrichor_ai_binding b
		 JOIN petrichor_ai_model m ON m.id = b.model_ref_id AND m.enabled = true AND m.kind = 'EMBEDDING'
		 JOIN petrichor_ai_provider p ON p.id = m.provider_id AND p.enabled = true
		 WHERE b.user_id = $1 AND b.purpose = 'EMBEDDING' LIMIT 1`, userID).Scan(&modelID); err != nil {
		return nil, httpx.BadRequest("向量语义检索需要配置 PostgreSQL 与向量模型")
	}

	sqlText := `SELECT node_key FROM petrichor_kb_wiki_tree_node
		WHERE user_id = $1 AND knowledge_base_id = $2 AND embedding IS NOT NULL
		  AND vector_dims(embedding) = $3
		  AND embedding_status = 'ready'
		  AND embedding_model = $4
		  AND embedding_dimensions = $3
		  AND embedding_version = 1`
	args := []any{userID, kbID, dims, modelID}
	if articleID != nil {
		args = append(args, *articleID)
		sqlText += ` AND article_id = $` + strconv.Itoa(len(args))
	}
	args = append(args, vectorLiteralOf(vec))
	sqlText += ` ORDER BY embedding <=> $` + strconv.Itoa(len(args)) + `::vector LIMIT ` + strconv.Itoa(limit)

	rows, err := q.Query(ctx, sqlText, args...)
	if err != nil {
		return nil, err
	}
	var orderedKeys []string
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return nil, err
		}
		orderedKeys = append(orderedKeys, key)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(orderedKeys) == 0 {
		return []map[string]any{}, nil
	}

	nodes, err := loadTreeNodesLite(q, userID, kbID, articleID)
	if err != nil {
		return nil, err
	}
	byKey := map[string]*kb.TreeNodeRow{}
	for i := range nodes {
		byKey[nodes[i].NodeKey] = &nodes[i]
	}
	out := []map[string]any{}
	for _, key := range orderedKeys {
		node, ok := byKey[key]
		if !ok {
			continue
		}
		out = append(out, (&treeHitOut{
			nodeKey:   node.NodeKey,
			articleID: idStr(node.ArticleID),
			kbID:      idStr(node.KnowledgeBaseID),
			title:     node.Title,
			path:      buildNodePathOf(node, byKey),
			summary:   node.Summary,
			contentMd: clipTreeContent(node.ContentMd),
			depth:     node.Depth,
		}).toMap())
	}
	return out, nil
}

// legacyTreeKeywordFallback 存量 Tree 关键词兜底（跨库搜索时逐库调用）。
func legacyTreeKeywordFallback(q *pgxpool.Pool, userID, kbID int64, articleID *int64, query string, limit int) ([]documentHit, error) {
	nodes, err := loadTreeNodesLite(q, userID, kbID, articleID)
	if err != nil {
		return nil, err
	}
	fallback := keywordTreeFallback(nodes, query, limit)
	kbIDStr := idStr(kbID)
	hits := []documentHit{}
	for _, node := range fallback {
		articleIDStr := idStr(node.ArticleID)
		hits = append(hits, documentHit{
			hitType:         "tree",
			knowledgeBaseID: kbIDStr,
			articleID:       &articleIDStr,
			title:           node.Title,
			summary:         node.Summary,
			contentMd:       clipTreeContent(node.ContentMd),
		})
	}
	return hits, nil
}

func vectorLiteralOf(vec []float32) string {
	parts := make([]string, 0, len(vec))
	for _, v := range vec {
		parts = append(parts, strconv.FormatFloat(float64(v), 'f', -1, 64))
	}
	return "[" + strings.Join(parts, ",") + "]"
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
