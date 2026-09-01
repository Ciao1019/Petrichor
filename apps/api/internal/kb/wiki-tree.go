// wiki-tree.go PageIndex 式目录树：把源文档按标题层级切成可导航的树节点，
// 带 LLM 章节摘要和向量，供 knowledge.outline 与存量召回路径使用。
// 树只在 /kb/wiki/ingest 编译时构建；「构建知识」走的是分片索引，不写这里。
//
// 目录树是 tree_node 表唯一的生产者，写库 SQL 保留在本文件而不进 wikimutation.go：
// 那里收敛的是 page / link / source_ref 这类多处重复的写法，树没有第二个写入方。
package kb

import (
	"context"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// ===== PageIndex 目录树构建（对照 wiki-tree.ts buildArticleTree）=====

type parsedTreeNode struct {
	position       int
	depth          int
	title          string
	parentPosition int // -1 表示无父节点
	contentMd      string
	startLine      int
	endLine        int
}

var (
	treeHeadingPattern = regexp.MustCompile(`^(#{1,6})\s+(.+?)\s*#*\s*$`)
	treeFencePattern   = regexp.MustCompile(`^\s*(` + "`" + `{3}|~{3})`)
)

func parseMarkdownTree(markdown, rootTitle string) []parsedTreeNode {
	lines := strings.Split(strings.ReplaceAll(markdown, "\r\n", "\n"), "\n")
	type headingInfo struct {
		level int
		title string
		line  int
	}
	var headings []headingInfo
	inFence := false
	for index, line := range lines {
		if treeFencePattern.MatchString(line) {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		if m := treeHeadingPattern.FindStringSubmatch(line); m != nil {
			headings = append(headings, headingInfo{level: len(m[1]), title: trimSpace(m[2]), line: index})
		}
	}

	preambleEnd := len(lines)
	if len(headings) > 0 {
		preambleEnd = headings[0].line
	}
	rootBody := trimSpace(strings.Join(lines[:preambleEnd], "\n"))
	rootTitleOut := trimSpace(rootTitle)
	if rootTitleOut == "" {
		rootTitleOut = "（无标题文档）"
	}
	nodes := []parsedTreeNode{{
		position:       0,
		depth:          0,
		title:          rootTitleOut,
		parentPosition: -1,
		contentMd:      rootBody,
		startLine:      1,
		endLine:        preambleEnd,
	}}

	type ancestor struct{ depth, position int }
	ancestors := []ancestor{{depth: 0, position: 0}}
	for index, heading := range headings {
		bodyStart := heading.line + 1
		bodyEnd := len(lines)
		if index+1 < len(headings) {
			bodyEnd = headings[index+1].line
		}
		position := index + 1
		for len(ancestors) > 0 && ancestors[len(ancestors)-1].depth >= heading.level {
			ancestors = ancestors[:len(ancestors)-1]
		}
		parentPosition := 0
		if len(ancestors) > 0 {
			parentPosition = ancestors[len(ancestors)-1].position
		}
		title := heading.title
		if title == "" {
			title = "章节 " + strconv.Itoa(position)
		}
		nodes = append(nodes, parsedTreeNode{
			position:       position,
			depth:          heading.level,
			title:          title,
			parentPosition: parentPosition,
			contentMd:      trimSpace(strings.Join(lines[bodyStart:bodyEnd], "\n")),
			startLine:      heading.line + 1,
			endLine:        bodyEnd,
		})
		ancestors = append(ancestors, ancestor{depth: heading.level, position: position})
	}
	return nodes
}

func treeNodeKeyOf(articleID int64, position int) string {
	return "a" + strconv.FormatInt(articleID, 10) + "-" + strconv.Itoa(position)
}

func hashParsedTree(nodes []parsedTreeNode) string {
	parts := make([]string, 0, len(nodes))
	for _, node := range nodes {
		parts = append(parts, strconv.Itoa(node.position)+"|"+strconv.Itoa(node.depth)+"|"+node.title+"|"+node.contentMd)
	}
	return sha256Hex(strings.Join(parts, "\n--\n"))
}

func estimateTreeTokens(text string) int32 {
	if text == "" {
		return 0
	}
	var tokens float64
	for _, r := range text {
		code := uint32(r)
		if (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af) {
			tokens += 1
		} else {
			tokens += 0.25
		}
	}
	if tokens < 0 {
		tokens = 0
	}
	return int32(tokens + 0.99999999)
}

func localTreeSummary(node parsedTreeNode, maxLength int) string {
	text := node.contentMd
	if text == "" {
		text = node.title
	}
	text = fenceRe.ReplaceAllString(text, " ")
	text = inlineCode.ReplaceAllString(text, "$1")
	text = mdImageRe.ReplaceAllString(text, " ")
	text = mdLinkRe.ReplaceAllString(text, "$1")
	text = mdSymbolRe.ReplaceAllString(text, " ")
	text = spaceRe.ReplaceAllString(text, " ")
	text = trimSpace(text)
	if text == "" {
		return node.title
	}
	runes := []rune(text)
	if len(runes) <= maxLength {
		return text
	}
	return trimSpace(string(runes[:maxLength])) + "..."
}

const (
	maxNodesForLLMSummary  = 40
	maxBodyCharsForSummary = 400
)

// generateNodeSummaries 用一次 LLM 调用批量生成节点摘要；失败或节点过多时退回本地摘要。
func generateNodeSummaries(ctx context.Context, userID int64, knowledgeBaseName, articleTitle string, nodes []parsedTreeNode) map[int]string {
	result := map[int]string{}
	summarizable := 0
	for i := range nodes {
		if trimSpace(nodes[i].contentMd) != "" {
			summarizable++
		}
	}
	if summarizable == 0 || summarizable > maxNodesForLLMSummary || ChatInvoker == nil {
		for i := range nodes {
			result[nodes[i].position] = localTreeSummary(nodes[i], 120)
		}
		return result
	}

	var outlineParts []string
	for i := range nodes {
		node := &nodes[i]
		if trimSpace(node.contentMd) == "" {
			continue
		}
		body := node.contentMd
		if len([]rune(body)) > maxBodyCharsForSummary {
			body = truncateRunes(body, maxBodyCharsForSummary) + "…"
		}
		level := node.depth
		if level < 1 {
			level = 1
		}
		outlineParts = append(outlineParts,
			"["+strconv.Itoa(node.position)+"] "+strings.Repeat("#", level)+" "+node.title+"\n"+body)
	}
	answer, err := ChatInvoker(ctx, ChatRequest{
		UserID: userID,
		SystemPrompt: strings.Join([]string{
			"你是文档目录编译器。为每个章节写一句话中文摘要（不超过 60 字，聚焦该章节回答了什么）。",
			"只输出 JSON，不要 Markdown 围栏。",
			`JSON 结构：{"summaries": {"<position>": "摘要"}}，position 用方括号里的数字。`,
		}, "\n"),
		Message: strings.Join([]string{
			"知识库：" + knowledgeBaseName,
			"文档：" + articleTitle,
			"章节列表：",
			strings.Join(outlineParts, "\n\n"),
		}, "\n\n"),
		Op: "kb.wiki.tree.summary",
	})
	if err != nil {
		for i := range nodes {
			result[nodes[i].position] = localTreeSummary(nodes[i], 120)
		}
		return result
	}
	parsed := parseSummaryJSONMap(answer)
	for i := range nodes {
		value := trimSpace(parsed[nodes[i].position])
		if value == "" {
			value = localTreeSummary(nodes[i], 120)
		}
		result[nodes[i].position] = value
	}
	return result
}

func parseSummaryJSONMap(raw string) map[int]string {
	result := map[int]string{}
	jsonText, err := extractJsonObjectText(raw)
	if err != nil {
		return result
	}
	var parsed struct {
		Summaries map[string]string `json:"summaries"`
	}
	if json.Unmarshal([]byte(jsonText), &parsed) != nil {
		return result
	}
	for key, value := range parsed.Summaries {
		position, perr := strconv.Atoi(key)
		if perr != nil || trimSpace(value) == "" {
			continue
		}
		result[position] = trimSpace(value)
	}
	return result
}

type treeBuildInput struct {
	UserID            int64
	KnowledgeBaseID   int64
	KnowledgeBaseName string
	PageID            int64
	Article           *ArticleRow
	ForceRebuild      bool
}

// buildArticleTreeForIngest 为单篇源文档构建/刷新目录树并落库（结构指纹缓存）。
func buildArticleTreeForIngest(ctx context.Context, q execQuerier, in treeBuildInput) error {
	parsed := parseMarkdownTree(in.Article.ContentMd, in.Article.Title)
	treeHash := hashParsedTree(parsed)

	existingRows, err := q.Query(ctx,
		`SELECT id, content_hash, node_key FROM petrichor_kb_wiki_tree_node WHERE article_id = $1`,
		in.Article.ID)
	if err != nil {
		return err
	}
	type existingNode struct {
		id          int64
		contentHash string
		nodeKey     string
	}
	var existing []existingNode
	for existingRows.Next() {
		var row existingNode
		if err := existingRows.Scan(&row.id, &row.contentHash, &row.nodeKey); err != nil {
			existingRows.Close()
			return err
		}
		existing = append(existing, row)
	}
	existingRows.Close()
	if err := existingRows.Err(); err != nil {
		return err
	}

	rootKey := treeNodeKeyOf(in.Article.ID, 0)
	cachedHash := ""
	countMatch := len(existing) == len(parsed)
	for _, row := range existing {
		if row.nodeKey == rootKey {
			cachedHash = row.contentHash
		}
	}
	if !in.ForceRebuild && cachedHash == treeHash && countMatch {
		return nil
	}

	summaries := generateNodeSummaries(ctx, in.UserID, in.KnowledgeBaseName, in.Article.Title, parsed)

	tx, err := q.(interface {
		Begin(ctx context.Context) (pgx.Tx, error)
	}).Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	if _, err := tx.Exec(ctx,
		`DELETE FROM petrichor_kb_wiki_tree_node WHERE article_id = $1`, in.Article.ID); err != nil {
		return err
	}
	now := time.Now()
	for _, node := range parsed {
		summary := summaries[node.position]
		nodeKey := treeNodeKeyOf(in.Article.ID, node.position)
		var parentKey any
		if node.parentPosition >= 0 {
			parentKey = treeNodeKeyOf(in.Article.ID, node.parentPosition)
		}
		contentHash := sha256Hex(node.contentMd)
		if node.position == 0 {
			contentHash = treeHash
		}
		var startLine, endLine int32
		startLine = int32(node.startLine)
		endLine = int32(node.endLine)
		if _, err := tx.Exec(ctx,
			`INSERT INTO petrichor_kb_wiki_tree_node (user_id, knowledge_base_id, page_id, article_id,
			 node_key, parent_key, depth, position, title, summary, content_md, start_line, end_line,
			 token_estimate, content_hash, embedding_status, embedding_version,
			 search_title_tokens, search_summary_tokens, search_content_tokens, created_at, updated_at)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending',1,$16,$17,$18,$19,$19)`,
			in.UserID, in.KnowledgeBaseID, in.PageID, in.Article.ID,
			nodeKey, parentKey, int32(node.depth), int32(node.position), node.title, summary, node.contentMd,
			startLine, endLine, estimateTreeTokens(node.contentMd), contentHash,
			buildIndexTokenText(node.title, 200),
			buildIndexTokenText(summary, 400),
			buildIndexTokenText(node.contentMd, 4000),
			now); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// buildIndexTokens 文档侧词元：英文/数字按词，中文按 2 字滑窗（对照 retrieval/tokenize.ts）。
func buildIndexTokens(text string, maxTokens int) []string {
	normalized := strings.ToLower(trimSpace(text))
	if normalized == "" {
		return nil
	}
	cjkRun := regexp.MustCompile(`[\x{3400}-\x{4DBF}\x{4E00}-\x{9FFF}\x{F900}-\x{FAFF}]+`)
	splitRe := spaceRe
	var tokens []string
	for _, part := range splitRe.Split(normalized, -1) {
		if part == "" {
			continue
		}
		runs := cjkRun.FindAllString(part, -1)
		if len(runs) == 0 {
			if len([]rune(part)) >= 2 {
				tokens = append(tokens, part)
			}
			continue
		}
		for _, run := range runs {
			runes := []rune(run)
			if len(runes) == 1 {
				tokens = append(tokens, run)
				continue
			}
			for i := 0; i+2 <= len(runes); i++ {
				tokens = append(tokens, string(runes[i:i+2]))
			}
		}
		latinParts := cjkRun.Split(part, -1)
		for _, latin := range latinParts {
			if latin != "" && len([]rune(latin)) >= 2 {
				tokens = append(tokens, latin)
			}
		}
	}
	if len(tokens) > maxTokens {
		tokens = tokens[:maxTokens]
	}
	return tokens
}

// buildIndexTokenText 写入索引列的空格连接词元串。
func buildIndexTokenText(text string, maxTokens int) string {
	return strings.Join(buildIndexTokens(text, maxTokens), " ")
}

// ===== 向量补写（best-effort）=====

// embedTreeNodesBestEffort 为尚未向量化的目录树节点补写向量；无配置/出错时返回错误由调用方决定是否告警。
func embedTreeNodesBestEffort(ctx context.Context, q execQuerier, userID, knowledgeBaseID int64) error {
	if EmbedInvoker == nil {
		return nil
	}
	profile, err := loadEmbeddingProfileOrNull(ctx, q, userID)
	if err != nil {
		return err
	}
	if profile == nil || profile.dimensions == nil {
		return nil
	}
	rows, err := q.Query(ctx,
		`SELECT id, title, COALESCE(summary, ''), content_md FROM petrichor_kb_wiki_tree_node
		 WHERE user_id = $1 AND knowledge_base_id = $2
		   AND (embedding IS NULL OR embedding_status <> 'ready'
		     OR embedding_model IS DISTINCT FROM $3
		     OR embedding_dimensions IS DISTINCT FROM $4
		     OR embedding_version IS DISTINCT FROM $5)
		 ORDER BY article_id ASC, position ASC
		 LIMIT $6`,
		userID, knowledgeBaseID, profile.model, *profile.dimensions, profile.version, maxEmbedPerPhase)
	if err != nil {
		return err
	}
	type pendingNode struct {
		id    int64
		title string
		summ  string
		body  string
	}
	var pending []pendingNode
	for rows.Next() {
		var node pendingNode
		if err := rows.Scan(&node.id, &node.title, &node.summ, &node.body); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, node)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(pending) == 0 {
		return nil
	}

	written := 0
	for offset := 0; offset < len(pending); offset += indexBatchSize {
		end := offset + indexBatchSize
		if end > len(pending) {
			end = len(pending)
		}
		batch := pending[offset:end]
		texts := make([]string, 0, len(batch))
		for i := range batch {
			parts := []string{}
			for _, candidate := range []string{trimSpace(batch[i].title), trimSpace(batch[i].summ), trimSpace(batch[i].body)} {
				if candidate != "" {
					parts = append(parts, candidate)
				}
			}
			text := strings.Join(parts, "\n")
			if len([]rune(text)) > maxEmbedTextChars {
				text = truncateRunes(text, maxEmbedTextChars)
			}
			texts = append(texts, text)
		}
		vectors, verr := EmbedInvoker(ctx, EmbedRequest{UserID: userID, Texts: texts, Op: "kb.wiki.tree.embed"})
		if verr != nil {
			message := verr.Error()
			if len([]rune(message)) > 1000 {
				message = string([]rune(message)[:1000])
			}
			ids := make([]int64, 0, len(batch))
			for i := range batch {
				ids = append(ids, batch[i].id)
			}
			_, _ = q.Exec(ctx,
				`UPDATE petrichor_kb_wiki_tree_node SET embedding_status = 'failed', embedding_error = $1,
				 embedding_updated_at = now() WHERE id = ANY($2)`, message, ids)
			return verr
		}
		for i := range batch {
			if i >= len(vectors) || vectors[i] == nil {
				continue
			}
			literal := vectorLiteral(vectors[i])
			if _, uerr := q.Exec(ctx,
				`UPDATE petrichor_kb_wiki_tree_node SET embedding = $1::vector, embedding_status = 'ready',
				 embedding_model = $2, embedding_dimensions = $3, embedding_version = $4, embedding_error = NULL,
				 embedding_updated_at = now(), updated_at = now() WHERE id = $5`,
				literal, profile.model, int32(len(vectors[i])), profile.version, batch[i].id); uerr != nil {
				return uerr
			}
			written++
		}
	}
	_ = written
	return nil
}
