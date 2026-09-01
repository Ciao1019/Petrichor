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
)

// IngestWikiInput ingest 入参。
type IngestWikiInput struct {
	UserID          int64
	KnowledgeBaseID int64
	ArticleIDs      []int64
	ForceRebuild    bool
	FullRebuild     bool
}

// WikiIngest POST /api/kb/wiki/ingest：以当前登录用户身份编译知识库 Wiki。
func WikiIngest(c *ginContext) {
	run(c, func(c *ginContext) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}

		articleIDs := []int64{}
		if value, exists := raw["articleIds"]; exists && value != nil {
			list, ok := value.([]any)
			if !ok {
				return nil, badReq("articleIds 必须是数组")
			}
			if len(list) > 500 {
				return nil, badReq("articleIds 数量不能超过 500")
			}
			seen := make(map[int64]struct{}, len(list))
			for _, item := range list {
				id, parseErr := reqID(item, "ID 必须是正整数")
				if parseErr != nil {
					return nil, parseErr
				}
				if _, duplicate := seen[id]; duplicate {
					continue
				}
				seen[id] = struct{}{}
				articleIDs = append(articleIDs, id)
			}
		}

		return IngestWikiCore(c.Request.Context(), pool(), IngestWikiInput{
			UserID:          user.ID,
			KnowledgeBaseID: kbID,
			ArticleIDs:      articleIDs,
			ForceRebuild:    rawBool(raw, "forceRebuild"),
			FullRebuild:     rawBool(raw, "fullRebuild"),
		})
	})
}

// IngestWikiCore 对应 ingestKnowledgeBaseWiki：编译/增量更新知识库 Wiki。
func IngestWikiCore(ctx context.Context, q execQuerier, in IngestWikiInput) (map[string]any, error) {
	kbRow, err := assertKnowledgeBaseOwner(ctx, q, in.UserID, in.KnowledgeBaseID)
	if err != nil {
		return nil, err
	}
	// 编译上下文：知识库名 + 该库自定义的编译说明书（没保存过就是空的）。
	profile := loadCompileProfile(ctx, q, in.UserID, kbRow)
	if in.FullRebuild && len(in.ArticleIDs) > 0 {
		return nil, badReq("完全重建会清空整个知识库的 Wiki，不能同时指定文章范围")
	}

	var purged map[string]any
	if in.FullRebuild {
		purged, err = purgeKnowledgeBaseWiki(ctx, q, in.UserID, in.KnowledgeBaseID)
		if err != nil {
			return nil, err
		}
	}
	forceRebuild := in.ForceRebuild || in.FullRebuild

	articles, err := queryArticles(ctx, q,
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
		orphanedPageCount, err = pruneOrphanArticleWikiPages(ctx, q, in.UserID, in.KnowledgeBaseID, articles)
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
		indexPage, ierr := rebuildWikiIndex(ctx, q, in.UserID, in.KnowledgeBaseID, kbRow.Name, now)
		if ierr != nil {
			return nil, ierr
		}
		if lerr := logWikiEvent(ctx, q, in.UserID, in.KnowledgeBaseID, eventType, &indexPage.ID, map[string]any{
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
		existing, lerr := loadWikiPage(ctx, q, in.UserID, in.KnowledgeBaseID, pageKey)
		if lerr != nil {
			return nil, lerr
		}
		var page *WikiPageRow
		if existing != nil && readFrontmatterSourceHash(existing.FrontmatterJson) == sourceHash && !forceRebuild {
			page = existing
		} else {
			draft, derr := generateArticleWikiDraft(ctx, q, in.UserID, profile, article)
			if derr != nil {
				warnings = append(warnings, derr.Error())
				draft = buildFallbackArticleWikiDraft(article)
			}
			sourceUpdatedAt := iso(article.UpdatedAt)
			page, lerr = upsertWikiPage(ctx, q, upsertWikiPageInput{
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
		if terr := buildArticleTreeForIngest(ctx, q, treeBuildInput{
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

	indexPage, ierr := rebuildWikiIndex(ctx, q, in.UserID, in.KnowledgeBaseID, kbRow.Name, time.Now())
	if ierr != nil {
		return nil, ierr
	}
	if lerr := logWikiEvent(ctx, q, in.UserID, in.KnowledgeBaseID, eventType, &indexPage.ID, map[string]any{
		"articleCount": len(articles),
		"pageCount":    len(pageMaps) + 1,
		"purged":       purged,
		"warnings":     warnings,
	}); lerr != nil {
		return nil, lerr
	}

	// best-effort：编译后自动为新章节节点补写向量（已配置向量模型时才执行），失败不影响编译结果。
	if werr := embedTreeNodesBestEffort(ctx, q, in.UserID, in.KnowledgeBaseID); werr != nil {
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
// purgeKnowledgeBaseWiki 清空一个知识库的全部编译产物。
// kind='meta' 的页面（编译说明书）是用户手写的配置而不是编译产物，完全重建时保留。
func purgeKnowledgeBaseWiki(ctx context.Context, q execQuerier, userID, knowledgeBaseID int64) (map[string]any, error) {
	pageIDRows, err := q.Query(ctx,
		`SELECT id, page_key FROM petrichor_kb_wiki_page
		 WHERE user_id = $1 AND knowledge_base_id = $2 AND kind <> 'meta'`,
		userID, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	var refs []wikiPageRef
	var pageIDs []int64
	for pageIDRows.Next() {
		var ref wikiPageRef
		if err := pageIDRows.Scan(&ref.ID, &ref.PageKey); err != nil {
			pageIDRows.Close()
			return nil, err
		}
		refs = append(refs, ref)
		pageIDs = append(pageIDs, ref.ID)
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

	deleted, err := deleteWikiPagesCascade(ctx, q, userID, knowledgeBaseID, refs)
	if err != nil {
		return nil, err
	}

	return map[string]any{
		"pageCount":      deleted,
		"linkCount":      linkCount,
		"treeNodeCount":  treeNodeCount,
		"sourceRefCount": sourceRefCount,
	}, nil
}

// pruneOrphanArticleWikiPages 清理失去源文章的 Wiki 页面，返回删除数量。
func pruneOrphanArticleWikiPages(ctx context.Context, q execQuerier, userID, knowledgeBaseID int64, validArticles []ArticleRow) (int, error) {
	rows, err := q.Query(ctx,
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
	return deleteArticleWikiPages(ctx, q, userID, orphans, false)
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

func generateArticleWikiDraft(ctx context.Context, q execQuerier, userID int64, profile compileProfile, article *ArticleRow) (*articleWikiDraft, error) {
	if err := requireChat(); err != nil {
		return nil, err
	}
	content := article.ContentMd
	if len([]rune(content)) > 12000 {
		content = truncateRunes(content, 12000) + "\n\n[内容已截断]"
	}
	answer, err := ChatInvoker(ctx, ChatRequest{
		UserID: userID,
		SystemPrompt: profile.systemPrompt(
			"你是一个文档 Wiki 编译 Agent。",
			"请把源文档编译成可长期维护的 Wiki 中间层元数据。",
			"只输出 JSON，不要输出 Markdown 围栏。",
			"JSON 字段：summary:string, keyPoints:string[], entities:string[], questions:string[]。",
		),
		Message: strings.Join([]string{
			"知识库：" + profile.KnowledgeBaseName,
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
