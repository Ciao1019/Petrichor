// wiki-ingest.go 对照 wiki-agent-logic.ts 的 ingestKnowledgeBaseWiki 及其依赖：
// 完全重建清空 / 孤儿页清理 / LLM 编译草稿 / PageIndex 目录树构建 / 向量补写 best-effort。
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

// IngestWikiInput ingest 入参。
type IngestWikiInput struct {
	UserID          int64
	KnowledgeBaseID int64
	ArticleIDs      []int64
	ForceRebuild    bool
	FullRebuild     bool
}

// IngestWikiCore 对应 ingestKnowledgeBaseWiki：编译/增量更新知识库 Wiki。
func IngestWikiCore(q execQuerier, in IngestWikiInput) (map[string]any, error) {
	kbRow, err := assertKnowledgeBaseOwner(q, in.UserID, in.KnowledgeBaseID)
	if err != nil {
		return nil, err
	}
	if in.FullRebuild && len(in.ArticleIDs) > 0 {
		return nil, badReq("完全重建会清空整个知识库的 Wiki，不能同时指定文章范围")
	}

	var purged map[string]any
	if in.FullRebuild {
		purged, err = purgeKnowledgeBaseWiki(q, in.UserID, in.KnowledgeBaseID)
		if err != nil {
			return nil, err
		}
	}
	forceRebuild := in.ForceRebuild || in.FullRebuild

	articles, err := queryArticles(q,
		`SELECT `+articleColumns+` FROM petrichor_kb_article
		 WHERE user_id = $1 AND knowledge_base_id = $2
		 ORDER BY updated_at ASC, id ASC`, in.UserID, in.KnowledgeBaseID)
	if err != nil {
		return nil, err
	}
	if len(in.ArticleIDs) > 0 {
		idSet := map[int64]struct{}{}
		for _, id := range in.ArticleIDs {
			idSet[id] = struct{}{}
		}
		filtered := make([]ArticleRow, 0, len(articles))
		for i := range articles {
			if _, ok := idSet[articles[i].ID]; ok {
				filtered = append(filtered, articles[i])
			}
		}
		articles = filtered
	}

	warnings := []string{}
	orphanedPageCount := 0
	// 完全重建已经清空了所有页面，不存在孤儿页，跳过这一步扫描。
	if len(in.ArticleIDs) == 0 && purged == nil {
		orphanedPageCount, err = pruneOrphanArticleWikiPages(q, in.UserID, in.KnowledgeBaseID, articles)
		if err != nil {
			return nil, err
		}
		if orphanedPageCount > 0 {
			warnings = append(warnings, "已清理 "+strconv.Itoa(orphanedPageCount)+" 个失去源文章的 Wiki 页面")
		}
	}
	eventType := "INGEST"
	if in.FullRebuild {
		eventType = "REBUILD"
	}

	now := time.Now()
	if len(articles) == 0 {
		// 清空过内容时不再报错：知识库确实没有文章，但仍要把索引页重建成空索引。
		if orphanedPageCount == 0 && (purged == nil || purged["pageCount"].(int) == 0) {
			return nil, badReq("知识库里还没有可编译的文章")
		}
		indexPage, ierr := rebuildWikiIndex(q, in.UserID, in.KnowledgeBaseID, kbRow.Name, now)
		if ierr != nil {
			return nil, ierr
		}
		if lerr := logWikiEvent(q, in.UserID, in.KnowledgeBaseID, eventType, &indexPage.ID, nil, map[string]any{
			"articleCount": 0,
			"pageCount":    1,
			"purged":       purged,
			"warnings":     warnings,
		}); lerr != nil {
			return nil, lerr
		}
		return map[string]any{
			"knowledgeBaseId": strconv.FormatInt(in.KnowledgeBaseID, 10),
			"indexPage":       toWikiPageResponse(indexPage),
			"pages":           []map[string]any{},
			"purged":          purged,
			"warnings":        warnings,
		}, nil
	}

	pageMaps := make([]map[string]any, 0, len(articles))
	for i := range articles {
		article := &articles[i]
		sourceHash := sha256Hex(article.Title + "\n" + article.ContentMd)
		pageKey := buildArticleWikiSourcePageKey(article.ID)
		existing, lerr := loadWikiPage(q, in.UserID, in.KnowledgeBaseID, pageKey)
		if lerr != nil {
			return nil, lerr
		}
		var page *WikiPageRow
		if existing != nil && readFrontmatterSourceHash(existing.FrontmatterJson) == sourceHash && !forceRebuild {
			page = existing
		} else {
			draft, derr := generateArticleWikiDraft(q, in.UserID, kbRow.Name, article)
			if derr != nil {
				warnings = append(warnings, derr.Error())
				draft = buildFallbackArticleWikiDraft(article)
			}
			sourceUpdatedAt := iso(article.UpdatedAt)
			page, lerr = upsertWikiPage(q, upsertWikiPageInput{
				UserID:          in.UserID,
				KnowledgeBaseID: in.KnowledgeBaseID,
				PageKey:         pageKey,
				Title:           article.Title,
				Kind:            "source",
				ContentMd:       renderArticleWikiPage(article, draft),
				Summary:         &draft.Summary,
				Frontmatter: map[string]any{
					"articleId":       strconv.FormatInt(article.ID, 10),
					"sourceTitle":     article.Title,
					"sourceUpdatedAt": sourceUpdatedAt,
					"sourceHash":      sourceHash,
					"entities":        draft.Entities,
					"questions":       draft.Questions,
				},
				HasFrontmatter: true,
				SourceRefs: []sourceRefInput{{
					ArticleID: article.ID,
					Note:      strPtr("源文档"),
				}},
				Now: time.Now(),
			})
			if lerr != nil {
				return nil, lerr
			}
		}
		pageMaps = append(pageMaps, toWikiPageResponse(page))

		// PageIndex 式目录树：按结构指纹缓存，结构未变会跳过；失败仅记录告警。
		if terr := buildArticleTreeForIngest(q, treeBuildInput{
			UserID:            in.UserID,
			KnowledgeBaseID:   in.KnowledgeBaseID,
			KnowledgeBaseName: kbRow.Name,
			PageID:            page.ID,
			Article:           article,
			ForceRebuild:      forceRebuild,
		}); terr != nil {
			warnings = append(warnings, "目录树构建失败："+terr.Error())
		}
	}

	indexPage, ierr := rebuildWikiIndex(q, in.UserID, in.KnowledgeBaseID, kbRow.Name, time.Now())
	if ierr != nil {
		return nil, ierr
	}
	if lerr := logWikiEvent(q, in.UserID, in.KnowledgeBaseID, eventType, &indexPage.ID, nil, map[string]any{
		"articleCount": len(articles),
		"pageCount":    len(pageMaps) + 1,
		"purged":       purged,
		"warnings":     warnings,
	}); lerr != nil {
		return nil, lerr
	}

	// best-effort：编译后自动为新章节节点补写向量（已配置向量模型时才执行），失败不影响编译结果。
	if werr := embedTreeNodesBestEffort(q, in.UserID, in.KnowledgeBaseID); werr != nil {
		warnings = append(warnings, "向量生成失败："+werr.Error())
	} else if werr == nil && EmbedInvoker == nil {
		// 未接线向量服务时静默跳过，与 TS「无配置不告警」一致。
	}

	return map[string]any{
		"knowledgeBaseId": strconv.FormatInt(in.KnowledgeBaseID, 10),
		"indexPage":       toWikiPageResponse(indexPage),
		"pages":           pageMaps,
		"purged":          purged,
		"warnings":        dedupeStringsLimit(warnings, 5),
	}, nil
}

// purgeKnowledgeBaseWiki 清空知识库全部 Wiki 数据，返回各类数量回显。
func purgeKnowledgeBaseWiki(q execQuerier, userID, knowledgeBaseID int64) (map[string]any, error) {
	ctx := context.Background()
	pageIDRows, err := q.Query(ctx,
		`SELECT id FROM petrichor_kb_wiki_page WHERE user_id = $1 AND knowledge_base_id = $2`,
		userID, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	var pageIDs []int64
	for pageIDRows.Next() {
		var id int64
		if err := pageIDRows.Scan(&id); err != nil {
			pageIDRows.Close()
			return nil, err
		}
		pageIDs = append(pageIDs, id)
	}
	pageIDRows.Close()
	if err := pageIDRows.Err(); err != nil {
		return nil, err
	}

	var linkCount, treeNodeCount int64
	if err := q.QueryRow(ctx,
		`SELECT COUNT(*) FROM petrichor_kb_wiki_link WHERE user_id = $1 AND knowledge_base_id = $2`,
		userID, knowledgeBaseID).Scan(&linkCount); err != nil {
		return nil, err
	}
	if err := q.QueryRow(ctx,
		`SELECT COUNT(*) FROM petrichor_kb_wiki_tree_node WHERE user_id = $1 AND knowledge_base_id = $2`,
		userID, knowledgeBaseID).Scan(&treeNodeCount); err != nil {
		return nil, err
	}
	var sourceRefCount int64
	if len(pageIDs) > 0 {
		if err := q.QueryRow(ctx,
			`SELECT COUNT(*) FROM petrichor_kb_wiki_source_ref WHERE page_id = ANY($1)`, pageIDs).Scan(&sourceRefCount); err != nil {
			return nil, err
		}
	}

	if len(pageIDs) > 0 {
		if _, err := q.Exec(ctx,
			`UPDATE petrichor_kb_wiki_event_log SET page_id = NULL WHERE user_id = $1 AND knowledge_base_id = $2`,
			userID, knowledgeBaseID); err != nil {
			return nil, err
		}
		if _, err := q.Exec(ctx,
			`DELETE FROM petrichor_kb_wiki_source_ref WHERE page_id = ANY($1)`, pageIDs); err != nil {
			return nil, err
		}
	}
	if _, err := q.Exec(ctx,
		`DELETE FROM petrichor_kb_wiki_link WHERE user_id = $1 AND knowledge_base_id = $2`,
		userID, knowledgeBaseID); err != nil {
		return nil, err
	}
	if _, err := q.Exec(ctx,
		`DELETE FROM petrichor_kb_wiki_tree_node WHERE user_id = $1 AND knowledge_base_id = $2`,
		userID, knowledgeBaseID); err != nil {
		return nil, err
	}
	if _, err := q.Exec(ctx,
		`DELETE FROM petrichor_kb_wiki_page WHERE user_id = $1 AND knowledge_base_id = $2`,
		userID, knowledgeBaseID); err != nil {
		return nil, err
	}

	return map[string]any{
		"pageCount":      len(pageIDs),
		"linkCount":      linkCount,
		"treeNodeCount":  treeNodeCount,
		"sourceRefCount": sourceRefCount,
	}, nil
}

// pruneOrphanArticleWikiPages 清理失去源文章的 Wiki 页面，返回删除数量。
func pruneOrphanArticleWikiPages(q execQuerier, userID, knowledgeBaseID int64, validArticles []ArticleRow) (int, error) {
	rows, err := q.Query(context.Background(),
		`SELECT page_key FROM petrichor_kb_wiki_page
		 WHERE user_id = $1 AND knowledge_base_id = $2 AND kind = 'source'`,
		userID, knowledgeBaseID)
	if err != nil {
		return 0, err
	}
	validIDs := map[int64]struct{}{}
	for i := range validArticles {
		validIDs[validArticles[i].ID] = struct{}{}
	}
	var orphans []ArticleRow
	for rows.Next() {
		var pageKey string
		if err := rows.Scan(&pageKey); err != nil {
			rows.Close()
			return 0, err
		}
		if id, ok := parseSourcePageKey(pageKey); ok {
			if _, stillValid := validIDs[id]; !stillValid {
				orphans = append(orphans, ArticleRow{ID: id, KnowledgeBaseID: knowledgeBaseID})
			}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if len(orphans) == 0 {
		return 0, nil
	}
	return deleteArticleWikiPages(q, userID, orphans, false)
}

var sourcePageKeyRe = regexp.MustCompile(`^source-(\d+)$`)

func parseSourcePageKey(pageKey string) (int64, bool) {
	m := sourcePageKeyRe.FindStringSubmatch(pageKey)
	if m == nil {
		return 0, false
	}
	id, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil || id <= 0 {
		return 0, false
	}
	return id, true
}

// ===== LLM 编译草稿 =====

type articleWikiDraft struct {
	Summary   string   `json:"summary"`
	KeyPoints []string `json:"keyPoints"`
	Entities  []string `json:"entities"`
	Questions []string `json:"questions"`
}

func generateArticleWikiDraft(q execQuerier, userID int64, knowledgeBaseName string, article *ArticleRow) (*articleWikiDraft, error) {
	if err := requireChat(); err != nil {
		return nil, err
	}
	content := article.ContentMd
	if len([]rune(content)) > 12000 {
		content = truncateRunes(content, 12000) + "\n\n[内容已截断]"
	}
	answer, err := ChatInvoker(context.Background(), ChatRequest{
		UserID: userID,
		SystemPrompt: strings.Join([]string{
			"你是一个文档 Wiki 编译 Agent。",
			"请把源文档编译成可长期维护的 Wiki 中间层元数据。",
			"只输出 JSON，不要输出 Markdown 围栏。",
			"JSON 字段：summary:string, keyPoints:string[], entities:string[], questions:string[]。",
		}, "\n"),
		Message: strings.Join([]string{
			"知识库：" + knowledgeBaseName,
			"文档标题：" + article.Title,
			"文档内容：",
			content,
		}, "\n\n"),
		Op: "kb.wiki.ingest",
	})
	if err != nil {
		return nil, err
	}
	jsonText, terr := extractJsonObjectText(answer)
	if terr != nil {
		return nil, terr
	}
	var parsed map[string]any
	if jerr := json.Unmarshal([]byte(jsonText), &parsed); jerr != nil {
		return nil, badReq("模型没有返回合法 JSON")
	}
	fallbackSummary := summarizePlainText(article.ContentMd, 240)
	summary := trimSpace(optString(parsed["summary"]))
	if summary == "" {
		summary = fallbackSummary
	}
	return &articleWikiDraft{
		Summary:   summary,
		KeyPoints: normalizeStringListLimit(parsed["keyPoints"], 12),
		Entities:  normalizeStringListLimit(parsed["entities"], 20),
		Questions: normalizeStringListLimit(parsed["questions"], 8),
	}, nil
}

func buildFallbackArticleWikiDraft(article *ArticleRow) *articleWikiDraft {
	headings := extractMarkdownHeadingsSimple(article.ContentMd)
	keyPoints := headings
	if len(keyPoints) == 0 {
		keyPoints = splitSentencesSimple(article.ContentMd, 8)
	} else if len(keyPoints) > 12 {
		keyPoints = keyPoints[:12]
	}
	return &articleWikiDraft{
		Summary:   summarizePlainText(article.ContentMd, 240),
		KeyPoints: keyPoints,
		Entities:  []string{},
		Questions: []string{
			article.Title + " 的核心结论是什么？",
			article.Title + " 中有哪些关键概念？",
		},
	}
}

func renderArticleWikiPage(article *ArticleRow, draft *articleWikiDraft) string {
	keyPoints := "- 暂无结构化要点"
	if len(draft.KeyPoints) > 0 {
		items := make([]string, 0, len(draft.KeyPoints))
		for _, item := range draft.KeyPoints {
			items = append(items, "- "+item)
		}
		keyPoints = strings.Join(items, "\n")
	}
	entities := "暂无"
	if len(draft.Entities) > 0 {
		quoted := make([]string, 0, len(draft.Entities))
		for _, item := range draft.Entities {
			quoted = append(quoted, "`"+item+"`")
		}
		entities = strings.Join(quoted, "、")
	}
	questions := "- 暂无"
	if len(draft.Questions) > 0 {
		items := make([]string, 0, len(draft.Questions))
		for _, item := range draft.Questions {
			items = append(items, "- "+item)
		}
		questions = strings.Join(items, "\n")
	}
	return strings.Join([]string{
		"# " + article.Title,
		"",
		"## 摘要",
		draft.Summary,
		"",
		"## 关键要点",
		keyPoints,
		"",
		"## 相关实体",
		entities,
		"",
		"## 可回答的问题",
		questions,
		"",
		"## 来源",
		"- 源文档 ID：" + strconv.FormatInt(article.ID, 10),
		"- 最近更新：" + iso(article.UpdatedAt),
	}, "\n")
}

func extractMarkdownHeadingsSimple(markdown string) []string {
	out := []string{}
	for _, line := range strings.Split(markdown, "\r\n") {
		line = strings.TrimPrefix(line, "\n")
		if m := regexp.MustCompile(`^#{1,4}\s+(.+)$`).FindStringSubmatch(line); m != nil {
			if t := trimSpace(m[1]); t != "" {
				out = append(out, t)
			}
		}
	}
	return out
}

func splitSentencesSimple(markdown string, limit int) []string {
	text := summarizePlainText(markdown, 1200)
	parts := regexp.MustCompile(`[。！？.!?\s]*。|[。！？.!?]\s*`).Split(text, -1)
	out := []string{}
	for _, part := range parts {
		if t := trimSpace(part); t != "" {
			out = append(out, t)
			if len(out) >= limit {
				break
			}
		}
	}
	return out
}

func normalizeStringListLimit(raw any, limit int) []string {
	list, ok := raw.([]any)
	if !ok {
		return []string{}
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(list))
	for _, item := range list {
		s := trimSpace(toStr(item))
		if s == "" {
			continue
		}
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
		if len(out) >= limit {
			break
		}
	}
	return out
}

func dedupeStringsLimit(values []string, limit int) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, v := range values {
		if _, dup := seen[v]; dup {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
		if len(out) >= limit {
			break
		}
	}
	return out
}

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
func buildArticleTreeForIngest(q execQuerier, in treeBuildInput) error {
	ctx := context.Background()
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
	defer tx.Rollback(context.Background())

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
	return tx.Commit(context.Background())
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
func embedTreeNodesBestEffort(q execQuerier, userID, knowledgeBaseID int64) error {
	if EmbedInvoker == nil {
		return nil
	}
	profile, err := loadEmbeddingProfileOrNull(q, userID)
	if err != nil {
		return err
	}
	if profile == nil || profile.dimensions == nil {
		return nil
	}
	ctx := context.Background()
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
