package publicapi

import (
	"context"
	"time"

	"github.com/gin-gonic/gin"

	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/publicscope"
)

const publicWikiGraphNodeLimit = 500

// selectPublicWikiGraphPageIDs 为大图选择来源数和连接度更高的安全页面，避免浏览器一次渲染失控。
func selectPublicWikiGraphPageIDs(ctx context.Context, safePageIDs []int64) ([]int64, error) {
	if len(safePageIDs) <= publicWikiGraphNodeLimit {
		return safePageIDs, nil
	}
	rows, err := pool().Query(ctx,
		`SELECT p.id
		 FROM petrichor_kb_wiki_page p
		 WHERE p.id = ANY($1)
		 ORDER BY
		   (SELECT count(*) FROM petrichor_kb_wiki_source_ref ref WHERE ref.page_id = p.id) DESC,
		   (SELECT count(*) FROM petrichor_kb_wiki_link link
		    WHERE link.from_page_id = p.id OR link.to_page_key = p.page_key) DESC,
		   p.updated_at DESC, p.id ASC
		 LIMIT $2`, safePageIDs, publicWikiGraphNodeLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	selected := make([]int64, 0, publicWikiGraphNodeLimit)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		selected = append(selected, id)
	}
	return selected, rows.Err()
}

// WikiGraph GET /api/public/wiki/graph：返回一个公开知识库的安全 Wiki 图谱。
func WikiGraph(c *gin.Context) {
	knowledgeBaseID, err := parsePublicKnowledgeBaseID(c)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	ctx := c.Request.Context()
	kbID := knowledgeBaseID
	safePageIDs, err := publicscope.LoadSafeWikiPageIDs(ctx, &kbID)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	knowledgeBase, err := loadPublicKnowledgeBase(ctx, knowledgeBaseID, safePageIDs)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	totalPageCount := len(safePageIDs)
	selectedPageIDs, err := selectPublicWikiGraphPageIDs(ctx, safePageIDs)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	rows, err := pool().Query(ctx,
		`SELECT `+wikiPageColumnsPublic+`,
		        (SELECT COUNT(*) FROM petrichor_kb_wiki_source_ref ref WHERE ref.page_id = p.id)
		 FROM petrichor_kb_wiki_page p
		 WHERE p.id = ANY($1)
		 ORDER BY p.updated_at DESC, p.id ASC`, selectedPageIDs)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	pages := []*wikiPageRecord{}
	sourceCounts := map[int64]int64{}
	for rows.Next() {
		page, count, scanErr := scanPublicWikiListRow(rows)
		if scanErr != nil {
			rows.Close()
			httpx.HandleError(c, scanErr)
			return
		}
		pages = append(pages, page)
		sourceCounts[page.id] = count
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		httpx.HandleError(c, err)
		return
	}

	nodes := make([]map[string]any, 0, len(pages))
	var latest time.Time
	conceptCount, entityCount, sourceCount := 0, 0, 0
	for _, page := range pages {
		metadata := readPublicWikiMetadata(page.frontmatterJSON)
		summary := derefTrim(page.summary)
		if summary == "" {
			summary = summarizeWikiContent(page.contentMd, 180)
		}
		switch page.kind {
		case "concept":
			conceptCount++
		case "entity":
			entityCount++
		case "source":
			sourceCount++
		}
		if page.updatedAt.After(latest) {
			latest = page.updatedAt
		}
		nodes = append(nodes, map[string]any{
			"pageKey":      page.pageKey,
			"title":        page.title,
			"kind":         page.kind,
			"summary":      summary,
			"categoryPath": metadata.CategoryPath,
			"aliases":      metadata.Aliases,
			"sourceCount":  sourceCounts[page.id],
			"updatedAt":    httpx.FormatISO(page.updatedAt),
			"href":         publicWikiPageHref(knowledgeBaseID, page.pageKey),
		})
	}

	linkRows, err := pool().Query(ctx,
		`SELECT link.id, source_page.page_key, target_page.page_key, link.link_type
		 FROM petrichor_kb_wiki_link link
		 JOIN petrichor_kb_wiki_page source_page ON source_page.id = link.from_page_id
		 JOIN petrichor_kb_wiki_page target_page
		   ON target_page.knowledge_base_id = source_page.knowledge_base_id
		  AND target_page.page_key = link.to_page_key
		 WHERE source_page.id = ANY($1) AND target_page.id = ANY($1)
		   AND source_page.id <> target_page.id
		 ORDER BY link.id ASC`, selectedPageIDs)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	links := []map[string]any{}
	seen := map[string]struct{}{}
	for linkRows.Next() {
		var id int64
		var fromPageKey, toPageKey, linkType string
		if err := linkRows.Scan(&id, &fromPageKey, &toPageKey, &linkType); err != nil {
			linkRows.Close()
			httpx.HandleError(c, err)
			return
		}
		key := fromPageKey + "\x00" + toPageKey + "\x00" + linkType
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		links = append(links, map[string]any{
			"id":          formatInt(id),
			"fromPageKey": fromPageKey,
			"toPageKey":   toPageKey,
			"linkType":    linkType,
			"description": nil,
		})
	}
	linkRows.Close()
	if err := linkRows.Err(); err != nil {
		httpx.HandleError(c, err)
		return
	}

	var generatedAt any
	if !latest.IsZero() {
		generatedAt = httpx.FormatISO(latest)
	}
	c.Header("Cache-Control", publicWikiCacheControl)
	httpx.OK(c, map[string]any{
		"knowledgeBaseId":   formatInt(knowledgeBase.id),
		"knowledgeBaseName": knowledgeBase.name,
		"nodes":             nodes,
		"links":             links,
		"stats": map[string]any{
			"pageCount":    len(nodes),
			"linkCount":    len(links),
			"conceptCount": conceptCount,
			"entityCount":  entityCount,
			"sourceCount":  sourceCount,
		},
		"generatedAt":    generatedAt,
		"truncated":      totalPageCount > len(selectedPageIDs),
		"totalPageCount": totalPageCount,
	})
}
