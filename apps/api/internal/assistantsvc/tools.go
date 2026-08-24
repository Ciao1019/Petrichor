package assistantsvc

// tools.go Agent 工具装配（对照 agent-runtime/tools/）。
//
// 所有工具统一注册进 runtime.DefaultToolRegistry()；执行体走 ToolExecutor，
// 不存在绕过执行器的调用路径。

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"petrichor/api/internal/aicore"
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

func schemaJSON(schema string) json.RawMessage { return json.RawMessage(schema) }

// RegisterAssistantTools 注册助手域全部工具与技能（进程内一次）。
func RegisterAssistantTools(registry interface {
	Register(tool *rt.AgentToolDefinition)
}, skills interface {
	Register(skill rt.AgentSkill)
}) {
	registerKnowledgeTools(registry)
	registerAgentMetaTools(registry)
	registerBuiltinSkills(skills)
}

// ===== knowledge 域 =====

const kbListSchema = `{"type":"object","properties":{"knowledgeBaseId":{"type":"string","description":"可选，限定知识库"},"articleId":{"type":"string","description":"可选，限定文章"}},"required":["query"]}`

const searchSchema = `{"type":"object","properties":{"query":{"type":"string","description":"检索词"},"knowledgeBaseId":{"type":"string","description":"可选，限定知识库"},"topK":{"type":"integer","description":"返回条数，缺省 8"}},"required":["query"]}`

const lookupSchema = `{"type":"object","properties":{"query":{"type":"string","description":"检索词"},"knowledgeBaseId":{"type":"string","description":"可选，限定知识库"}},"required":["query"]}`

const readManySchema = `{"type":"object","properties":{"targets":{"type":"array","items":{"type":"object","properties":{"articleId":{"type":"string"},"nodeKey":{"type":"string"},"knowledgeBaseId":{"type":"string"}},"required":["articleId"]}},"reason":{"type":"string"}},"required":["targets"]}`

const readOneSchema = `{"type":"object","properties":{"target":{"type":"object","properties":{"articleId":{"type":"string"},"nodeKey":{"type":"string"},"knowledgeBaseId":{"type":"string"}},"required":["articleId"]}},"required":["target"]}`

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
		Description: "在用户知识库中做语义检索，返回候选章节（标题/路径/摘要），不返回正文。需要正文时用 read/read_many。",
		InputSchema: schemaJSON(searchSchema),
		RiskLevel:   rt.RiskLow, Core: true, Tags: []string{"retrieval"},
		Execute:   executeKnowledgeSearch,
		Normalize: normalizeSearchOutput,
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.lookup", Name: "lookup_knowledge", Namespace: rt.NamespaceKnowledge,
		Description: "一站式复合检索：语义检索并直接深读最相关章节，返回带证据的答案素材。简单问题优先用它。",
		InputSchema: schemaJSON(lookupSchema),
		RiskLevel:   rt.RiskLow, Core: true, Tags: []string{"retrieval"},
		Execute:   executeKnowledgeLookup,
		Normalize: normalizeLookupOutput,
		TimeoutMs: 60000,
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.read_many", Name: "read_knowledge_many", Namespace: rt.NamespaceKnowledge,
		Description: "并行深读多个章节/文章，返回每个目标的正文片段（含层级上下文）。",
		InputSchema: schemaJSON(readManySchema),
		RiskLevel:   rt.RiskLow, Core: true, Tags: []string{"retrieval"},
		Execute:   executeKnowledgeReadMany,
		Normalize: normalizeReadOutput,
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.read", Name: "read_knowledge", Namespace: rt.NamespaceKnowledge,
		Description: "深读单个文章或章节，返回正文片段（含层级上下文）。只读一个明确章节时使用。",
		InputSchema: schemaJSON(readOneSchema),
		RiskLevel:   rt.RiskLow, Tags: []string{"retrieval"},
		Execute:   executeKnowledgeReadOne,
		Normalize: normalizeReadOutput,
	})

	registerWikiTools(registry)
}

// ===== 工具实现 =====

type chunkHit struct {
	ArticleID       int64   `json:"articleId"`
	KnowledgeBaseID int64   `json:"knowledgeBaseId"`
	Title           string  `json:"title"`
	NodeKey         string  `json:"nodeKey"`
	Path            string  `json:"path"`
	Snippet         string  `json:"snippet"`
	Score           float64 `json:"score"`
}

// embedQuery 生成查询向量；未配置向量模型时返回 nil（回落关键词检索）。
func embedQuery(ctx context.Context, userID int64, query string) []float32 {
	resolved, err := aicore.ResolveModelForPurpose(ctx, userID, aicore.PurposeEmbedding, nil)
	if err != nil {
		return nil
	}
	vectors, err := aicore.Embeddings(ctx, resolved.Runtime, resolved.ModelRef, []string{query})
	if err != nil || len(vectors) == 0 {
		return nil
	}
	return vectors[0]
}

func vectorLiteral(vec []float32) string {
	parts := make([]string, 0, len(vec))
	for _, v := range vec {
		parts = append(parts, fmt.Sprintf("%g", v))
	}
	return "[" + strings.Join(parts, ",") + "]"
}

// semanticChunkSearch pgvector 余弦相似度检索。
func semanticChunkSearch(ctx context.Context, userID int64, query string, kbID int64, hasKB bool, topK int) []chunkHit {
	vec := embedQuery(ctx, userID, query)
	if vec == nil || len(vec) == 0 {
		return nil
	}
	sql := `SELECT c.article_id, c.knowledge_base_id, a.title, c.source_key,
			       substring(c.content from 1 for 400) AS snippet,
			       1 - (c.embedding <=> $2::vector) AS score
			FROM petrichor_kb_article_chunk_index c
			JOIN petrichor_kb_article a ON a.id = c.article_id
			WHERE c.user_id = $1 AND c.embedding_status = 'ready'`
	args := []any{userID, vectorLiteral(vec)}
	if hasKB && kbID > 0 {
		sql += ` AND c.knowledge_base_id = $3`
		args = append(args, kbID)
	}
	sql += fmt.Sprintf(` ORDER BY c.embedding <=> $%d::vector LIMIT $%d`, len(args)+1, len(args)+2)
	args = append(args, vecLiteralForOrder(vec), topK)

	rows, err := dbPool().Query(ctx, sql, args...)
	if err != nil {
		return nil
	}
	defer rows.Close()
	return scanChunkHits(rows)
}

func vecLiteralForOrder(vec []float32) string { return vectorLiteral(vec) }

type chunkRows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
}

func scanChunkHits(rows chunkRows) []chunkHit {
	hits := []chunkHit{}
	for rows.Next() {
		var h chunkHit
		var nodeKey *string
		if err := rows.Scan(&h.ArticleID, &h.KnowledgeBaseID, &h.Title, &h.NodeKey, &h.Snippet, &h.Score); err != nil {
			continue
		}
		_ = nodeKey
		h.NodeKey = h.Path
		hits = append(hits, h)
	}
	return hits
}

// keywordChunkSearch 词法兜底检索：查询词元化（中文 bigram + 英文词）后
// 对 search_tokens / 标题做 OR 匹配（对照 TS BM25 池的 GIN 预筛口径）。
func keywordChunkSearch(ctx context.Context, userID int64, query string, kbID int64, hasKB bool, topK int) []chunkHit {
	patterns := likePatterns(buildQueryTokens(query))
	if len(patterns) == 0 {
		return nil
	}
	sql := `SELECT c.article_id, c.knowledge_base_id, a.title, c.source_key,
			       substring(c.content from 1 for 400) AS snippet,
			       0.5::float8 AS score
			FROM petrichor_kb_article_chunk_index c
			JOIN petrichor_kb_article a ON a.id = c.article_id
			WHERE c.user_id = $1 AND c.search_tokens ILIKE ANY($2)`
	args := []any{userID, patterns}
	if hasKB && kbID > 0 {
		sql += ` AND c.knowledge_base_id = $3`
		args = append(args, kbID)
	}
	sql += fmt.Sprintf(` LIMIT $%d`, len(args)+1)
	args = append(args, topK)

	rows, err := dbPool().Query(ctx, sql, args...)
	if err != nil {
		return articleTitleFallback(ctx, userID, query, kbID, hasKB, topK)
	}
	defer rows.Close()
	hits := scanChunkHits(rows)
	if len(hits) > 0 {
		return hits
	}
	return articleTitleFallback(ctx, userID, query, kbID, hasKB, topK)
}

// articleTitleFallback 分片未命中时按文章标题词元匹配，保证标题级召回。
func articleTitleFallback(ctx context.Context, userID int64, query string, kbID int64, hasKB bool, topK int) []chunkHit {
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
		sql += ` AND a.knowledge_base_id = $3`
		args = append(args, kbID)
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
		hits = append(hits, h)
	}
	return hits
}

func sanitizeLike(q string) string {
	q = strings.ReplaceAll(q, "%", "\\%")
	q = strings.ReplaceAll(q, "_", "\\_")
	return q
}

// dedupeHits 同文章同 nodeKey 去重，保留高分。
func dedupeHits(hits []chunkHit, limit int) []chunkHit {
	seen := map[string]bool{}
	out := make([]chunkHit, 0, len(hits))
	for _, h := range hits {
		key := fmt.Sprintf("%d:%s", h.ArticleID, h.Path)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, h)
		if len(out) >= limit {
			break
		}
	}
	return out
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
	rows, err := dbPool().Query(context.Background(),
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

// executeKnowledgeSearch 语义检索候选。
func executeKnowledgeSearch(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	query, _ := params["query"].(string)
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, rt.ValidationError("query 不能为空")
	}
	kbID, hasKB := parseFocusAndParams(ctx, params)
	topK := 8
	if v, ok := params["topK"].(float64); ok && v > 0 {
		topK = int(v)
	}

	cctx := context.Background()
	hits := semanticChunkSearch(cctx, ctx.UserID, query, kbID, hasKB, topK*2)
	if len(hits) == 0 {
		hits = keywordChunkSearch(cctx, ctx.UserID, query, kbID, hasKB, topK*2)
	}
	hits = dedupeHits(hits, topK)

	items := make([]map[string]any, 0, len(hits))
	for _, h := range hits {
		items = append(items, map[string]any{
			"articleId":       fmt.Sprintf("%d", h.ArticleID),
			"knowledgeBaseId": fmt.Sprintf("%d", h.KnowledgeBaseID),
			"title":           h.Title,
			"path":            h.Path,
			"snippet":         h.Snippet,
			"score":           roundFloat(h.Score),
		})
	}
	return map[string]any{"hits": items, "diagnostics": map[string]any{"semanticCount": len(hits)}}, nil
}

func roundFloat(v float64) float64 { return float64(int(v*10000+0.5)) / 10000 }

func parseFocusAndParams(ctx *rt.ToolExecutionContext, params map[string]any) (int64, bool) {
	if v, ok := params["knowledgeBaseId"]; ok {
		if id := parseID(v); id > 0 {
			return id, true
		}
	}
	return focusInt(ctx.Focus, "knowledgeBaseId")
}

// executeKnowledgeLookup 复合检索：search + 深读最相关 1~2 个章节。
func executeKnowledgeLookup(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	query, _ := params["query"].(string)
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, rt.ValidationError("query 不能为空")
	}
	kbID, hasKB := parseFocusAndParams(ctx, params)

	cctx := context.Background()
	hits := semanticChunkSearch(cctx, ctx.UserID, query, kbID, hasKB, 6)
	if len(hits) == 0 {
		hits = keywordChunkSearch(cctx, ctx.UserID, query, kbID, hasKB, 6)
	}
	hits = dedupeHits(hits, 2)

	reads := make([]map[string]any, 0, len(hits))
	for _, h := range hits {
		content, path := readArticleContent(cctx, ctx.UserID, h.ArticleID, h.Path)
		reads = append(reads, map[string]any{
			"articleId":       fmt.Sprintf("%d", h.ArticleID),
			"knowledgeBaseId": fmt.Sprintf("%d", h.KnowledgeBaseID),
			"title":           h.Title,
			"path":            orDefaultStr(path, h.Path),
			"content":         content,
		})
	}
	return map[string]any{"hits": reads}, nil
}

func orDefaultStr(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

// readArticleContent 读文章正文（优先指定 nodeKey 章节，截断到预算内）。
func readArticleContent(ctx context.Context, userID, articleID int64, nodeKey string) (string, string) {
	const maxChars = 6000
	var title, contentMD string
	err := dbPool().QueryRow(ctx,
		`SELECT title, content_md FROM petrichor_kb_article WHERE id = $1 AND user_id = $2 LIMIT 1`,
		articleID, userID).Scan(&title, &contentMD)
	if err != nil {
		return "", ""
	}
	body := contentMD
	if nodeKey != "" && strings.Contains(contentMD, nodeHeading(contentMD, nodeKey)) {
		if section := extractSection(contentMD, nodeKey); section != "" {
			body = section
		}
	}
	runes := []rune(body)
	if len(runes) > maxChars {
		body = string(runes[:maxChars]) + "\n\n[内容过长，本次仅给出前 " + fmt.Sprint(maxChars) + " 字]"
	}
	return body, title
}

func nodeHeading(contentMD, nodeKey string) string { return nodeKey }

// extractSection 按 markdown 标题提取小节（简化版：按标题行切分后取命中段）。
func extractSection(contentMD, nodeKey string) string {
	lines := strings.Split(contentMD, "\n")
	start := -1
	sectionLevel := 0
	for i, line := range lines {
		if strings.Contains(line, nodeKey) && strings.HasPrefix(strings.TrimSpace(line), "#") {
			start = i
			sectionLevel = countHash(line)
			break
		}
	}
	if start < 0 {
		return ""
	}
	end := len(lines)
	for i := start + 1; i < len(lines); i++ {
		if strings.HasPrefix(strings.TrimSpace(lines[i]), "#") && countHash(lines[i]) <= sectionLevel {
			end = i
			break
		}
	}
	return strings.Join(lines[start:end], "\n")
}

func countHash(line string) int {
	n := 0
	for _, r := range line {
		if r == '#' {
			n++
			continue
		}
		break
	}
	return n
}

// executeKnowledgeReadMany 批量深读。
func executeKnowledgeReadMany(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	targetsRaw, _ := params["targets"].([]any)
	if len(targetsRaw) == 0 {
		return nil, rt.ValidationError("targets 不能为空")
	}
	results := make([]map[string]any, 0, len(targetsRaw))
	for _, t := range targetsRaw {
		target, _ := t.(map[string]any)
		articleID := parseID(target["articleId"])
		if articleID <= 0 {
			continue
		}
		nodeKey, _ := target["nodeKey"].(string)
		content, title := readArticleContent(context.Background(), ctx.UserID, articleID, nodeKey)
		kbID := parseID(target["knowledgeBaseId"])
		entry := map[string]any{
			"articleId": fmt.Sprintf("%d", articleID),
			"title":     title,
			"content":   content,
		}
		if kbID > 0 {
			entry["knowledgeBaseId"] = fmt.Sprintf("%d", kbID)
		}
		if nodeKey != "" {
			entry["path"] = nodeKey
		}
		results = append(results, entry)
	}
	return map[string]any{"results": results}, nil
}

// executeKnowledgeReadOne 单个深读。
func executeKnowledgeReadOne(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	target, _ := params["target"].(map[string]any)
	if target == nil {
		return nil, rt.ValidationError("target 不能为空")
	}
	articleID := parseID(target["articleId"])
	if articleID <= 0 {
		return nil, rt.ValidationError("articleId 无效")
	}
	nodeKey, _ := target["nodeKey"].(string)
	content, title := readArticleContent(context.Background(), ctx.UserID, articleID, nodeKey)
	return map[string]any{
		"results": []map[string]any{{
			"articleId": fmt.Sprintf("%d", articleID),
			"title":     title,
			"path":      nodeKey,
			"content":   content,
		}},
	}, nil
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
	hits := extractHits(output)
	summary := "未找到相关内容"
	if len(hits) > 0 {
		summary = fmt.Sprintf("找到 %d 条候选（标题/路径/摘要）；需要正文请继续 read_many", len(hits))
	}
	data, _ := json.Marshal(map[string]any{"hits": hits})
	return rt.ToolNormalizerResult{
		Summary: summary, Data: data,
		SuggestedActions: []string{"knowledge_read_many"},
		Progress:         boolPtr(len(hits) > 0),
	}
}

func normalizeLookupOutput(output any, _ any) rt.ToolNormalizerResult {
	raw, _ := json.Marshal(output)
	var parsed struct {
		Hits []struct {
			Title   string `json:"title"`
			Path    string `json:"path"`
			Content string `json:"content"`
		} `json:"hits"`
	}
	_ = json.Unmarshal(raw, &parsed)
	totalChars := 0
	evidence := make([]rt.EvidenceInput, 0, len(parsed.Hits))
	for _, h := range parsed.Hits {
		totalChars += len([]rune(h.Content))
		evidence = append(evidence, rt.EvidenceInput{
			Source:     rt.EvidenceKnowledge,
			Title:      h.Title,
			Content:    truncateRunes(trimSpace(h.Content), 2000),
			Relevance:  floatPtr(0.75),
			Confidence: floatPtr(0.75),
		})
	}
	summary := "复合检索未命中"
	if len(parsed.Hits) > 0 {
		summary = fmt.Sprintf("已深读 %d 个章节（合计 %d 字），可直接作答", len(parsed.Hits), totalChars)
	}
	return rt.ToolNormalizerResult{Summary: summary, Evidence: evidence}
}

func normalizeReadOutput(output any, _ any) rt.ToolNormalizerResult {
	raw, _ := json.Marshal(output)
	var parsed struct {
		Results []struct {
			Title     string `json:"title"`
			Path      string `json:"path"`
			Content   string `json:"content"`
			KbID      string `json:"knowledgeBaseId"`
			ArticleID string `json:"articleId"`
		} `json:"results"`
	}
	_ = json.Unmarshal(raw, &parsed)
	totalChars := 0
	evidence := make([]rt.EvidenceInput, 0, len(parsed.Results))
	for _, r := range parsed.Results {
		totalChars += len([]rune(r.Content))
		meta := map[string]any{}
		if r.ArticleID != "" {
			meta["articleId"] = r.ArticleID
		}
		if r.KbID != "" {
			meta["knowledgeBaseId"] = r.KbID
		}
		if r.Path != "" {
			meta["nodeKey"] = r.Path
			meta["path"] = []string{r.Path}
		}
		evidence = append(evidence, rt.EvidenceInput{
			Source: rt.EvidenceKnowledge, Title: r.Title,
			Content: trimSpace(r.Content), Relevance: floatPtr(0.8), Confidence: floatPtr(0.8),
			FullRead: len([]rune(r.Content)) < 5500, Metadata: meta,
		})
	}
	summary := "读取结果为空"
	if len(parsed.Results) > 0 {
		summary = fmt.Sprintf("已读取 %d 个目标（合计 %d 字）", len(parsed.Results), totalChars)
	}
	return rt.ToolNormalizerResult{Summary: summary, Evidence: evidence}
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
	return kbListWikiOverview(context.Background(), ctx.UserID, kbID), nil
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
	cleaned, items := kbSearchWikiPages(context.Background(), ctx.UserID, kbID, queries, limit)
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
	detail, err := kbWikiPageDetailByPageKey(context.Background(), ctx.UserID, kbID, pageKey)
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
	// 全文读取：正文完整进证据，不在这里裁（与 TS 一致，体积由段内回传与证据预算统一兜底）
	evidenceContent := "[Wiki 页面 " + title + "]\n\n" + content
	meta := map[string]any{"kind": parsed.Kind}
	if parsed.PageKey != "" {
		meta["pageKey"] = parsed.PageKey
	}
	return rt.ToolNormalizerResult{
		Summary: fmt.Sprintf("已读取 Wiki 页面「%s」（%d 字%s），回答时请用 [[%s|%s]] 引用",
			title, len([]rune(content)),
			map[bool]string{true: fmt.Sprintf("，%d 个关联页面", neighborCount), false: ""}[neighborCount > 0],
			parsed.PageKey, title),
		Data: mustJSON(map[string]any{
			"pageKey": parsed.PageKey, "title": title, "kind": parsed.Kind,
			"excerpt": truncateRunes(content, 400),
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
		InputSchema: schemaJSON(`{"type":"object","properties":{"skillId":{"type":"string","enum":["knowledge","graph","research","memory","writer","documents","admin","system"]}},"required":["skillId"]}`),
		RiskLevel:   rt.RiskLow, Core: true,
		Execute: executeLoadSkill,
		Normalize: func(_ any, input any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{Summary: "技能加载请求已完成", Progress: boolPtr(false)}
		},
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "agent.list_skills", Name: "list_skills", Namespace: rt.NamespaceAgent,
		Description: "列出全部可加载的能力及加载状态。",
		InputSchema: schemaJSON(`{"type":"object","properties":{}}`),
		RiskLevel:   rt.RiskLow, Core: true,
		Execute: executeListSkills,
		Normalize: func(_ any, _ any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{Summary: "已列出可用能力目录", Progress: boolPtr(false)}
		},
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "agent.get_plan", Name: "get_plan", Namespace: rt.NamespaceAgent,
		Description: "查看当前任务计划与步骤状态。",
		InputSchema: schemaJSON(`{"type":"object","properties":{}}`),
		RiskLevel:   rt.RiskLow, Core: true,
		Execute: executeGetPlan,
		Normalize: func(_ any, _ any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{Summary: "已返回当前计划", Progress: boolPtr(false)}
		},
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "agent.update_plan", Name: "update_plan", Namespace: rt.NamespaceAgent,
		Description: "增删改查当前计划步骤（op: set/add/update/remove/reorder）。",
		InputSchema: schemaJSON(`{"type":"object","properties":{"ops":{"type":"array","items":{"type":"object","properties":{"op":{"type":"string"},"goal":{"type":"string"},"id":{"type":"string"},"status":{"type":"string"}},"required":["op"]}}},"required":["ops"]}`),
		RiskLevel:   rt.RiskLow,
		Execute:     executeUpdatePlan,
		Normalize: func(_ any, _ any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{Summary: "计划已更新", Progress: boolPtr(false)}
		},
	})
}

func executeLoadSkill(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	skillID, _ := params["skillId"].(string)
	if ctx.Services == nil {
		return nil, rt.PermissionDenied("服务面不可用")
	}
	result := ctx.Services.LoadSkill(skillID)
	payload, _ := json.Marshal(result)
	return json.RawMessage(payload), nil
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
				op.Steps = append(op.Steps, rt.PlanStepDraft{Goal: goal})
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
		ID: "documents", Name: "文档库", Description: "文档检索、阅读与导出",
		Instructions: joinStrings([]string{
			"## 文档操作",
			"1. document.search / document.read 用于检索与阅读文档库内容。",
			"2. 有副作用的文档操作必须明确用户确实要求了该操作，不要顺手创建或改动。",
			"3. 删除类操作必须走确认流程，禁止假装已删除。",
		}, "\n"),
		ToolIDs: []string{},
		Tags:    []string{"document"},
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
		ToolIDs: []string{},
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
		ToolIDs: []string{},
		Tags:    []string{"memory"},
	})

	skills.Register(rt.AgentSkill{
		ID: "writer", Name: "写作", Description: "长文撰写、改写、归纳与结构梳理",
		Instructions: joinStrings([]string{
			"## 写作",
			"1. 写作是操作能力，不是任务分类：先把资料查够，再进入写作。",
			"2. 长篇写作前先确定结构与信息来源；正文中的事实必须来自已获取的证据。",
		}, "\n"),
		ToolIDs: []string{},
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
		ToolIDs: []string{},
		Deps:    []string{"knowledge"},
		Tags:    []string{"retrieval"},
	})

	skills.Register(rt.AgentSkill{
		ID: "admin", Name: "管理", Description: "模型配置、API Key 与站点开关等管理操作",
		Instructions: joinStrings([]string{
			"## 管理操作",
			"1. 管理能力仅限操作员；没有权限时如实说明，不要绕路尝试。",
			"2. 查询类可直接执行；变更类属于高风险副作用，必须先走确认流程。",
		}, "\n"),
		ToolIDs: []string{},
		Tags:    []string{"admin"},
	})

	skills.Register(rt.AgentSkill{
		ID: "system", Name: "站点概览", Description: "系统与资源清单概览",
		Instructions: joinStrings([]string{
			"## 站点概览",
			"1. 回答\"有多少知识库/文档库/文章\"这类计数与清单问题时，优先用概览类工具，不要对每个库分别做一次检索。",
			"2. 概览结果只说明有什么，不说明内容；要回答内容问题仍需检索。",
		}, "\n"),
		ToolIDs: []string{},
		Tags:    []string{"system"},
	})
}

var _ = context.Background
