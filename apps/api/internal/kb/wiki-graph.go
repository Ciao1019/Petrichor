// wiki-graph.go 知识库 Wiki 图谱：把 Wiki 页面与页面间链接一次性打包成点群载荷，
// 供前端「Wiki 图谱」视图渲染（在知识库内扮演全站星图 /public/site-graph 的角色）。
// 单独成端点而不是让前端逐页拉 wiki/page/detail：一个知识库常有几百个页面，
// 逐页取详情会退化成 N 次往返。
package kb

import (
	"context"
	"strconv"
	"time"
)

// WikiGraph 图谱载荷：节点是未归档的 Wiki 页面，边是页面之间的出链。
func WikiGraph(c *ginContext) {
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
		ctx := c.Request.Context()
		kbRow, err := assertKnowledgeBaseOwner(ctx, q, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		pages, err := loadWikiPageRows(ctx, q, user.ID, kbID)
		if err != nil {
			return nil, err
		}

		pageByID := map[int64]*WikiPageRow{}
		pageByKey := map[string]*WikiPageRow{}
		for i := range pages {
			pageByID[pages[i].ID] = &pages[i]
			pageByKey[pages[i].PageKey] = &pages[i]
		}

		sourceCounts, err := loadWikiSourceRefCounts(ctx, q, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		linkRows, err := queryLinks(ctx, q,
			`SELECT `+wikiLinkColumns+` FROM petrichor_kb_wiki_link
			 WHERE user_id = $1 AND knowledge_base_id = $2 ORDER BY id ASC`,
			user.ID, kbID)
		if err != nil {
			return nil, err
		}

		// 关系描述写在来源页 frontmatter 的 contributions 里，按 from 页缓存一次，
		// 避免同一页有多条出链时重复解析 JSON。
		relationsByPageID := map[int64]map[string]string{}
		relationsOf := func(page *WikiPageRow) map[string]string {
			if cached, ok := relationsByPageID[page.ID]; ok {
				return cached
			}
			descriptions := map[string]string{}
			for _, relation := range collectKnowledgePageRelations(readKnowledgePageMetadata(page.FrontmatterJson)) {
				if relation["description"] == "" {
					continue
				}
				descriptions[relation["toPageKey"]+"|"+relation["relationType"]] = relation["description"]
			}
			relationsByPageID[page.ID] = descriptions
			return descriptions
		}

		linkMaps := make([]map[string]any, 0, len(linkRows))
		seenLinks := map[string]struct{}{}
		for i := range linkRows {
			link := &linkRows[i]
			fromPage := pageByID[link.FromPageID]
			toPage := pageByKey[link.ToPageKey]
			// 悬空边（来源页已归档 / 目标页不存在）在点群里没有落点，直接丢弃
			if fromPage == nil || toPage == nil || fromPage.PageKey == toPage.PageKey {
				continue
			}
			dedupeKey := fromPage.PageKey + "|" + toPage.PageKey + "|" + link.LinkType
			if _, dup := seenLinks[dedupeKey]; dup {
				continue
			}
			seenLinks[dedupeKey] = struct{}{}
			var description any
			if text := relationsOf(fromPage)[toPage.PageKey+"|"+link.LinkType]; text != "" {
				description = text
			}
			linkMaps = append(linkMaps, map[string]any{
				"id":          strconv.FormatInt(link.ID, 10),
				"fromPageKey": fromPage.PageKey,
				"toPageKey":   toPage.PageKey,
				"linkType":    link.LinkType,
				"description": description,
			})
		}

		var latestUpdatedAt time.Time
		conceptCount, entityCount, sourceCount := 0, 0, 0
		nodeMaps := make([]map[string]any, 0, len(pages))
		for i := range pages {
			page := &pages[i]
			switch page.Kind {
			case "concept":
				conceptCount++
			case "entity":
				entityCount++
			case "source":
				sourceCount++
			}
			if page.UpdatedAt.After(latestUpdatedAt) {
				latestUpdatedAt = page.UpdatedAt
			}
			metadata := readKnowledgePageMetadata(page.FrontmatterJson)
			nodeMaps = append(nodeMaps, map[string]any{
				"pageKey":      page.PageKey,
				"title":        page.Title,
				"kind":         page.Kind,
				"summary":      page.Summary,
				"categoryPath": metadata["categoryPath"],
				"aliases":      metadata["aliases"],
				"sourceCount":  sourceCounts[page.ID],
				"updatedAt":    iso(page.UpdatedAt),
			})
		}

		var generatedAt any
		if !latestUpdatedAt.IsZero() {
			generatedAt = iso(latestUpdatedAt)
		}
		return map[string]any{
			"knowledgeBaseId":   strconv.FormatInt(kbID, 10),
			"knowledgeBaseName": kbRow.Name,
			"nodes":             nodeMaps,
			"links":             linkMaps,
			"stats": map[string]any{
				"pageCount":    len(nodeMaps),
				"linkCount":    len(linkMaps),
				"conceptCount": conceptCount,
				"entityCount":  entityCount,
				"sourceCount":  sourceCount,
			},
			"generatedAt": generatedAt,
		}, nil
	})
}

// loadWikiSourceRefCounts 每个 Wiki 页面被多少条来源引用支撑，用来给点群节点定权重。
func loadWikiSourceRefCounts(ctx context.Context, q execQuerier, userID, knowledgeBaseID int64) (map[int64]int, error) {
	rows, err := q.Query(ctx,
		`SELECT r.page_id, COUNT(*) FROM petrichor_kb_wiki_source_ref r
		 JOIN petrichor_kb_wiki_page p ON p.id = r.page_id
		 WHERE p.user_id = $1 AND p.knowledge_base_id = $2
		 GROUP BY r.page_id`, userID, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := map[int64]int{}
	for rows.Next() {
		var pageID int64
		var count int
		if err := rows.Scan(&pageID, &count); err != nil {
			return nil, err
		}
		counts[pageID] = count
	}
	return counts, rows.Err()
}
