// wiki.go 对照 wiki-agent-handlers.ts 的页面查询端点与共享响应组装。
// LLM 相关端点（knowledge/build、wiki/ingest、wiki/embedding/run）在 wiki-build.go。
package kb

import (
	"context"
	"sort"
	"strconv"
	"strings"
)

func toWikiPageResponse(page *WikiPageRow) map[string]any {
	metadata := readKnowledgePageMetadata(page.FrontmatterJson)
	return map[string]any{
		"id":              strconv.FormatInt(page.ID, 10),
		"knowledgeBaseId": strconv.FormatInt(page.KnowledgeBaseID, 10),
		"pageKey":         page.PageKey,
		"title":           page.Title,
		"kind":            page.Kind,
		"contentMd":       page.ContentMd,
		"frontmatter":     parseJSONObject(page.FrontmatterJson),
		"categoryPath":    metadata["categoryPath"],
		"aliases":         metadata["aliases"],
		"summary":         page.Summary,
		"contentHash":     page.ContentHash,
		"version":         page.Version,
		"archivedAt":      isoPtr(page.ArchivedAt),
		"createdAt":       iso(page.CreatedAt),
		"updatedAt":       iso(page.UpdatedAt),
	}
}

func toWikiPatchResponse(patch *WikiPatchRow) map[string]any {
	return map[string]any{
		"id":                strconv.FormatInt(patch.ID, 10),
		"knowledgeBaseId":   strconv.FormatInt(patch.KnowledgeBaseID, 10),
		"threadId":          nullableIDString(patch.ThreadID),
		"runId":             nullableIDString(patch.RunID),
		"pageKey":           patch.PageKey,
		"title":             patch.Title,
		"operation":         patch.Operation,
		"status":            patch.Status,
		"beforeContentMd":   patch.BeforeContentMd,
		"proposedContentMd": patch.ProposedContentMd,
		"diffText":          patch.DiffText,
		"reason":            patch.Reason,
		"appliedAt":         isoPtr(patch.AppliedAt),
		"createdAt":         iso(patch.CreatedAt),
		"updatedAt":         iso(patch.UpdatedAt),
	}
}

// loadWikiPageRows 未归档页面，kind/title 升序。
func loadWikiPageRows(q execQuerier, userID, knowledgeBaseID int64) ([]WikiPageRow, error) {
	rows, err := q.Query(context.Background(),
		`SELECT `+wikiPageColumns+` FROM petrichor_kb_wiki_page
		 WHERE user_id = $1 AND knowledge_base_id = $2 AND archived_at IS NULL
		 ORDER BY kind ASC, title ASC`, userID, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []WikiPageRow
	for rows.Next() {
		r, err := scanWikiPageRows(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// loadWikiPage 按 pageKey 取单页（normalize 后）；无行返回 nil。
func loadWikiPage(q execQuerier, userID, knowledgeBaseID int64, pageKey string) (*WikiPageRow, error) {
	rows, err := q.Query(context.Background(),
		`SELECT `+wikiPageColumns+` FROM petrichor_kb_wiki_page
		 WHERE user_id = $1 AND knowledge_base_id = $2 AND page_key = $3 LIMIT 1`,
		userID, knowledgeBaseID, normalizePageKey(pageKey))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	return scanWikiPageRows(rows)
}

func querySourceRefs(q execQuerier, sql string, args ...any) ([]SourceRefRow, error) {
	rows, err := q.Query(context.Background(), sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SourceRefRow
	for rows.Next() {
		var r SourceRefRow
		if err := rows.Scan(&r.ID, &r.PageID, &r.ArticleID, &r.Anchor, &r.QuoteHash, &r.Note, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func queryLinks(q execQuerier, sql string, args ...any) ([]WikiLinkRow, error) {
	rows, err := q.Query(context.Background(), sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []WikiLinkRow
	for rows.Next() {
		var r WikiLinkRow
		if err := rows.Scan(&r.ID, &r.UserID, &r.KnowledgeBaseID, &r.FromPageID, &r.ToPageKey,
			&r.LinkType, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ===== frontmatter 知识页元数据（对应 KnowledgePageMetadata） =====

func readKnowledgePageMetadata(raw *string) map[string]any {
	obj := parseJSONObject(raw)
	result := map[string]any{
		"generatedBy":   nil,
		"buildVersion":  float64(0),
		"sourceHash":    nil,
		"chunkCount":    float64(0),
		"entityCount":   float64(0),
		"conceptCount":  float64(0),
		"categoryPath":  []string{},
		"aliases":       []string{},
		"baseContentMd": nil,
		"baseSummary":   nil,
		"contributions": map[string]any{},
	}
	if obj == nil {
		return result
	}
	result["generatedBy"] = optString(obj["generatedBy"])
	result["sourceHash"] = optString(obj["sourceHash"])
	result["baseContentMd"] = optNonEmptyString(obj["baseContentMd"])
	result["baseSummary"] = optNonEmptyString(obj["baseSummary"])
	result["buildVersion"] = optNumber(obj["buildVersion"])
	result["chunkCount"] = optNumber(obj["chunkCount"])
	result["entityCount"] = optNumber(obj["entityCount"])
	result["conceptCount"] = optNumber(obj["conceptCount"])
	result["categoryPath"] = normalizeStringList(obj["categoryPath"], 2)
	result["aliases"] = normalizeStringList(obj["aliases"], -1)

	contributions := map[string]any{}
	if rawContributions, ok := obj["contributions"].(map[string]any); ok {
		keys := make([]string, 0, len(rawContributions))
		for key := range rawContributions {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, articleID := range keys {
			entry, ok := rawContributions[articleID].(map[string]any)
			if !ok {
				continue
			}
			title := "文章 " + articleID
			if s, ok := entry["articleTitle"].(string); ok && s != "" {
				title = s
			}
			contributions[articleID] = map[string]any{
				"articleId":       articleID,
				"articleTitle":    title,
				"summary":         optString(entry["summary"]),
				"contentMd":       optString(entry["contentMd"]),
				"aliases":         normalizeStringList(entry["aliases"], -1),
				"categoryPath":    normalizeStringList(entry["categoryPath"], 2),
				"sourceChunkKeys": normalizeStringList(entry["sourceChunkKeys"], -1),
				"relatedPageKeys": normalizeStringList(entry["relatedPageKeys"], -1),
				"relations":       normalizeStoredKnowledgeRelations(entry["relations"]),
			}
		}
	}
	result["contributions"] = contributions
	return result
}

// collectKnowledgePageRelations 汇总 contributions 内的全部关系。
func collectKnowledgePageRelations(metadata map[string]any) []map[string]string {
	contributions, _ := metadata["contributions"].(map[string]any)
	var raw []any
	for _, value := range contributions {
		entry, ok := value.(map[string]any)
		if !ok {
			continue
		}
		if relations, ok := entry["relations"].([]map[string]string); ok {
			for _, relation := range relations {
				raw = append(raw, map[string]any{
					"fromPageKey":  relation["fromPageKey"],
					"toPageKey":    relation["toPageKey"],
					"relationType": relation["relationType"],
					"description":  relation["description"],
				})
			}
		}
	}
	return normalizeStoredKnowledgeRelations(raw)
}

// normalizeStoredKnowledgeRelations 关系去重 + 规范化。
func normalizeStoredKnowledgeRelations(value any) []map[string]string {
	list, ok := value.([]any)
	if !ok {
		return nil
	}
	seen := map[string]struct{}{}
	var out []map[string]string
	for _, item := range list {
		relation, ok := item.(map[string]any)
		if !ok {
			continue
		}
		fromPageKey := normalizePageKey(optString(relation["fromPageKey"]))
		toPageKey := normalizePageKey(optString(relation["toPageKey"]))
		if fromPageKey == "" || toPageKey == "" || fromPageKey == toPageKey {
			continue
		}
		relationType := trimSpace(optString(relation["relationType"]))
		if relationType == "" {
			relationType = "关联"
		}
		if runes := []rune(relationType); len(runes) > 60 {
			relationType = string(runes[:60])
		}
		description := trimSpace(optString(relation["description"]))
		if runes := []rune(description); len(runes) > 300 {
			description = string(runes[:300])
		}
		key := fromPageKey + "|" + toPageKey + "|" + relationType
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, map[string]string{
			"fromPageKey":  fromPageKey,
			"toPageKey":    toPageKey,
			"relationType": relationType,
			"description":  description,
		})
	}
	return out
}

func optString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func optNonEmptyString(v any) any {
	s := strings.TrimSpace(optString(v))
	if s == "" {
		return nil
	}
	return s
}

func optNumber(v any) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return 0
}

// normalizeStringList 字符串列表去重；limit>=0 时截断到 limit。
func normalizeStringList(value any, limit int) []string {
	list, ok := value.([]any)
	if !ok {
		return []string{}
	}
	seen := map[string]struct{}{}
	out := []string{}
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
	}
	if limit >= 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

// ===== 端点：wiki/page/list、wiki/page/detail =====

// WikiPageList 页面清单。
func WikiPageList(c *ginContext) {
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
		pageMaps := make([]map[string]any, 0, len(pages))
		for i := range pages {
			pageMaps = append(pageMaps, toWikiPageResponse(&pages[i]))
		}
		return map[string]any{
			"knowledgeBaseId": strconv.FormatInt(kbID, 10),
			"pages":           pageMaps,
		}, nil
	})
}

// WikiPageDetail 单页详情：来源引用 + 出链/入链（含关系描述）。
func WikiPageDetail(c *ginContext) {
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
		pageKey := trimmedString(raw, "pageKey")
		if pageKey == "" || len([]rune(pageKey)) > 200 {
			return nil, badReq("pageKey 必须在 1 到 200 个字符之间")
		}
		return wikiPageDetailCore(pool(), user.ID, kbID, pageKey)
	})
}

// wikiPageDetailCore Wiki 页面详情组装（用户端与 Agent 端共用）。
func wikiPageDetailCore(q execQuerier, userID, kbID int64, pageKey string) (map[string]any, error) {
	if _, err := assertKnowledgeBaseOwner(q, userID, kbID); err != nil {
		return nil, err
	}
	page, err := loadWikiPage(q, userID, kbID, pageKey)
	if err != nil {
		return nil, err
	}
	if page == nil {
		return nil, notFoundErr("Wiki 页面不存在")
	}

	sourceRefs, err := querySourceRefs(q,
		`SELECT `+sourceRefColumns+` FROM petrichor_kb_wiki_source_ref WHERE page_id = $1 ORDER BY id ASC`, page.ID)
	if err != nil {
		return nil, err
	}
	refTitles := map[int64]string{}
	if len(sourceRefs) > 0 {
		articleIDs := make([]int64, 0, len(sourceRefs))
		for i := range sourceRefs {
			articleIDs = append(articleIDs, sourceRefs[i].ArticleID)
		}
		titles, terr := loadIDNameMap(q,
			`SELECT id, title FROM petrichor_kb_article WHERE id = ANY($1)`, articleIDs)
		if terr != nil {
			return nil, terr
		}
		refTitles = titles
	}

	outLinks, err := queryLinks(q,
		`SELECT `+wikiLinkColumns+` FROM petrichor_kb_wiki_link WHERE from_page_id = $1 ORDER BY to_page_key ASC`,
		page.ID)
	if err != nil {
		return nil, err
	}
	inLinks, err := queryLinks(q,
		`SELECT `+wikiLinkColumns+` FROM petrichor_kb_wiki_link
			 WHERE user_id = $1 AND knowledge_base_id = $2 AND to_page_key = $3 ORDER BY from_page_id ASC`,
		userID, kbID, page.PageKey)
	if err != nil {
		return nil, err
	}
	activePages, err := loadWikiPageRows(q, userID, kbID)
	if err != nil {
		return nil, err
	}
	pageByID := map[int64]*WikiPageRow{}
	pageByKey := map[string]*WikiPageRow{}
	for i := range activePages {
		pageByID[activePages[i].ID] = &activePages[i]
		pageByKey[activePages[i].PageKey] = &activePages[i]
	}
	metadata := readKnowledgePageMetadata(page.FrontmatterJson)
	outgoingRelations := map[string]map[string]string{}
	for _, relation := range collectKnowledgePageRelations(metadata) {
		outgoingRelations[relation["toPageKey"]+"|"+relation["relationType"]] = relation
	}

	linkMaps := make([]map[string]any, 0, len(outLinks))
	for i := range outLinks {
		link := &outLinks[i]
		toPage := pageByKey[link.ToPageKey]
		description := any(nil)
		if relation, ok := outgoingRelations[link.ToPageKey+"|"+link.LinkType]; ok && relation["description"] != "" {
			description = relation["description"]
		}
		item := map[string]any{
			"id":          strconv.FormatInt(link.ID, 10),
			"toPageKey":   link.ToPageKey,
			"linkType":    link.LinkType,
			"description": description,
		}
		if toPage != nil {
			item["toPageTitle"] = toPage.Title
			item["toPageKind"] = toPage.Kind
			item["toPageSummary"] = toPage.Summary
		} else {
			item["toPageTitle"] = link.ToPageKey
			item["toPageKind"] = nil
			item["toPageSummary"] = nil
		}
		linkMaps = append(linkMaps, item)
	}

	inLinkMaps := make([]map[string]any, 0, len(inLinks))
	for i := range inLinks {
		link := &inLinks[i]
		fromPage := pageByID[link.FromPageID]
		fromKey := ""
		fromTitle := "未知页面"
		var fromKind, fromSummary any
		description := any(nil)
		if fromPage != nil {
			fromKey = fromPage.PageKey
			fromTitle = fromPage.Title
			fromKind = fromPage.Kind
			fromSummary = fromPage.Summary
			fromMetadata := readKnowledgePageMetadata(fromPage.FrontmatterJson)
			for _, relation := range collectKnowledgePageRelations(fromMetadata) {
				if relation["toPageKey"] == page.PageKey && relation["relationType"] == link.LinkType {
					if relation["description"] != "" {
						description = relation["description"]
					}
					break
				}
			}
		}
		inLinkMaps = append(inLinkMaps, map[string]any{
			"id":              strconv.FormatInt(link.ID, 10),
			"fromPageKey":     fromKey,
			"fromPageTitle":   fromTitle,
			"fromPageKind":    fromKind,
			"fromPageSummary": fromSummary,
			"linkType":        link.LinkType,
			"description":     description,
		})
	}

	detail := toWikiPageResponse(page)
	refMaps := make([]map[string]any, 0, len(sourceRefs))
	for i := range sourceRefs {
		ref := &sourceRefs[i]
		refMaps = append(refMaps, map[string]any{
			"id":           strconv.FormatInt(ref.ID, 10),
			"articleId":    strconv.FormatInt(ref.ArticleID, 10),
			"articleTitle": refTitles[ref.ArticleID],
			"anchor":       ref.Anchor,
			"note":         ref.Note,
		})
	}
	detail["sourceRefs"] = refMaps
	detail["links"] = linkMaps
	detail["inLinks"] = inLinkMaps
	return detail, nil
}
