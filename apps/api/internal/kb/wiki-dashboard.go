// wiki-dashboard.go 知识库 Wiki 的只读视图端点：面板聚合、目录树轮廓、结构体检，
// 以及索引页重建与文章级页面清理这两条共享写路径。
// 补丁审批在 wiki-patch.go，问答辅助端点在 wiki-qa.go。
package kb

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"
)

// WikiDashboard 面板聚合。
func WikiDashboard(c *ginContext) {
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
		q := pool()
		if _, err := assertKnowledgeBaseOwner(c.Request.Context(), q, user.ID, kbID); err != nil {
			return nil, err
		}
		pages, err := loadWikiPageRows(c.Request.Context(), q, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		lint, err := buildWikiLint(c.Request.Context(), q, user.ID, kbID, pages)
		if err != nil {
			return nil, err
		}
		var treeNodeCount int64
		if err := q.QueryRow(c.Request.Context(),
			`SELECT COUNT(*) FROM petrichor_kb_wiki_tree_node WHERE user_id = $1 AND knowledge_base_id = $2`,
			user.ID, kbID).Scan(&treeNodeCount); err != nil {
			return nil, err
		}
		var chunkCount int64
		if err := q.QueryRow(c.Request.Context(),
			`SELECT COUNT(*) FROM petrichor_kb_article_chunk WHERE user_id = $1 AND knowledge_base_id = $2`,
			user.ID, kbID).Scan(&chunkCount); err != nil {
			return nil, err
		}
		embedding, err := getArticleIndexStatus(c.Request.Context(), q, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		pageMaps := make([]map[string]any, 0, len(pages))
		for i := range pages {
			pageMaps = append(pageMaps, toWikiPageResponse(&pages[i]))
		}
		return map[string]any{
			"pages":         pageMaps,
			"lint":          lint,
			"treeNodeCount": treeNodeCount,
			"chunkCount":    chunkCount,
			"embedding":     embedding,
		}, nil
	})
}

// WikiTree 文档目录树轮廓（对应 wiki-tree.ts loadDocumentTreeOutline）。
func WikiTree(c *ginContext) {
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
		articleFilter := parseOptionalID(raw, "articleId")
		q := pool()
		if _, err := assertKnowledgeBaseOwner(c.Request.Context(), q, user.ID, kbID); err != nil {
			return nil, err
		}
		nodes, err := loadTreeNodesContext(c.Request.Context(), q, user.ID, kbID, articleFilter)
		if err != nil {
			return nil, err
		}
		nodeMaps := make([]map[string]any, 0, len(nodes))
		for i := range nodes {
			n := &nodes[i]
			nodeMaps = append(nodeMaps, map[string]any{
				"nodeKey":       n.NodeKey,
				"articleId":     strconv.FormatInt(n.ArticleID, 10),
				"parentKey":     n.ParentKey,
				"depth":         n.Depth,
				"title":         n.Title,
				"summary":       n.Summary,
				"tokenEstimate": n.TokenEstimate,
			})
		}
		var articleOut any
		if articleFilter != nil {
			articleOut = strconv.FormatInt(*articleFilter, 10)
		}
		return map[string]any{
			"knowledgeBaseId": strconv.FormatInt(kbID, 10),
			"articleId":       articleOut,
			"nodes":           nodeMaps,
		}, nil
	})
}

func loadTreeNodesContext(ctx context.Context, q execQuerier, userID, knowledgeBaseID int64, articleID *int64) ([]TreeNodeRow, error) {
	sql := `SELECT ` + treeNodeColumns + ` FROM petrichor_kb_wiki_tree_node
		 WHERE user_id = $1 AND knowledge_base_id = $2`
	args := []any{userID, knowledgeBaseID}
	if articleID != nil {
		sql += ` AND article_id = $3`
		args = append(args, *articleID)
	}
	sql += ` ORDER BY article_id ASC, position ASC`
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TreeNodeRow
	for rows.Next() {
		var r TreeNodeRow
		if err := rows.Scan(&r.ID, &r.UserID, &r.KnowledgeBaseID, &r.PageID, &r.ArticleID,
			&r.NodeKey, &r.ParentKey, &r.Depth, &r.Position, &r.Title, &r.Summary, &r.ContentMd,
			&r.StartLine, &r.EndLine, &r.TokenEstimate, &r.ContentHash,
			&r.EmbeddingStatus, &r.EmbeddingModel, &r.EmbeddingDimensions, &r.EmbeddingVersion,
			&r.EmbeddingError, &r.EmbeddingUpdatedAt, &r.SearchTitleTokens, &r.SearchSummaryTokens,
			&r.SearchContentTokens, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// RunWikiLint 结构体检。偏差说明：TS 版 runWikiLint 同样是纯结构分析、无 LLM 调用，直接完整实现。
func RunWikiLint(c *ginContext) {
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
		q := pool()
		if _, err := assertKnowledgeBaseOwner(c.Request.Context(), q, user.ID, kbID); err != nil {
			return nil, err
		}
		pages, err := loadWikiPageRows(c.Request.Context(), q, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		return buildWikiLint(c.Request.Context(), q, user.ID, kbID, pages)
	})
}

// lintIssue 用 map 组装以保持字段顺序无关的 JSON 形状。
func buildWikiLint(ctx context.Context, q execQuerier, userID, knowledgeBaseID int64, pages []WikiPageRow) (map[string]any, error) {
	var links []WikiLinkRow
	var refs []SourceRefRow
	pageIDs := make([]int64, 0, len(pages))
	for i := range pages {
		pageIDs = append(pageIDs, pages[i].ID)
	}
	if len(pages) > 0 {
		var err error
		links, err = queryLinks(ctx, q,
			`SELECT `+wikiLinkColumns+` FROM petrichor_kb_wiki_link
			 WHERE user_id = $1 AND knowledge_base_id = $2`, userID, knowledgeBaseID)
		if err != nil {
			return nil, err
		}
		refs, err = querySourceRefs(ctx, q,
			`SELECT `+sourceRefColumns+` FROM petrichor_kb_wiki_source_ref WHERE page_id = ANY($1)`, pageIDs)
		if err != nil {
			return nil, err
		}
	}
	pageKeys := map[string]struct{}{}
	for i := range pages {
		pageKeys[pages[i].PageKey] = struct{}{}
	}
	refByPage := map[int64]struct{}{}
	refsByPage := map[int64][]SourceRefRow{}
	articleIDs := map[int64]struct{}{}
	for i := range refs {
		refByPage[refs[i].PageID] = struct{}{}
		refsByPage[refs[i].PageID] = append(refsByPage[refs[i].PageID], refs[i])
		articleIDs[refs[i].ArticleID] = struct{}{}
	}
	articles, err := loadArticlesByIDs(ctx, q, userID, articleIDs)
	if err != nil {
		return nil, err
	}
	freshness := evaluateWikiFreshness(pages, refsByPage, articles)
	linkedFrom := map[string]int{}
	for i := range links {
		linkedFrom[links[i].ToPageKey]++
	}

	issues := []map[string]string{}
	errorCount, warningCount := 0, 0
	hasRef := func(id int64) bool { _, ok := refByPage[id]; return ok }
	for i := range pages {
		page := &pages[i]
		// index 是自动生成的目录，meta 是用户手写的编译说明书，都不需要来源引用。
		if page.Kind != "index" && page.Kind != wikiGuideKind && !hasRef(page.ID) {
			issues = append(issues, map[string]string{
				"severity": "warning", "code": "missing_source",
				"pageKey": page.PageKey, "title": page.Title, "message": "页面缺少来源引用",
			})
			warningCount++
		}
	}
	for i := range links {
		link := &links[i]
		if _, ok := pageKeys[link.ToPageKey]; !ok {
			issues = append(issues, map[string]string{
				"severity": "error", "code": "broken_link",
				"pageKey": link.ToPageKey, "title": link.ToPageKey, "message": "链接指向不存在的 Wiki 页面",
			})
			errorCount++
		}
	}
	// 新鲜度问题按页面顺序稳定输出，紧跟结构性问题之后。
	for i := range pages {
		page := &pages[i]
		for _, reason := range freshness.ReasonsByPage[page.ID] {
			severity := "warning"
			if reason.Code == wikiIssueOutdatedBuil {
				severity = "info"
			}
			issues = append(issues, map[string]string{
				"severity": severity, "code": reason.Code,
				"pageKey": page.PageKey, "title": page.Title, "message": reason.Message,
			})
			if severity == "warning" {
				warningCount++
			}
		}
	}

	orphanShown := 0
	for i := range pages {
		if orphanShown >= 20 {
			break
		}
		page := &pages[i]
		if page.Kind != "index" && page.Kind != wikiGuideKind && linkedFrom[page.PageKey] == 0 {
			issues = append(issues, map[string]string{
				"severity": "info", "code": "orphan_page",
				"pageKey": page.PageKey, "title": page.Title, "message": "页面暂时没有被其他页面引用",
			})
			orphanShown++
		}
	}

	score := 100 - errorCount*25 - warningCount*8
	if score < 0 {
		score = 0
	}
	issueJSON, _ := json.Marshal(issues)
	var decoded []map[string]any
	_ = json.Unmarshal(issueJSON, &decoded)
	if decoded == nil {
		decoded = []map[string]any{}
	}
	return map[string]any{
		"score":          score,
		"pageCount":      len(pages),
		"linkCount":      len(links),
		"sourceRefCount": len(refs),
		"stalePageCount": freshness.StalePageCount,
		"issueCount":     len(decoded),
		"issues":         decoded,
		"checkedAt":      iso(time.Now()),
	}, nil
}

// ===== 共享写路径 =====

// rebuildWikiIndex 重编 index 页面与 index → 全部页面的链接。
func rebuildWikiIndex(ctx context.Context, q execQuerier, userID, knowledgeBaseID int64, knowledgeBaseName string, now time.Time) (*WikiPageRow, error) {
	pages, err := loadWikiPageRows(ctx, q, userID, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	var sourcePages, conceptPages []WikiPageRow
	for i := range pages {
		switch {
		case pages[i].Kind == "source":
			sourcePages = append(sourcePages, pages[i])
		// meta 是编译配置不是知识内容，不进索引清单。
		case pages[i].Kind != "index" && pages[i].Kind != wikiGuideKind:
			conceptPages = append(conceptPages, pages[i])
		}
	}
	var b strings.Builder
	b.WriteString("# " + knowledgeBaseName + " Wiki 索引\n\n")
	b.WriteString("这个页面是文档问答 Agent 的入口。回答问题时应先读取本索引，再按需读取具体 Wiki 页面；只有 Wiki 信息不足时才回看源文档。\n\n")
	b.WriteString("## 源文档页面\n")
	for i := range sourcePages {
		b.WriteString("- [[" + sourcePages[i].PageKey + "]] " + sourcePages[i].Title + "：" +
			derefOrSummarize(sourcePages[i].Summary, sourcePages[i].ContentMd, 120) + "\n")
	}
	b.WriteString("\n## 主题与答案页面\n")
	if len(conceptPages) == 0 {
		b.WriteString("- 暂无沉淀页面\n")
	} else {
		for i := range conceptPages {
			b.WriteString("- [[" + conceptPages[i].PageKey + "]] " + conceptPages[i].Title + "：" +
				derefOrSummarize(conceptPages[i].Summary, conceptPages[i].ContentMd, 120) + "\n")
		}
	}
	b.WriteString("\n## 维护规则\n")
	b.WriteString("- 原始文档是真源，不要静默改写。\n")
	b.WriteString("- Wiki 页面可以通过补丁审批更新。\n")
	b.WriteString("- 回答必须说明依据来自哪些 Wiki 页面或源文档。\n")

	summary := "收录 " + strconv.Itoa(len(sourcePages)) + " 个源文档页面，" +
		strconv.Itoa(len(conceptPages)) + " 个主题/答案页面。"
	indexPage, err := upsertWikiPage(ctx, q, upsertWikiPageInput{
		UserID: userID, KnowledgeBaseID: knowledgeBaseID,
		PageKey: "index", Title: knowledgeBaseName + " Wiki 索引", Kind: "index",
		ContentMd: b.String(), Summary: &summary,
		Frontmatter: map[string]any{
			"sourcePageCount":  len(sourcePages),
			"conceptPageCount": len(conceptPages),
		},
		HasFrontmatter: true,
		SourceRefs:     nil,
		Now:            now,
	})
	if err != nil {
		return nil, err
	}
	indexLinks := make([]wikiLinkInput, 0, len(pages))
	for i := range pages {
		if pages[i].PageKey == "index" {
			continue
		}
		indexLinks = append(indexLinks, wikiLinkInput{ToPageKey: pages[i].PageKey, LinkType: "index"})
	}
	if err := replaceWikiPageLinks(ctx, q, indexPage, indexLinks); err != nil {
		return nil, err
	}
	return indexPage, nil
}

func derefOrSummarize(summary *string, contentMd string, maxLen int) string {
	if s := trimSpace(derefStr(summary)); s != "" {
		return s
	}
	return summarizePlainText(contentMd, maxLen)
}

// deleteArticleWikiPages 对照 wiki-agent-logic.ts 同名函数：
// 删除 source-<articleId> 页面及其派生数据；rebuildIndex 时重编索引；
// 待审批补丁改为 REJECTED。返回删除的页面数。
func deleteArticleWikiPages(ctx context.Context, q execQuerier, userID int64, articles []ArticleRow, rebuildIndex bool) (int, error) {
	targetsByKB := map[int64][]int64{}
	for i := range articles {
		targetsByKB[articles[i].KnowledgeBaseID] = append(targetsByKB[articles[i].KnowledgeBaseID], articles[i].ID)
	}
	deletedTotal := 0
	for knowledgeBaseID, rawIDs := range targetsByKB {
		unique := uniqueInt64(rawIDs)
		pageKeys := make([]string, 0, len(unique))
		for _, id := range unique {
			pageKeys = append(pageKeys, buildArticleWikiSourcePageKey(id))
		}
		rows, err := q.Query(ctx,
			`SELECT id FROM petrichor_kb_wiki_page
			 WHERE user_id = $1 AND knowledge_base_id = $2 AND kind = 'source' AND page_key = ANY($3)`,
			userID, knowledgeBaseID, pageKeys)
		if err != nil {
			return deletedTotal, err
		}
		var pageIDs []int64
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return deletedTotal, err
			}
			pageIDs = append(pageIDs, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return deletedTotal, err
		}
		if len(pageIDs) == 0 {
			continue
		}
		refs := make([]wikiPageRef, 0, len(pageIDs))
		for i, id := range pageIDs {
			ref := wikiPageRef{ID: id}
			if i < len(pageKeys) {
				ref.PageKey = pageKeys[i]
			}
			refs = append(refs, ref)
		}
		deleted, err := deleteWikiPagesCascade(ctx, q, userID, knowledgeBaseID, refs)
		if err != nil {
			return deletedTotal, err
		}
		deletedTotal += deleted

		if rebuildIndex {
			nameRows, err := q.Query(ctx,
				`SELECT name FROM petrichor_kb_knowledge_base WHERE id = $1 AND user_id = $2 LIMIT 1`,
				knowledgeBaseID, userID)
			if err != nil {
				return deletedTotal, err
			}
			kbName := ""
			found := false
			for nameRows.Next() {
				if err := nameRows.Scan(&kbName); err != nil {
					nameRows.Close()
					return deletedTotal, err
				}
				found = true
			}
			nameRows.Close()
			if found {
				if _, err := rebuildWikiIndex(ctx, q, userID, knowledgeBaseID, kbName, time.Now()); err != nil {
					return deletedTotal, err
				}
			}
		}
	}
	return deletedTotal, nil
}

func uniqueInt64(ids []int64) []int64 {
	seen := map[int64]struct{}{}
	out := make([]int64, 0, len(ids))
	for _, id := range ids {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
