package publicapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/publicscope"
)

// 公开状态可随时撤销，Wiki 正文和派生目录不能继续使用过期缓存。
const publicWikiCacheControl = "no-store"

var publicWikiKinds = map[string]struct{}{
	"source":     {},
	"concept":    {},
	"entity":     {},
	"comparison": {},
	"answer":     {},
}

type publicWikiMetadata struct {
	Aliases      []string
	CategoryPath []string
}

func normalizeMetadataStrings(values []any, limit int) []string {
	seen := map[string]struct{}{}
	result := []string{}
	for _, raw := range values {
		value := strings.TrimSpace(toStr(raw))
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, value)
		if limit > 0 && len(result) >= limit {
			break
		}
	}
	return result
}

func readPublicWikiMetadata(raw *string) publicWikiMetadata {
	metadata := publicWikiMetadata{Aliases: []string{}, CategoryPath: []string{}}
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return metadata
	}
	var parsed struct {
		Aliases      []any `json:"aliases"`
		CategoryPath []any `json:"categoryPath"`
	}
	if json.Unmarshal([]byte(*raw), &parsed) != nil {
		return metadata
	}
	metadata.Aliases = normalizeMetadataStrings(parsed.Aliases, 12)
	metadata.CategoryPath = normalizeMetadataStrings(parsed.CategoryPath, 4)
	return metadata
}

type publicKnowledgeBaseRecord struct {
	id          int64
	name        string
	description *string
	updatedAt   time.Time
}

func loadPublicKnowledgeBase(
	ctx context.Context,
	knowledgeBaseID int64,
	safePageIDs []int64,
) (*publicKnowledgeBaseRecord, error) {
	if len(safePageIDs) == 0 {
		return nil, notFoundErr("公开 Wiki 不存在")
	}
	var record publicKnowledgeBaseRecord
	err := pool().QueryRow(ctx,
		`SELECT kb.id, kb.name, kb.description, MAX(p.updated_at)
		 FROM petrichor_kb_knowledge_base kb
		 JOIN petrichor_kb_wiki_page p ON p.knowledge_base_id = kb.id
		 WHERE kb.id = $1 AND p.id = ANY($2)
		 GROUP BY kb.id, kb.name, kb.description`,
		knowledgeBaseID, safePageIDs).Scan(&record.id, &record.name, &record.description, &record.updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, notFoundErr("公开 Wiki 不存在")
	}
	return &record, err
}

func parseOptionalPublicKnowledgeBaseID(c *gin.Context) (int64, error) {
	raw := strings.TrimSpace(c.Query("knowledgeBaseId"))
	if raw == "" {
		return 0, nil
	}
	id, err := parseInt64(raw)
	if err != nil || id <= 0 {
		return 0, badReq("knowledgeBaseId 必须是正整数")
	}
	return id, nil
}

// WikiKnowledgeBases GET /api/public/wiki/knowledge-bases。
func WikiKnowledgeBases(c *gin.Context) {
	ctx := c.Request.Context()
	safePageIDs, err := publicscope.LoadSafeWikiPageIDs(ctx, nil)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	if len(safePageIDs) == 0 {
		c.Header("Cache-Control", publicWikiCacheControl)
		httpx.OK(c, map[string]any{"items": []any{}})
		return
	}
	rows, err := pool().Query(ctx,
		`SELECT kb.id, kb.name, kb.description,
		        COUNT(DISTINCT p.id) AS page_count,
		        COUNT(DISTINCT ref.article_id) AS article_count,
		        MAX(p.updated_at) AS updated_at
		 FROM petrichor_kb_knowledge_base kb
		 JOIN petrichor_kb_wiki_page p ON p.knowledge_base_id = kb.id
		 LEFT JOIN petrichor_kb_wiki_source_ref ref ON ref.page_id = p.id
		 WHERE p.id = ANY($1)
		 GROUP BY kb.id, kb.name, kb.description
		 ORDER BY updated_at DESC, kb.id ASC`, safePageIDs)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	defer rows.Close()

	items := []map[string]any{}
	for rows.Next() {
		var id, pageCount, articleCount int64
		var name string
		var description *string
		var updatedAt time.Time
		if err := rows.Scan(&id, &name, &description, &pageCount, &articleCount, &updatedAt); err != nil {
			httpx.HandleError(c, err)
			return
		}
		items = append(items, map[string]any{
			"knowledgeBaseId": formatInt(id),
			"name":            name,
			"description":     nullableString(description),
			"pageCount":       pageCount,
			"articleCount":    articleCount,
			"updatedAt":       httpx.FormatISO(updatedAt),
		})
	}
	if err := rows.Err(); err != nil {
		httpx.HandleError(c, err)
		return
	}
	c.Header("Cache-Control", publicWikiCacheControl)
	httpx.OK(c, map[string]any{"items": items})
}

// WikiPageList GET /api/public/wiki/pages。
func WikiPageList(c *gin.Context) {
	knowledgeBaseID, err := parseOptionalPublicKnowledgeBaseID(c)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	kind := strings.TrimSpace(c.Query("kind"))
	if kind != "" && kind != "all" {
		if _, ok := publicWikiKinds[kind]; !ok {
			httpx.HandleError(c, badReq("kind 非法"))
			return
		}
	} else {
		kind = ""
	}
	keyword := strings.TrimSpace(firstNonEmpty(c.Query("q"), c.Query("keyword")))
	if runeLen(keyword) > publicSearchMaxKeywordLength {
		httpx.HandleError(c, badReq("关键字长度不能超过 100"))
		return
	}
	limit := parseBoundedNumber(c.Query("limit"), 50, 1, 100)
	offset := parseBoundedNumber(c.Query("offset"), 0, 0, int64(^uint64(0)>>1))

	ctx := c.Request.Context()
	safePageIDs, err := loadPublicWikiScope(ctx, knowledgeBaseID)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	targets, err := loadPublicWikiTargets(ctx, safePageIDs)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	knowledgeBase, err := loadPublicWikiCatalog(ctx, knowledgeBaseID, safePageIDs)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	pattern := "%" + escapeLikePattern(keyword) + "%"
	var total int64
	err = pool().QueryRow(ctx,
		`SELECT COUNT(*) FROM petrichor_kb_wiki_page p
		 WHERE p.id = ANY($1)
		   AND ($2 = '' OR p.kind = $2)
		   AND ($3 = '' OR p.title ILIKE $4 OR COALESCE(p.summary, '') ILIKE $4)`,
		safePageIDs, kind, keyword, pattern).Scan(&total)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	rows, err := pool().Query(ctx,
		`SELECT `+wikiPageColumnsPublic+`,
		        (SELECT COUNT(*) FROM petrichor_kb_wiki_source_ref ref WHERE ref.page_id = p.id)
		 FROM petrichor_kb_wiki_page p
		 WHERE p.id = ANY($1)
		   AND ($2 = '' OR p.kind = $2)
		   AND ($3 = '' OR p.title ILIKE $4 OR COALESCE(p.summary, '') ILIKE $4)
		 ORDER BY p.updated_at DESC, p.id ASC
		 LIMIT $5 OFFSET $6`, safePageIDs, kind, keyword, pattern, limit, offset)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	defer rows.Close()

	type pageEntry struct {
		page        *wikiPageRecord
		sourceCount int64
	}
	pageEntries := []pageEntry{}
	pageIDs := []int64{}
	for rows.Next() {
		page, sourceCount, err := scanPublicWikiListRow(rows)
		if err != nil {
			httpx.HandleError(c, err)
			return
		}
		pageEntries = append(pageEntries, pageEntry{page: page, sourceCount: sourceCount})
		pageIDs = append(pageIDs, page.id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		httpx.HandleError(c, err)
		return
	}

	relatedPagesByPageID := make(map[int64][]map[string]any)
	sourceArticlesByPageID := make(map[int64][]map[string]any)
	if len(pageIDs) > 0 {
		linkRows, err := pool().Query(ctx,
			`SELECT l.from_page_id, l.to_page_key, l.link_type,
			        target.title, target.kind, target.knowledge_base_id
			 FROM petrichor_kb_wiki_link l
			 JOIN petrichor_kb_wiki_page target
			   ON target.user_id = l.user_id
			  AND target.knowledge_base_id = l.knowledge_base_id
			  AND target.page_key = l.to_page_key
			 WHERE l.from_page_id = ANY($1)
			   AND target.id = ANY($2)
			 ORDER BY l.id ASC`, pageIDs, safePageIDs)
		if err != nil {
			httpx.HandleError(c, err)
			return
		}
		for linkRows.Next() {
			var fromPageID, targetKbID int64
			var toPageKey, linkType, targetTitle, targetKind string
			if err := linkRows.Scan(&fromPageID, &toPageKey, &linkType, &targetTitle, &targetKind, &targetKbID); err != nil {
				linkRows.Close()
				httpx.HandleError(c, err)
				return
			}
			relatedPagesByPageID[fromPageID] = append(relatedPagesByPageID[fromPageID], map[string]any{
				"pageKey":  toPageKey,
				"title":    targetTitle,
				"kind":     targetKind,
				"summary":  nil,
				"linkType": linkType,
				"href":     publicWikiPageHref(targetKbID, toPageKey),
			})
		}
		linkRows.Close()
		if err := linkRows.Err(); err != nil {
			httpx.HandleError(c, err)
			return
		}

		scope, err := publicscope.LoadArticles(ctx)
		if err != nil {
			httpx.HandleError(c, err)
			return
		}
		refRows, err := pool().Query(ctx,
			`SELECT page_id, article_id FROM petrichor_kb_wiki_source_ref
			 WHERE page_id = ANY($1)
			 GROUP BY page_id, article_id ORDER BY MIN(id) ASC`, pageIDs)
		if err != nil {
			httpx.HandleError(c, err)
			return
		}
		for refRows.Next() {
			var pageID, articleID int64
			if err := refRows.Scan(&pageID, &articleID); err != nil {
				refRows.Close()
				httpx.HandleError(c, err)
				return
			}
			if article, ok := scope[articleID]; ok {
				sourceArticlesByPageID[pageID] = append(sourceArticlesByPageID[pageID], map[string]any{
					"articleId": formatInt(article.ArticleID),
					"title":     article.Title,
					"href":      "/p/" + url.PathEscape(article.ShareCode),
				})
			}
		}
		refRows.Close()
		if err := refRows.Err(); err != nil {
			httpx.HandleError(c, err)
			return
		}
	}

	items := []map[string]any{}
	for _, entry := range pageEntries {
		page := entry.page
		sourceCount := entry.sourceCount
		sanitizePublicWikiPage(page, targets)
		metadata := readPublicWikiMetadata(page.frontmatterJSON)
		summary := strings.TrimSpace(derefStr(page.summary))
		if summary == "" {
			summary = summarizeWikiContent(page.contentMd, 180)
		}
		relatedPages := relatedPagesByPageID[page.id]
		if relatedPages == nil {
			relatedPages = []map[string]any{}
		}
		sourceArticles := sourceArticlesByPageID[page.id]
		if sourceArticles == nil {
			sourceArticles = []map[string]any{}
		}
		items = append(items, map[string]any{
			"pageKey":        page.pageKey,
			"title":          page.title,
			"kind":           page.kind,
			"summary":        summary,
			"aliases":        metadata.Aliases,
			"categoryPath":   metadata.CategoryPath,
			"sourceCount":    sourceCount,
			"relatedPages":   relatedPages,
			"sourceArticles": sourceArticles,
			"updatedAt":      httpx.FormatISO(page.updatedAt),
			"href":           publicWikiPageHref(page.knowledgeBaseID, page.pageKey),
		})
	}

	c.Header("Cache-Control", publicWikiCacheControl)
	httpx.OK(c, map[string]any{
		"knowledgeBaseId":   formatInt(knowledgeBase.id),
		"knowledgeBaseName": knowledgeBase.name,
		"description":       nullableString(knowledgeBase.description),
		"updatedAt":         httpx.FormatISO(knowledgeBase.updatedAt),
		"items":             items,
		"total":             total,
		"limit":             limit,
		"offset":            offset,
		"hasMore":           offset+int64(len(items)) < total,
	})
}

func scanPublicWikiListRow(scanner interface{ Scan(dest ...any) error }) (*wikiPageRecord, int64, error) {
	var page wikiPageRecord
	var sourceCount int64
	err := scanner.Scan(&page.id, &page.userID, &page.knowledgeBaseID, &page.pageKey, &page.title, &page.kind,
		&page.contentMd, &page.frontmatterJSON, &page.summary, &page.createdAt, &page.updatedAt, &sourceCount)
	return &page, sourceCount, err
}

func publicWikiPageHref(knowledgeBaseID int64, pageKey string) string {
	return "/wiki/" + formatInt(knowledgeBaseID) + "/" + url.PathEscape(pageKey)
}

func loadPublicWikiScope(ctx context.Context, knowledgeBaseID int64) ([]int64, error) {
	if knowledgeBaseID == 0 {
		return publicscope.LoadSafeWikiPageIDs(ctx, nil)
	}
	return publicscope.LoadSafeWikiPageIDs(ctx, &knowledgeBaseID)
}

// 不指定知识库时直接聚合全部安全页面，不读取内部知识库名称或描述。
func loadPublicWikiCatalog(ctx context.Context, knowledgeBaseID int64, safePageIDs []int64) (*publicKnowledgeBaseRecord, error) {
	if knowledgeBaseID != 0 {
		return loadPublicKnowledgeBase(ctx, knowledgeBaseID, safePageIDs)
	}
	record := &publicKnowledgeBaseRecord{name: "公开 Wiki"}
	err := pool().QueryRow(ctx, `SELECT COALESCE(MAX(updated_at), now())
		FROM petrichor_kb_wiki_page WHERE id = ANY($1)`, safePageIDs).Scan(&record.updatedAt)
	return record, err
}

func parsePublicKnowledgeBaseID(c *gin.Context) (int64, error) {
	id, err := parseOptionalPublicKnowledgeBaseID(c)
	if err == nil && id == 0 {
		return 0, badReq("knowledgeBaseId 必须是正整数")
	}
	return id, err
}
