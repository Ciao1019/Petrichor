// wiki2.go 对照 wiki-agent-handlers.ts 的 dashboard/tree/lint/patch/qa 端点，
// 以及 upsertWikiPage / rebuildWikiIndex / 事件日志 / deleteArticleWikiPages 共享设施。
package kb

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
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
		if _, err := assertKnowledgeBaseOwner(q, user.ID, kbID); err != nil {
			return nil, err
		}
		pages, err := loadWikiPageRows(q, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		lint, err := buildWikiLint(q, user.ID, kbID, pages)
		if err != nil {
			return nil, err
		}
		var treeNodeCount int64
		if err := q.QueryRow(c,
			`SELECT COUNT(*) FROM petrichor_kb_wiki_tree_node WHERE user_id = $1 AND knowledge_base_id = $2`,
			user.ID, kbID).Scan(&treeNodeCount); err != nil {
			return nil, err
		}
		var chunkCount int64
		if err := q.QueryRow(c,
			`SELECT COUNT(*) FROM petrichor_kb_article_chunk WHERE user_id = $1 AND knowledge_base_id = $2`,
			user.ID, kbID).Scan(&chunkCount); err != nil {
			return nil, err
		}
		embedding, err := getArticleIndexStatus(q, user.ID, kbID)
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
		if _, err := assertKnowledgeBaseOwner(q, user.ID, kbID); err != nil {
			return nil, err
		}
		nodes, err := loadTreeNodes(q, user.ID, kbID, articleFilter)
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

func loadTreeNodes(q execQuerier, userID, knowledgeBaseID int64, articleID *int64) ([]TreeNodeRow, error) {
	sql := `SELECT ` + treeNodeColumns + ` FROM petrichor_kb_wiki_tree_node
		 WHERE user_id = $1 AND knowledge_base_id = $2`
	args := []any{userID, knowledgeBaseID}
	if articleID != nil {
		sql += ` AND article_id = $3`
		args = append(args, *articleID)
	}
	sql += ` ORDER BY article_id ASC, position ASC`
	rows, err := q.Query(context.Background(), sql, args...)
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
		if _, err := assertKnowledgeBaseOwner(q, user.ID, kbID); err != nil {
			return nil, err
		}
		pages, err := loadWikiPageRows(q, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		return buildWikiLint(q, user.ID, kbID, pages)
	})
}

// lintIssue 用 map 组装以保持字段顺序无关的 JSON 形状。
func buildWikiLint(q execQuerier, userID, knowledgeBaseID int64, pages []WikiPageRow) (map[string]any, error) {
	var links []WikiLinkRow
	var refs []SourceRefRow
	pageIDs := make([]int64, 0, len(pages))
	for i := range pages {
		pageIDs = append(pageIDs, pages[i].ID)
	}
	if len(pages) > 0 {
		var err error
		links, err = queryLinks(q,
			`SELECT `+wikiLinkColumns+` FROM petrichor_kb_wiki_link
			 WHERE user_id = $1 AND knowledge_base_id = $2`, userID, knowledgeBaseID)
		if err != nil {
			return nil, err
		}
		refs, err = querySourceRefs(q,
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
	for i := range refs {
		refByPage[refs[i].PageID] = struct{}{}
	}
	linkedFrom := map[string]int{}
	for i := range links {
		linkedFrom[links[i].ToPageKey]++
	}

	issues := []map[string]string{}
	errorCount, warningCount := 0, 0
	hasRef := func(id int64) bool { _, ok := refByPage[id]; return ok }
	for i := range pages {
		page := &pages[i]
		if page.Kind != "index" && !hasRef(page.ID) {
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
	orphanShown := 0
	for i := range pages {
		if orphanShown >= 20 {
			break
		}
		page := &pages[i]
		if page.Kind != "index" && linkedFrom[page.PageKey] == 0 {
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
		"issueCount":     len(decoded),
		"issues":         decoded,
		"checkedAt":      iso(time.Now()),
	}, nil
}

// ===== 补丁 =====

// WikiPatchList 待处理补丁清单（updated_at 倒序，最多 100 条）。
func WikiPatchList(c *ginContext) {
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
		if _, err := assertKnowledgeBaseOwner(q, user.ID, kbID); err != nil {
			return nil, err
		}
		rows, err := q.Query(c,
			`SELECT `+wikiPatchColumns+` FROM petrichor_kb_wiki_patch
			 WHERE user_id = $1 AND knowledge_base_id = $2
			 ORDER BY updated_at DESC LIMIT 100`, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		patches := []map[string]any{}
		for rows.Next() {
			var r WikiPatchRow
			if err := rows.Scan(&r.ID, &r.UserID, &r.KnowledgeBaseID, &r.ThreadID, &r.RunID,
				&r.PageKey, &r.Title, &r.Operation, &r.Status, &r.BeforeContentMd,
				&r.ProposedContentMd, &r.DiffText, &r.Reason, &r.AppliedAt,
				&r.CreatedAt, &r.UpdatedAt); err != nil {
				return nil, err
			}
			patches = append(patches, toWikiPatchResponse(&r))
		}
		return map[string]any{
			"knowledgeBaseId": strconv.FormatInt(kbID, 10),
			"patches":         patches,
		}, nil
	})
}

// loadPatch 加载归属补丁，404 语义与 TS 一致。
func loadPatch(q execQuerier, userID, knowledgeBaseID, patchID int64) (*WikiPatchRow, error) {
	rows, err := q.Query(context.Background(),
		`SELECT `+wikiPatchColumns+` FROM petrichor_kb_wiki_patch
		 WHERE id = $1 AND user_id = $2 AND knowledge_base_id = $3 LIMIT 1`,
		patchID, userID, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, notFoundErr("Wiki 补丁不存在")
	}
	var r WikiPatchRow
	if err := rows.Scan(&r.ID, &r.UserID, &r.KnowledgeBaseID, &r.ThreadID, &r.RunID,
		&r.PageKey, &r.Title, &r.Operation, &r.Status, &r.BeforeContentMd,
		&r.ProposedContentMd, &r.DiffText, &r.Reason, &r.AppliedAt,
		&r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	return &r, nil
}

// WikiPatchApply 审批通过：落地页面 + 标记 APPLIED + 重建索引 + 事件日志。
// 偏差说明：TS 版 applyWikiPatch 为纯 DB 操作（无 LLM 调用），故按真实逻辑实现而非注入桩。
func WikiPatchApply(c *ginContext) {
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
		patchID, err := reqID(raw["patchId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		q := pool()
		kb, err := assertKnowledgeBaseOwner(q, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		patch, err := loadPatch(q, user.ID, kbID, patchID)
		if err != nil {
			return nil, err
		}
		if patch.Status != "PENDING" {
			return nil, badReq("只能处理待审批补丁")
		}

		kind := "concept"
		if patch.Operation == "CREATE" {
			kind = "answer"
		}
		now := time.Now()
		ctx := context.Background()
		tx, err := q.Begin(ctx)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback(context.Background())

		page, err := upsertWikiPage(tx, upsertWikiPageInput{
			UserID: user.ID, KnowledgeBaseID: kbID,
			PageKey: patch.PageKey, Title: patch.Title, Kind: kind,
			ContentMd: patch.ProposedContentMd,
			Summary:   strPtr(summarizePlainText(patch.ProposedContentMd, 180)),
			Frontmatter: map[string]any{
				"patchId": strconv.FormatInt(patch.ID, 10),
				"reason":  optString(patchReason(patch)),
			},
			SourceRefs: nil,
			Now:        now,
		})
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE petrichor_kb_wiki_patch SET status = 'APPLIED', applied_at = $1, updated_at = $1
			 WHERE id = $2 AND user_id = $3`, now, patch.ID, user.ID); err != nil {
			return nil, err
		}
		indexPage, err := rebuildWikiIndex(tx, user.ID, kbID, kb.Name, now)
		if err != nil {
			return nil, err
		}
		_ = indexPage
		if err := logWikiEvent(tx, user.ID, kbID, "PATCH_APPLIED", &page.ID, patch.ThreadID, map[string]any{
			"patchId": strconv.FormatInt(patch.ID, 10),
			"pageKey": patch.PageKey,
		}); err != nil {
			return nil, err
		}
		if err := tx.Commit(context.Background()); err != nil {
			return nil, err
		}

		updated, err := loadPatch(q, user.ID, kbID, patchID)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"patch": toWikiPatchResponse(updated),
			"page":  toWikiPageResponse(page),
		}, nil
	})
}

func patchReason(p *WikiPatchRow) *string { return p.Reason }

func strPtr(s string) *string { return &s }

// WikiPatchReject 驳回补丁。
func WikiPatchReject(c *ginContext) {
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
		patchID, err := reqID(raw["patchId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		q := pool()
		if _, err := assertKnowledgeBaseOwner(q, user.ID, kbID); err != nil {
			return nil, err
		}
		patch, err := loadPatch(q, user.ID, kbID, patchID)
		if err != nil {
			return nil, err
		}
		if patch.Status != "PENDING" {
			return nil, badReq("只能处理待审批补丁")
		}
		now := time.Now()
		if _, err := q.Exec(c,
			`UPDATE petrichor_kb_wiki_patch SET status = 'REJECTED', updated_at = $1 WHERE id = $2 AND user_id = $3`,
			now, patch.ID, user.ID); err != nil {
			return nil, err
		}
		if err := logWikiEvent(q, user.ID, kbID, "PATCH_REJECTED", nil, patch.ThreadID, map[string]any{
			"patchId": strconv.FormatInt(patch.ID, 10),
			"pageKey": patch.PageKey,
		}); err != nil {
			return nil, err
		}
		updated, err := loadPatch(q, user.ID, kbID, patchID)
		if err != nil {
			return nil, err
		}
		return toWikiPatchResponse(updated), nil
	})
}

// ===== QA 辅助端点 =====

// QAKnowledgeBaseList 用户全部知识库（按名称排序）。
func QAKnowledgeBaseList(c *ginContext) {
	run(c, func(c *ginContext) (any, error) {
		user := currentUser(c)
		rows, err := pool().Query(c,
			`SELECT id, name, description FROM petrichor_kb_knowledge_base
			 WHERE user_id = $1 ORDER BY name ASC`, user.ID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		items := []map[string]any{}
		for rows.Next() {
			var id int64
			var name string
			var description *string
			if err := rows.Scan(&id, &name, &description); err != nil {
				return nil, err
			}
			items = append(items, map[string]any{
				"id":          strconv.FormatInt(id, 10),
				"name":        name,
				"description": description,
			})
		}
		return map[string]any{"knowledgeBases": items}, nil
	})
}

// ===== qa/model-info：语言模型清单 + CHAT 绑定 =====

type availableModel struct {
	configID      string
	modelID       string
	modelName     string
	contextWindow int64
	isDefault     bool
}

// guessContextWindow 对应 provider-catalog.ts 的同名函数。
func guessContextWindow(modelID string) int64 {
	m := strings.ToLower(modelID)
	switch {
	case strings.Contains(m, "claude"):
		return 200_000
	case strings.Contains(m, "gemini-2") || strings.Contains(m, "gemini-1.5-pro"):
		return 2_000_000
	case strings.Contains(m, "gemini"):
		return 1_000_000
	case strings.Contains(m, "deepseek-v4") || strings.Contains(m, "deepseek-chat") || strings.Contains(m, "deepseek-reasoner"):
		return 1_000_000
	case strings.Contains(m, "deepseek-r1") || strings.Contains(m, "deepseek-v3"):
		return 64_000
	case strings.Contains(m, "deepseek"):
		return 128_000
	case strings.Contains(m, "qwen3.6") || strings.Contains(m, "qwen-3.6"):
		return 1_000_000
	case strings.Contains(m, "qwen"):
		return 128_000
	case strings.Contains(m, "glm-5"):
		return 200_000
	case strings.Contains(m, "glm-4"):
		return 128_000
	case strings.Contains(m, "kimi") || strings.Contains(m, "moonshot"):
		return 128_000
	case strings.Contains(m, "grok"):
		return 256_000
	case strings.Contains(m, "gpt-5") || strings.Contains(m, "gpt-4.1"):
		return 400_000
	case strings.Contains(m, "gpt-4o"), strings.Contains(m, "gpt-4-turbo"),
		strings.HasPrefix(m, "o1"), strings.HasPrefix(m, "o3"):
		return 128_000
	case strings.Contains(m, "gpt-3.5"):
		return 16_385
	default:
		return 128_000
	}
}

// QAModelInfo 可选语言模型 + 当前默认（对应 wiki-agent-handlers.ts qaModelInfo）。
func QAModelInfo(c *ginContext) {
	run(c, func(c *ginContext) (any, error) {
		user := currentUser(c)
		q := pool()
		rows, err := q.Query(c,
			`SELECT m.id, m.model_id, m.display_name, m.context_window
			 FROM petrichor_ai_model m JOIN petrichor_ai_provider p ON p.id = m.provider_id
			 WHERE m.user_id = $1 AND m.kind = 'LANGUAGE' AND m.enabled = true AND p.enabled = true
			 ORDER BY p.name ASC, m.model_id ASC`, user.ID)
		if err != nil {
			return nil, err
		}
		var models []*availableModel
		for rows.Next() {
			var id int64
			var modelID string
			var displayName *string
			var contextWindow *int32
			if err := rows.Scan(&id, &modelID, &displayName, &contextWindow); err != nil {
				rows.Close()
				return nil, err
			}
			window := guessContextWindow(modelID)
			if contextWindow != nil && *contextWindow > 0 {
				window = int64(*contextWindow)
			}
			name := ""
			if displayName != nil && *displayName != "" {
				name = *displayName
			} else {
				name = modelID
			}
			models = append(models, &availableModel{
				configID:      strconv.FormatInt(id, 10),
				modelID:       modelID,
				modelName:     name,
				contextWindow: window,
			})
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if models == nil {
			models = []*availableModel{}
		}

		var bindingModelRefID *int64
		var refID int64
		err = q.QueryRow(c,
			`SELECT model_ref_id FROM petrichor_ai_binding WHERE user_id = $1 AND purpose = 'CHAT' LIMIT 1`,
			user.ID).Scan(&refID)
		if err == nil {
			bindingModelRefID = &refID
		} else if err.Error() != "no rows in result set" && !strings.Contains(err.Error(), "no rows") {
			// pgx ErrNoRows 判定放行
			if !isNoRows(err) {
				return nil, err
			}
		}

		var current *availableModel
		if bindingModelRefID != nil {
			refStr := strconv.FormatInt(*bindingModelRefID, 10)
			for _, m := range models {
				if m.configID == refStr {
					current = m
					break
				}
			}
		}
		fallback := current
		if fallback == nil && len(models) > 0 {
			fallback = models[0]
		}
		if fallback == nil {
			return map[string]any{
				"modelId": nil, "modelName": nil, "contextWindow": nil,
				"configId": nil, "availableModels": []map[string]any{},
			}, nil
		}
		list := make([]map[string]any, 0, len(models))
		for _, m := range models {
			list = append(list, map[string]any{
				"configId":      m.configID,
				"modelId":       m.modelID,
				"modelName":     m.modelName,
				"contextWindow": m.contextWindow,
				"isDefault":     m.configID == fallback.configID,
			})
		}
		return map[string]any{
			"configId":        fallback.configID,
			"modelId":         fallback.modelID,
			"modelName":       fallback.modelName,
			"contextWindow":   fallback.contextWindow,
			"availableModels": list,
		}, nil
	})
}

func isNoRows(err error) bool { return err == pgx.ErrNoRows }

// ===== 共享写路径 =====

type upsertWikiPageInput struct {
	UserID          int64
	KnowledgeBaseID int64
	PageKey         string
	Title           string
	Kind            string
	ContentMd       string
	Summary         *string
	Frontmatter     any // nil 表示 frontmatter_json 置 NULL
	HasFrontmatter  bool
	SourceRefs      []sourceRefInput
	Now             time.Time
}

type sourceRefInput struct {
	ArticleID int64
	Anchor    *string
	Note      *string
}

// upsertWikiPage 创建或递增版本更新页面，并整体替换来源引用。
func upsertWikiPage(q execQuerier, in upsertWikiPageInput) (*WikiPageRow, error) {
	ctx := context.Background()
	normalizedPageKey := normalizePageKey(in.PageKey)
	contentHash := sha256Hex(in.ContentMd)
	existing, err := loadWikiPage(q, in.UserID, in.KnowledgeBaseID, normalizedPageKey)
	if err != nil {
		return nil, err
	}
	var frontmatterJSON *string
	if in.HasFrontmatter && in.Frontmatter != nil {
		frontmatterJSON = marshalJSON(in.Frontmatter)
	}
	var page *WikiPageRow
	if existing != nil {
		rows, uerr := q.Query(ctx,
			`UPDATE petrichor_kb_wiki_page SET title = $1, kind = $2, content_md = $3, summary = $4,
			 frontmatter_json = $5, content_hash = $6, archived_at = NULL, updated_at = $7, version = $8
			 WHERE id = $9 AND user_id = $10 RETURNING `+wikiPageColumns,
			in.Title, in.Kind, in.ContentMd, in.Summary, frontmatterJSON, contentHash, in.Now,
			existing.Version+1, existing.ID, in.UserID)
		if uerr != nil {
			return nil, uerr
		}
		page, uerr = scanSingleWikiPage(rows)
		if uerr != nil {
			return nil, uerr
		}
	} else {
		rows, ierr := q.Query(ctx,
			`INSERT INTO petrichor_kb_wiki_page (user_id, knowledge_base_id, page_key, title, kind,
			 content_md, summary, frontmatter_json, content_hash, version)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1) RETURNING `+wikiPageColumns,
			in.UserID, in.KnowledgeBaseID, normalizedPageKey, in.Title, in.Kind,
			in.ContentMd, in.Summary, frontmatterJSON, contentHash)
		if ierr != nil {
			return nil, ierr
		}
		page, ierr = scanSingleWikiPage(rows)
		if ierr != nil {
			return nil, ierr
		}
	}

	if _, err := q.Exec(ctx,
		`DELETE FROM petrichor_kb_wiki_source_ref WHERE page_id = $1`, page.ID); err != nil {
		return nil, err
	}
	for _, ref := range in.SourceRefs {
		if _, err := q.Exec(ctx,
			`INSERT INTO petrichor_kb_wiki_source_ref (page_id, article_id, anchor, quote_hash, note)
			 VALUES ($1, $2, $3, NULL, $4)`, page.ID, ref.ArticleID, ref.Anchor, ref.Note); err != nil {
			return nil, err
		}
	}
	return page, nil
}

func scanSingleWikiPage(rows pgx.Rows) (*WikiPageRow, error) {
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	return scanWikiPageRows(rows)
}

// logWikiEvent 记录 Wiki 审计事件。
func logWikiEvent(q execQuerier, userID, knowledgeBaseID int64, eventType string, pageID, threadID *int64, payload any) error {
	payloadJSON := marshalJSON(payload)
	_, err := q.Exec(context.Background(),
		`INSERT INTO petrichor_kb_wiki_event_log (user_id, knowledge_base_id, event_type, page_id, thread_id, payload_json)
		 VALUES ($1,$2,$3,$4,$5,$6)`,
		userID, knowledgeBaseID, eventType, pageID, threadID, payloadJSON)
	return err
}

// rebuildWikiIndex 重编 index 页面与 index → 全部页面的链接。
func rebuildWikiIndex(q execQuerier, userID, knowledgeBaseID int64, knowledgeBaseName string, now time.Time) (*WikiPageRow, error) {
	pages, err := loadWikiPageRows(q, userID, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	var sourcePages, conceptPages []WikiPageRow
	for i := range pages {
		switch {
		case pages[i].Kind == "source":
			sourcePages = append(sourcePages, pages[i])
		case pages[i].Kind != "index":
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
	indexPage, err := upsertWikiPage(q, upsertWikiPageInput{
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
	if _, err := q.Exec(context.Background(),
		`DELETE FROM petrichor_kb_wiki_link WHERE from_page_id = $1`, indexPage.ID); err != nil {
		return nil, err
	}
	for i := range pages {
		page := &pages[i]
		if page.PageKey == "index" {
			continue
		}
		if _, err := q.Exec(context.Background(),
			`INSERT INTO petrichor_kb_wiki_link (user_id, knowledge_base_id, from_page_id, to_page_key, link_type)
			 VALUES ($1,$2,$3,$4,'index')`, userID, knowledgeBaseID, indexPage.ID, page.PageKey); err != nil {
			return nil, err
		}
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
func deleteArticleWikiPages(q execQuerier, userID int64, articles []ArticleRow, rebuildIndex bool) (int, error) {
	targetsByKB := map[int64][]int64{}
	for i := range articles {
		targetsByKB[articles[i].KnowledgeBaseID] = append(targetsByKB[articles[i].KnowledgeBaseID], articles[i].ID)
	}
	deletedTotal := 0
	ctx := context.Background()
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
		now := time.Now()

		if _, err := q.Exec(ctx,
			`UPDATE petrichor_kb_wiki_event_log SET page_id = NULL WHERE page_id = ANY($1)`, pageIDs); err != nil {
			return deletedTotal, err
		}
		if _, err := q.Exec(ctx,
			`DELETE FROM petrichor_kb_wiki_link
			 WHERE user_id = $1 AND knowledge_base_id = $2 AND (from_page_id = ANY($3) OR to_page_key = ANY($4))`,
			userID, knowledgeBaseID, pageIDs, pageKeys); err != nil {
			return deletedTotal, err
		}
		if _, err := q.Exec(ctx,
			`DELETE FROM petrichor_kb_wiki_source_ref WHERE page_id = ANY($1)`, pageIDs); err != nil {
			return deletedTotal, err
		}
		if _, err := q.Exec(ctx,
			`DELETE FROM petrichor_kb_wiki_tree_node WHERE page_id = ANY($1)`, pageIDs); err != nil {
			return deletedTotal, err
		}
		if _, err := q.Exec(ctx,
			`DELETE FROM petrichor_kb_wiki_page WHERE user_id = $1 AND knowledge_base_id = $2 AND id = ANY($3)`,
			userID, knowledgeBaseID, pageIDs); err != nil {
			return deletedTotal, err
		}
		if _, err := q.Exec(ctx,
			`UPDATE petrichor_kb_wiki_patch SET status = 'REJECTED', updated_at = $1
			 WHERE user_id = $2 AND knowledge_base_id = $3 AND status = 'PENDING' AND page_key = ANY($4)`,
			now, userID, knowledgeBaseID, pageKeys); err != nil {
			return deletedTotal, err
		}
		deletedTotal += len(pageIDs)

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
				if _, err := rebuildWikiIndex(q, userID, knowledgeBaseID, kbName, now); err != nil {
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
