// wiki-build.go 对照 wiki-agent-logic.ts 的 buildArticleKnowledge / ingestKnowledgeBaseWiki
// 与 wiki-tree.ts 的 buildArticleTree。LLM 调用统一走 ChatInvoker（nil 时 503）。
package kb

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// ===== knowledge/build =====

// ArticleKnowledgeBuild 单篇「构建知识」：切片 → 问题 → 候选抽取 → 目录 → 页面物化 → 落库。
func ArticleKnowledgeBuild(c *ginContext) {
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
		articleID, err := reqID(raw["articleId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		forceRebuild := rawBool(raw, "forceRebuild")
		_ = forceRebuild // TS 版同样未消费该参数：构建恒为全量重建
		if err := requireChat(); err != nil {
			return nil, err
		}

		q := pool()
		kb, err := assertKnowledgeBaseOwner(q, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		article, err := queryArticle(q,
			`SELECT `+articleColumns+` FROM petrichor_kb_article
			 WHERE id = $1 AND user_id = $2 AND knowledge_base_id = $3 LIMIT 1`,
			articleID, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		if article == nil {
			return nil, notFoundErr("文章不存在")
		}
		if trimSpace(article.ContentMd) == "" {
			return nil, badReq("文章没有可构建的 Markdown 内容")
		}

		existingRows, err := queryWikiPagesWhere(q,
			`user_id = $1 AND knowledge_base_id = $2 AND kind IN ('entity','concept') AND archived_at IS NULL`,
			user.ID, kbID)
		if err != nil {
			return nil, err
		}
		existingPages := make([]existingKnowledgePage, 0, len(existingRows))
		for i := range existingRows {
			page := &existingRows[i]
			metadata := readKnowledgePageMetadata(page.FrontmatterJson)
			kind := "entity"
			if page.Kind == "concept" {
				kind = "concept"
			}
			buildVersion := int64(0)
			if v, ok := metadata["buildVersion"].(float64); ok {
				buildVersion = int64(v)
			}
			existingPages = append(existingPages, existingKnowledgePage{
				pageKey:      page.PageKey,
				title:        page.Title,
				kind:         kind,
				aliases:      toStrSlice(metadata["aliases"]),
				summary:      derefStr(page.Summary),
				categoryPath: toStrSlice(metadata["categoryPath"]),
				buildVersion: buildVersion,
			})
		}

		ctx := context.Background()
		chunks, truncated := splitMarkdownForKnowledgeBuild(article.ContentMd, article.Title, 0)
		warnings := []string{}
		if truncated {
			warnings = append(warnings, "文档过长，仅前 "+jsonNumber(knowledgeChunkLimit)+" 个切片参与了知识构建，后续内容未生成推荐问题")
		}
		if len(chunks) == 0 {
			return nil, badReq("文章没有可构建的 Markdown 切片")
		}

		chunksWithQuestions, questionWarnings := generateChunkQuestions(ctx, user.ID, kb.Name, article.Title, chunks)
		warnings = append(warnings, questionWarnings...)
		documentSummary, candidates, relations, extractionWarnings := extractDocumentCandidates(
			ctx, user.ID, kb.Name, article.Title, article.ContentMd, existingPages)
		warnings = append(warnings, extractionWarnings...)

		questionsByKey := map[string][]string{}
		for _, cqw := range chunksWithQuestions {
			questionsByKey[cqw.chunk.chunkKey] = cqw.recommendedQuestions
		}
		for index := range chunks {
			if questions := questionsByKey[chunks[index].chunkKey]; questions != nil {
				chunks[index].recommendedQuestions = questions
			} else {
				chunks[index].recommendedQuestions = normalizeRecommendedQuestions(nil, chunks[index].heading)
			}
		}
		candidates, warnings = planKnowledgeTaxonomy(ctx, user.ID, kb.Name, article.Title, candidates, existingPages, warnings)
		items, warnings := materializeWikiPages(ctx, user.ID, kb.Name, article.Title, article.ContentMd, candidates, relations, warnings)

		sourcePage, entityCount, conceptCount, werr := persistKnowledgeBuild(
			c, q, user.ID, kbID, kb.Name, article, chunksWithQuestions, documentSummary, items, relations, warnings)
		if werr != nil {
			return nil, werr
		}

		// 提交后 best-effort 补向量；EmbedInvoker 未注入时静默跳过。
		if EmbedInvoker != nil {
			if profile, perr := loadEmbeddingProfileOrNull(q, user.ID); perr == nil && profile != nil {
				rows, _, lerr := loadPendingIndexRows(q, user.ID, kbID, "chunk", profile)
				if lerr == nil {
					_, _ = writeIndexEmbeddings(q, user.ID, rows, profile)
				}
			}
		}

		return map[string]any{
			"articleId":                strconv.FormatInt(article.ID, 10),
			"knowledgeBaseId":          strconv.FormatInt(article.KnowledgeBaseID, 10),
			"fromCache":                false,
			"chunkCount":               len(chunksWithQuestions),
			"recommendedQuestionCount": len(chunksWithQuestions) * 3,
			"entityCount":              entityCount,
			"conceptCount":             conceptCount,
			"sourcePage":               toWikiPageResponse(sourcePage),
			"warnings":                 warningsOrEmpty(warnings),
		}, nil
	})
}

func warningsOrEmpty(in []string) []string {
	if in == nil {
		return []string{}
	}
	return in
}

func toStrSlice(v any) []string {
	if list, ok := v.([]string); ok {
		return list
	}
	return normalizeStringList(v, -1)
}

type wfChunkWithQuestions = chunkWithQuestions

type txBeginner interface {
	execQuerier
	Begin(ctx context.Context) (pgx.Tx, error)
}

// persistKnowledgeBuild 对应 buildArticleKnowledge 的落库事务。
func persistKnowledgeBuild(c *ginContext, q txBeginner, userID, kbID int64, kbName string,
	article *ArticleRow, chunks []chunkWithQuestions, documentSummary string,
	items []extractedItem, relations []knowledgeRelation, warnings []string,
) (*WikiPageRow, int, int, error) {
	ctx := context.Background()
	tx, err := q.Begin(ctx)
	if err != nil {
		return nil, 0, 0, err
	}
	defer tx.Rollback(context.Background())

	now := time.Now()
	if _, err := tx.Exec(ctx,
		`DELETE FROM petrichor_kb_article_chunk WHERE user_id = $1 AND article_id = $2`,
		userID, article.ID); err != nil {
		return nil, 0, 0, err
	}
	insertedChunks := make([]ChunkRow, 0, len(chunks))
	for _, cq := range chunks {
		chunk := cq.chunk
		var id int64
		headingPathJSON := marshalJSON(chunk.headingPath)
		questionsJSON := marshalJSON(cq.recommendedQuestions)
		contentHash := sha256Hex(chunk.contentMd)
		if err := tx.QueryRow(ctx,
			`INSERT INTO petrichor_kb_article_chunk (user_id, knowledge_base_id, article_id, chunk_key,
			 position, heading, content_md, content_hash, heading_path_json, recommended_questions_json, updated_at)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
			userID, kbID, article.ID, chunk.chunkKey, chunk.position, chunk.heading,
			chunk.contentMd, contentHash, headingPathJSON, questionsJSON, now).Scan(&id); err != nil {
			return nil, 0, 0, err
		}
		insertedChunks = append(insertedChunks, ChunkRow{
			ID: id, UserID: userID, KnowledgeBaseID: kbID, ArticleID: article.ID,
			ChunkKey: chunk.chunkKey, Position: chunk.position, Heading: chunk.heading,
			ContentMd: chunk.contentMd, ContentHash: contentHash,
			HeadingPathJson: derefStr(headingPathJSON), RecommendedQuestionsJson: derefStr(questionsJSON),
			UpdatedAt: now,
		})
	}

	// 分片检索索引：全部 chunk 在前、全部问题在后。
	for _, chunk := range insertedChunks {
		headingPath := parseStringArray(&chunk.HeadingPathJson)
		if len(headingPath) == 0 {
			headingPath = []string{chunk.Heading}
		}
		writeIndexValues := func(sourceType string, sourcePosition int32, content string) error {
			prefix := []string{article.Title}
			for _, p := range headingPath {
				prefix = append(prefix, p)
			}
			prefix = dedupeStrings(prefix)
			embeddingText := strings.Join(append(prefix, trimSpace(content)), "\n")
			embeddingText = truncateRunes(embeddingText, maxEmbedTextChars)
			searchTokens := embeddingText // 简化：词元展开由检索侧处理（偏差见交付说明）
			_, ierr := tx.Exec(ctx,
				`INSERT INTO petrichor_kb_article_chunk_index (user_id, knowledge_base_id, article_id,
				 chunk_id, source_key, source_type, source_position, content, embedding_text,
				 content_hash, search_tokens, embedding_status, embedding_version, updated_at)
			 	 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13)
				 ON CONFLICT (user_id, article_id, source_key) DO NOTHING`,
				userID, kbID, article.ID, chunk.ID,
				chunk.ChunkKey+":chunk", sourceType, sourcePosition, content,
				embeddingText, sha256Hex(embeddingText), searchTokens,
				int32(ArticleKnowledgeIndexVersion), now)
			return ierr
		}
		if err := writeIndexValues("chunk", 0, chunk.ContentMd); err != nil {
			return nil, 0, 0, err
		}
		questions := parseStringArray(&chunk.RecommendedQuestionsJson)
		for index, question := range questions {
			if err := writeIndexValues("question", int32(index), question); err != nil {
				return nil, 0, 0, err
			}
		}
	}

	sourcePageKey := buildArticleWikiSourcePageKey(article.ID)
	if err := detachArticleFromGeneratedKnowledgePages(tx, userID, kbID, article.ID); err != nil {
		return nil, 0, 0, err
	}
	if _, err := deleteWikiPageByKey(tx, userID, kbID, sourcePageKey); err != nil {
		return nil, 0, 0, err
	}

	entityCount, conceptCount := 0, 0
	generatedPages := make([]*WikiPageRow, 0, len(items))
	for _, item := range items {
		page, perr := upsertExtractedKnowledgePage(tx, userID, kbID, article, item)
		if perr != nil {
			return nil, 0, 0, perr
		}
		generatedPages = append(generatedPages, page)
		if item.candidate.kind == "entity" {
			entityCount++
		} else {
			conceptCount++
		}
	}
	if err := rebuildGeneratedKnowledgePageLinks(tx, userID, kbID); err != nil {
		return nil, 0, 0, err
	}

	builtSourceContent := renderBuiltSourcePage(article, documentSummary, items, relations, chunks)
	frontmatter := map[string]any{
		"generatedBy":              "article-knowledge-build",
		"buildVersion":             ArticleKnowledgeBuildVersion,
		"chunkAlgorithmVersion":    ChunkAlgorithmVersion,
		"articleId":                strconv.FormatInt(article.ID, 10),
		"sourceTitle":              article.Title,
		"sourceUpdatedAt":          iso(article.UpdatedAt),
		"sourceHash":               sha256Hex(article.Title + "\n" + article.ContentMd),
		"chunkCount":               len(chunks),
		"recommendedQuestionCount": len(chunks) * 3,
		"entityCount":              entityCount,
		"conceptCount":             conceptCount,
	}
	sourcePage, err := upsertWikiPage(tx, upsertWikiPageInput{
		UserID: userID, KnowledgeBaseID: kbID,
		PageKey: sourcePageKey, Title: article.Title, Kind: "source",
		ContentMd: builtSourceContent, Summary: &documentSummary,
		Frontmatter: frontmatter, HasFrontmatter: true,
		SourceRefs: []sourceRefInput{{ArticleID: article.ID, Note: strPtr("源文档")}},
		Now:        now,
	})
	if err != nil {
		return nil, 0, 0, err
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM petrichor_kb_wiki_link WHERE from_page_id = $1`, sourcePage.ID); err != nil {
		return nil, 0, 0, err
	}
	for _, page := range generatedPages {
		if _, err := tx.Exec(ctx,
			`INSERT INTO petrichor_kb_wiki_link (user_id, knowledge_base_id, from_page_id, to_page_key, link_type)
			 VALUES ($1,$2,$3,$4,'extracts')`, userID, kbID, sourcePage.ID, page.PageKey); err != nil {
			return nil, 0, 0, err
		}
	}
	indexPage, err := rebuildWikiIndex(tx, userID, kbID, kbName, time.Now())
	if err != nil {
		return nil, 0, 0, err
	}
	_ = indexPage
	if err := logWikiEvent(tx, userID, kbID, "ARTICLE_KNOWLEDGE_BUILD", &sourcePage.ID, nil, map[string]any{
		"articleId":    strconv.FormatInt(article.ID, 10),
		"chunkCount":   len(chunks),
		"entityCount":  entityCount,
		"conceptCount": conceptCount,
		"warnings":     warningsOrEmpty(warnings),
	}); err != nil {
		return nil, 0, 0, err
	}
	if err := tx.Commit(context.Background()); err != nil {
		return nil, 0, 0, err
	}
	return sourcePage, entityCount, conceptCount, nil
}

func queryWikiPagesWhere(q execQuerier, where string, args ...any) ([]WikiPageRow, error) {
	rows, err := q.Query(context.Background(),
		`SELECT `+wikiPageColumns+` FROM petrichor_kb_wiki_page WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []WikiPageRow
	for rows.Next() {
		r, serr := scanWikiPageRows(rows)
		if serr != nil {
			return nil, serr
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// deleteWikiPageByKey 物理删除单个页面及其派生数据；返回是否删除。
func deleteWikiPageByKey(q execQuerier, userID, knowledgeBaseID int64, pageKey string) (bool, error) {
	page, err := loadWikiPage(q, userID, knowledgeBaseID, pageKey)
	if err != nil {
		return false, err
	}
	if page == nil {
		return false, nil
	}
	ctx := context.Background()
	if _, err := q.Exec(ctx,
		`UPDATE petrichor_kb_wiki_event_log SET page_id = NULL WHERE page_id = $1`, page.ID); err != nil {
		return false, err
	}
	if _, err := q.Exec(ctx,
		`DELETE FROM petrichor_kb_wiki_link
		 WHERE user_id = $1 AND knowledge_base_id = $2 AND (from_page_id = $3 OR to_page_key = $4)`,
		userID, knowledgeBaseID, page.ID, page.PageKey); err != nil {
		return false, err
	}
	if _, err := q.Exec(ctx,
		`DELETE FROM petrichor_kb_wiki_source_ref WHERE page_id = $1`, page.ID); err != nil {
		return false, err
	}
	if _, err := q.Exec(ctx,
		`DELETE FROM petrichor_kb_wiki_tree_node WHERE page_id = $1`, page.ID); err != nil {
		return false, err
	}
	if _, err := q.Exec(ctx,
		`DELETE FROM petrichor_kb_wiki_page WHERE id = $1 AND user_id = $2 AND knowledge_base_id = $3`,
		page.ID, userID, knowledgeBaseID); err != nil {
		return false, err
	}
	return true, nil
}

// upsertExtractedKnowledgePage 实体/概念页聚合写入。
func upsertExtractedKnowledgePage(q execQuerier, userID, knowledgeBaseID int64, article *ArticleRow, item extractedItem) (*WikiPageRow, error) {
	existing, err := loadWikiPage(q, userID, knowledgeBaseID, item.candidate.pageKey)
	if err != nil {
		return nil, err
	}
	var previous map[string]any = map[string]any{}
	if existing != nil {
		previous = readKnowledgePageMetadata(existing.FrontmatterJson)
	}
	ownsExisting := optString(previous["generatedBy"]) == "article-knowledge-build"
	contributions := map[string]any{}
	if ownsExisting {
		if c, ok := previous["contributions"].(map[string]any); ok {
			contributions = c
		}
	}
	contributions[strconv.FormatInt(article.ID, 10)] = map[string]any{
		"articleId":       strconv.FormatInt(article.ID, 10),
		"articleTitle":    article.Title,
		"summary":         item.summary,
		"contentMd":       item.contentMd,
		"aliases":         item.candidate.aliases,
		"categoryPath":    item.candidate.categoryPath,
		"sourceChunkKeys": []string{},
		"relatedPageKeys": item.relatedPageKeys,
		"relations":       storedRelationsAny(item.relations),
	}
	prevBuildVersion := optNumber(previous["buildVersion"])
	prevCategoryPath := toStrSlice(previous["categoryPath"])
	categoryPath := prevCategoryPath
	if !(prevBuildVersion >= ArticleKnowledgeBuildVersion && len(prevCategoryPath) > 0) {
		if len(item.candidate.categoryPath) > 0 {
			categoryPath = item.candidate.categoryPath
		}
	}
	aliasSet := dedupeStrings(append(toStrSlice(previous["aliases"]), item.candidate.aliases...))
	if len(aliasSet) > 20 {
		aliasSet = aliasSet[:20]
	}
	baseContent := any(nil)
	baseSummary := any(nil)
	if ownsExisting {
		baseContent = previous["baseContentMd"]
		baseSummary = previous["baseSummary"]
	} else if existing != nil {
		if trimSpace(existing.ContentMd) != "" {
			baseContent = existing.ContentMd
		}
		if s := derefStr(existing.Summary); s != "" {
			baseSummary = s
		}
	}
	metadata := map[string]any{
		"generatedBy":   "article-knowledge-build",
		"buildVersion":  ArticleKnowledgeBuildVersion,
		"sourceHash":    nil,
		"chunkCount":    float64(0),
		"entityCount":   float64(0),
		"conceptCount":  float64(0),
		"categoryPath":  categoryPath,
		"aliases":       aliasSet,
		"baseContentMd": baseContent,
		"baseSummary":   baseSummary,
		"contributions": contributions,
	}
	contributionValues := mapValues(contributions)
	firstContributionSummary := ""
	for _, value := range contributionValues {
		entry, _ := value.(map[string]any)
		if entry != nil {
			firstContributionSummary = optString(entry["summary"])
			break
		}
	}
	summary := firstNonEmpty(item.summary, firstContributionSummary)
	refInputs := make([]sourceRefInput, 0, len(contributionValues))
	for _, key := range sortedKeys(contributions) {
		id, perr := strconv.ParseInt(key, 10, 64)
		if perr != nil {
			continue
		}
		note := "构建知识："
		if entry, ok := contributions[key].(map[string]any); ok {
			note += optString(entry["articleTitle"])
		}
		refInputs = append(refInputs, sourceRefInput{ArticleID: id, Note: &note})
	}
	page, err := upsertWikiPage(q, upsertWikiPageInput{
		UserID: userID, KnowledgeBaseID: knowledgeBaseID,
		PageKey: item.candidate.pageKey, Title: item.candidate.name, Kind: item.candidate.kind,
		ContentMd:   renderAggregatedKnowledgePage(item.candidate.name, metadata),
		Summary:     strPtr(summary),
		Frontmatter: metadata, HasFrontmatter: true,
		SourceRefs: refInputs,
		Now:        time.Now(),
	})
	if err != nil {
		return nil, err
	}
	if err := replaceGeneratedKnowledgePageLinks(q, page, metadata); err != nil {
		return nil, err
	}
	return page, nil
}

func storedRelationsAny(relations []knowledgeRelation) []any {
	out := make([]any, 0, len(relations))
	for _, r := range relations {
		out = append(out, map[string]any{
			"fromPageKey":  r.fromPageKey,
			"toPageKey":    r.toPageKey,
			"relationType": r.relationType,
			"description":  r.description,
		})
	}
	return out
}

func mapValues(m map[string]any) []any {
	out := make([]any, 0, len(m))
	for _, key := range sortedKeys(m) {
		out = append(out, m[key])
	}
	return out
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sortStrings(keys)
	return keys
}

// detachArticleFromGeneratedKnowledgePages 从实体/概念页的 contributions 中摘除文章；
// 无贡献且无底稿的页面直接删除。
func detachArticleFromGeneratedKnowledgePages(q execQuerier, userID, knowledgeBaseID, articleID int64) error {
	pages, err := queryWikiPagesWhere(q,
		`user_id = $1 AND knowledge_base_id = $2 AND kind IN ('entity','concept')`,
		userID, knowledgeBaseID)
	if err != nil {
		return err
	}
	articleKey := strconv.FormatInt(articleID, 10)
	for i := range pages {
		page := &pages[i]
		metadata := readKnowledgePageMetadata(page.FrontmatterJson)
		if optString(metadata["generatedBy"]) != "article-knowledge-build" {
			continue
		}
		contributions, _ := metadata["contributions"].(map[string]any)
		if _, has := contributions[articleKey]; !has {
			continue
		}
		delete(contributions, articleKey)
		metadata["contributions"] = contributions
		baseContent := optString(metadata["baseContentMd"])
		if len(contributions) == 0 && baseContent == "" {
			if _, derr := deleteWikiPageByKey(q, userID, knowledgeBaseID, page.PageKey); derr != nil {
				return derr
			}
			continue
		}
		remaining := mapValues(contributions)
		firstRemainingSummary := ""
		if len(remaining) > 0 {
			if entry, ok := remaining[0].(map[string]any); ok {
				firstRemainingSummary = optString(entry["summary"])
			}
		}
		summaryValue := firstNonEmpty(optString(metadata["baseSummary"]), firstRemainingSummary)
		refInputs := make([]sourceRefInput, 0, len(contributions))
		for _, key := range sortedKeys(contributions) {
			id, perr := strconv.ParseInt(key, 10, 64)
			if perr != nil {
				continue
			}
			title := "文章 " + key
			if entry, ok := contributions[key].(map[string]any); ok {
				if t := optString(entry["articleTitle"]); t != "" {
					title = t
				}
			}
			note := "构建知识：" + title
			refInputs = append(refInputs, sourceRefInput{ArticleID: id, Note: &note})
		}
		updatedPage, uerr := upsertWikiPage(q, upsertWikiPageInput{
			UserID: userID, KnowledgeBaseID: knowledgeBaseID,
			PageKey: page.PageKey, Title: page.Title, Kind: page.Kind,
			ContentMd:   renderAggregatedKnowledgePage(page.Title, metadata),
			Summary:     strPtr(summaryValue),
			Frontmatter: metadata, HasFrontmatter: true,
			SourceRefs: refInputs,
			Now:        time.Now(),
		})
		if uerr != nil {
			return uerr
		}
		if err := replaceGeneratedKnowledgePageLinks(q, updatedPage, metadata); err != nil {
			return err
		}
	}
	return nil
}

var titleStripFirst = regexp.MustCompile(`(?i)^#\s+[^\n]+\n+`)

func ensureWikiPageTitle(contentMd, title string) string {
	content := trimSpace(contentMd)
	hasTitle := regexp.MustCompile(`(?m)^#\s+`).MatchString(content)
	if hasTitle {
		return content
	}
	return "# " + title + "\n\n" + content
}

func stripLeadingWikiTitle(contentMd, title string) string {
	escaped := regexp.MustCompile(`([.*+?^${}()|[\]\\])`).ReplaceAllString(title, "\\$1")
	content := trimSpace(contentMd)
	first := regexp.MustCompile(`(?i)^#\s+` + escaped + `\s*\n+`)
	content = first.ReplaceAllString(content, "")
	content = titleStripFirst.ReplaceAllString(content, "")
	return trimSpace(content)
}

// renderAggregatedKnowledgePage 聚合多篇文章贡献为单页正文（段落去重）。
func renderAggregatedKnowledgePage(title string, metadata map[string]any) string {
	baseContent := optString(metadata["baseContentMd"])
	contributions, _ := metadata["contributions"].(map[string]any)
	bodies := []string{}
	if trimSpace(baseContent) != "" {
		bodies = append(bodies, baseContent)
	}
	for _, key := range sortedKeys(contributions) {
		entry, _ := contributions[key].(map[string]any)
		if entry == nil {
			continue
		}
		body := firstNonEmpty(optString(entry["contentMd"]), optString(entry["summary"]))
		if trimSpace(body) != "" {
			bodies = append(bodies, body)
		}
	}
	if len(bodies) == 0 {
		return "# " + title + "\n\n暂无文章构建结果。"
	}
	if len(bodies) == 1 && baseContent == "" {
		return ensureWikiPageTitle(bodies[0], title)
	}
	seen := map[string]struct{}{}
	blocks := []string{}
	spaceNorm := spaceRe
	for _, body := range bodies {
		withoutTitle := stripLeadingWikiTitle(body, title)
		for _, block := range regexp.MustCompile(`\n{2,}`).Split(withoutTitle, -1) {
			normalized := strings.ToLower(trimSpace(spaceNorm.ReplaceAllString(block, " ")))
			if normalized == "" {
				continue
			}
			if _, dup := seen[normalized]; dup {
				continue
			}
			seen[normalized] = struct{}{}
			blocks = append(blocks, trimSpace(block))
		}
	}
	all := append([]string{"# " + title, ""}, blocks...)
	return trimSpace(strings.Join(all, "\n\n"))
}

// replaceGeneratedKnowledgePageLinks 按 metadata.relations 重写页面出链。
func replaceGeneratedKnowledgePageLinks(q execQuerier, page *WikiPageRow, metadata map[string]any) error {
	if _, err := q.Exec(context.Background(),
		`DELETE FROM petrichor_kb_wiki_link WHERE from_page_id = $1`, page.ID); err != nil {
		return err
	}
	for _, relation := range collectKnowledgePageRelations(metadata) {
		if relation["fromPageKey"] != page.PageKey || relation["toPageKey"] == page.PageKey {
			continue
		}
		if _, err := q.Exec(context.Background(),
			`INSERT INTO petrichor_kb_wiki_link (user_id, knowledge_base_id, from_page_id, to_page_key, link_type)
			 VALUES ($1,$2,$3,$4,$5)`, page.UserID, page.KnowledgeBaseID, page.ID,
			relation["toPageKey"], relation["relationType"]); err != nil {
			return err
		}
	}
	return nil
}

// rebuildGeneratedKnowledgePageLinks 全量重编实体/概念页之间的关系链接。
func rebuildGeneratedKnowledgePageLinks(q execQuerier, userID, knowledgeBaseID int64) error {
	pages, err := queryWikiPagesWhere(q,
		`user_id = $1 AND knowledge_base_id = $2 AND kind IN ('entity','concept') AND archived_at IS NULL`,
		userID, knowledgeBaseID)
	if err != nil {
		return err
	}
	if len(pages) == 0 {
		return nil
	}
	pageIDs := make([]int64, 0, len(pages))
	activePageKeys := map[string]struct{}{}
	for i := range pages {
		pageIDs = append(pageIDs, pages[i].ID)
		activePageKeys[pages[i].PageKey] = struct{}{}
	}
	if _, err := q.Exec(context.Background(),
		`DELETE FROM petrichor_kb_wiki_link WHERE from_page_id = ANY($1)`, pageIDs); err != nil {
		return err
	}
	for i := range pages {
		page := &pages[i]
		for _, relation := range collectKnowledgePageRelations(readKnowledgePageMetadata(page.FrontmatterJson)) {
			if relation["fromPageKey"] != page.PageKey || relation["toPageKey"] == page.PageKey {
				continue
			}
			if _, active := activePageKeys[relation["toPageKey"]]; !active {
				continue
			}
			if _, err := q.Exec(context.Background(),
				`INSERT INTO petrichor_kb_wiki_link (user_id, knowledge_base_id, from_page_id, to_page_key, link_type)
				 VALUES ($1,$2,$3,$4,$5)`, userID, knowledgeBaseID, page.ID,
				relation["toPageKey"], relation["relationType"]); err != nil {
				return err
			}
		}
	}
	return nil
}

// renderBuiltSourcePage 渲染构建完成的 source 页面。
func renderBuiltSourcePage(article *ArticleRow, documentSummary string, items []extractedItem,
	relations []knowledgeRelation, chunks []chunkWithQuestions) string {
	var b strings.Builder
	b.WriteString("# " + article.Title + "\n\n")
	b.WriteString("## 文档摘要\n")
	b.WriteString(firstNonEmpty(documentSummary, "暂无摘要。") + "\n\n")

	b.WriteString("## 实体\n")
	entityLines := []string{}
	for _, item := range items {
		if item.candidate.kind == "entity" {
			entityLines = append(entityLines,
				"- [["+item.candidate.pageKey+"|"+item.candidate.name+"]]："+item.summary)
		}
	}
	if len(entityLines) == 0 {
		b.WriteString("- 未抽取到实体\n")
	} else {
		b.WriteString(strings.Join(entityLines, "\n") + "\n")
	}
	b.WriteString("\n## 概念\n")
	conceptLines := []string{}
	for _, item := range items {
		if item.candidate.kind == "concept" {
			conceptLines = append(conceptLines,
				"- [["+item.candidate.pageKey+"|"+item.candidate.name+"]]："+item.summary)
		}
	}
	if len(conceptLines) == 0 {
		b.WriteString("- 未抽取到概念\n")
	} else {
		b.WriteString(strings.Join(conceptLines, "\n") + "\n")
	}

	b.WriteString("\n## 知识关系\n")
	if len(relations) == 0 {
		b.WriteString("- 未抽取到有明确原文依据的关系\n")
	} else {
		for _, relation := range relations {
			line := "- [[" + relation.fromPageKey + "|" + relation.fromPageKey + "]] " + relation.relationType +
				" [[" + relation.toPageKey + "|" + relation.toPageKey + "]]"
			if relation.description != "" {
				line += "：" + relation.description
			}
			b.WriteString(line + "\n")
		}
	}

	b.WriteString("\n## 切片推荐问题\n")
	for _, cq := range chunks {
		b.WriteString("### " + cq.chunk.heading + "\n")
		for _, question := range cq.recommendedQuestions {
			b.WriteString("- " + question + "\n")
		}
		b.WriteString("\n")
	}
	b.WriteString("## 来源\n")
	b.WriteString("- 源文档 ID：" + strconv.FormatInt(article.ID, 10) + "\n")
	b.WriteString("- 最近更新：" + iso(article.UpdatedAt) + "\n")
	return b.String()
}
