// article.go 复刻 share-handlers.ts 的公开文章列表与搜索（loadPublicArticleListResponse /
// loadPublicArticleSearchResponse / publicArticleSearch），含可见性判定与摘要回退链。
package publicapi

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/cache"
	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/sitecontent"
)

// HTTP 缓存头：与 TS 独立硬编码的 Cache-Control 一致。
const (
	publicArticleListCacheControl   = "public, max-age=60, s-maxage=60, stale-while-revalidate=300"
	publicArticleSearchCacheControl = "public, max-age=15, s-maxage=15, stale-while-revalidate=60"
	publicArticleDetailCacheControl = "public, max-age=300, s-maxage=300, stale-while-revalidate=600"
	privateDetailNoStore            = "no-store"
	burnNoStore                     = "no-store"
)

// shareJoinColumns 列表/搜索共用的分享 × 文章联查列。
// enabled / revoked_at 由 WHERE 子句保证为 true / NULL，无需返回。
const shareJoinColumns = `a.id AS article_id, a.title, a.updated_at,
	a.public_excerpt, a.public_content_hash, a.ai_summary, a.reading_minutes,
	s.share_code, s.expires_at, s.password_hash,
	s.is_repost, s.original_url, s.original_author_name, s.internal_url,
	s.pin_order`

type shareListRow struct {
	articleID          int64
	title              string
	updatedAt          time.Time
	publicExcerpt      *string
	publicContentHash  *string
	aiSummary          *string
	readingMinutes     *int32
	shareCode          string
	expiresAt          *time.Time
	passwordHash       *string
	isRepost           bool
	originalURL        *string
	originalAuthorName *string
	internalURL        *string
	pinOrder           *int32
	searchScore        float64
}

func scanShareListRow(scanner interface{ Scan(dest ...any) error }) (*shareListRow, error) {
	var r shareListRow
	err := scanner.Scan(&r.articleID, &r.title, &r.updatedAt,
		&r.publicExcerpt, &r.publicContentHash, &r.aiSummary, &r.readingMinutes,
		&r.shareCode, &r.expiresAt, &r.passwordHash,
		&r.isRepost, &r.originalURL, &r.originalAuthorName, &r.internalURL,
		&r.pinOrder)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

type homepageShareStatus struct {
	listed      bool
	expired     bool
	hasPassword bool
}

// resolveHomepageShareStatus 对应 resolvePublicHomepageShareStatus。
func resolveHomepageShareStatus(row *shareListRow, now time.Time) homepageShareStatus {
	status := homepageShareStatus{listed: row != nil}
	if row == nil {
		return status
	}
	if row.expiresAt != nil && !row.expiresAt.After(now) {
		status.expired = true
	}
	if row.passwordHash != nil && strings.TrimSpace(*row.passwordHash) != "" {
		status.hasPassword = true
	}
	return status
}

func derefTrim(v *string) string {
	if v == nil {
		return ""
	}
	return strings.TrimSpace(*v)
}

// buildAiSummaryExcerpt 对应 buildArticleAiSummaryExcerpt：无有效摘要返回空串。
func buildAiSummaryExcerpt(summary *string) string {
	text := derefTrim(summary)
	if text == "" {
		return ""
	}
	return buildHomepageArticleExcerpt(text, 120)
}

type fallbackMetadata struct {
	publicExcerpt  string
	readingMinutes int32
}

// hasUsablePublicListMetadata 对应同名函数。
func hasUsablePublicListMetadata(publicExcerpt *string, readingMinutes *int32) bool {
	if publicExcerpt == nil || strings.TrimSpace(*publicExcerpt) == "" {
		return false
	}
	return readingMinutes != nil && *readingMinutes > 0
}

// resolveReadingMinutes 对应同名函数：存量无效时用回退值，仍无效给 1。
func resolveReadingMinutes(stored *int32, fallback int32) int32 {
	if stored != nil && *stored > 0 {
		return *stored
	}
	if fallback > 0 {
		return fallback
	}
	return 1
}

// loadFallbackMetadata 对应 loadFallbackPublicArticleListMetadata：
// 存量摘要/时长缺失的文章，从正文现场派生一份兜底元数据。
func loadFallbackMetadata(ctx context.Context, articleIDs []int64) (map[int64]fallbackMetadata, error) {
	result := map[int64]fallbackMetadata{}
	if len(articleIDs) == 0 {
		return result, nil
	}
	rows, err := pool().Query(ctx,
		`SELECT id, content_md FROM petrichor_kb_article WHERE id = ANY($1)`, articleIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var contentMd string
		if serr := rows.Scan(&id, &contentMd); serr != nil {
			return nil, serr
		}
		result[id] = fallbackMetadata{
			publicExcerpt:  buildHomepageArticleExcerpt(contentMd, 120),
			readingMinutes: estimateReadingMinutes(contentMd),
		}
	}
	return result, rows.Err()
}

// loadTagsByArticleIDs 按标签名排序的标签映射。
func loadTagsByArticleIDs(ctx context.Context, articleIDs []int64) (map[int64][]string, error) {
	result := map[int64][]string{}
	if len(articleIDs) == 0 {
		return result, nil
	}
	rows, err := pool().Query(ctx,
		`SELECT article_id, tag FROM petrichor_kb_article_tag
		 WHERE article_id = ANY($1) ORDER BY tag ASC`, articleIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var articleID int64
		var tag string
		if serr := rows.Scan(&articleID, &tag); serr != nil {
			return nil, serr
		}
		result[articleID] = append(result[articleID], tag)
	}
	return result, rows.Err()
}

func tagsFor(result map[int64][]string, articleID int64) []string {
	if tags, ok := result[articleID]; ok && tags != nil {
		return tags
	}
	return []string{}
}

// buildRepostAttribution 对应 buildPublicShareRepostAttribution。
func buildRepostAttribution(isRepost bool, originalURL, originalAuthorName *string) map[string]any {
	url := strings.TrimSpace(derefPtr(originalURL))
	author := strings.TrimSpace(derefPtr(originalAuthorName))
	if !isRepost || url == "" || author == "" {
		return map[string]any{"isRepost": false, "originalUrl": nil, "originalAuthorName": nil}
	}
	return map[string]any{"isRepost": true, "originalUrl": url, "originalAuthorName": author}
}

// buildInternalLink 对应 buildPublicShareInternalLink。
func buildInternalLink(internalURL *string) (map[string]any, string) {
	url := derefTrim(internalURL)
	if url == "" || !isInternalSitePath(url) {
		return map[string]any{"internalUrl": nil}, ""
	}
	return map[string]any{"internalUrl": url}, url
}

// resolveHref 内部链接合法时列表直跳站内页面，否则进详情页。
func resolveHref(shareCode string, internalURL *string) string {
	if _, url := buildInternalLink(internalURL); url != "" {
		return url
	}
	return "/p/" + shareCode
}

// PublicArticleListResponse 对应 loadPublicArticleListResponse。
func PublicArticleListResponse(ctx context.Context) (map[string]any, error) {
	now := time.Now()
	rows, err := pool().Query(ctx,
		`SELECT `+shareJoinColumns+`
		 FROM petrichor_kb_article_share s
		 JOIN petrichor_kb_article a ON a.id = s.article_id
		 WHERE s.enabled = true AND s.revoked_at IS NULL
		 ORDER BY s.pin_order IS NULL, s.pin_order DESC, a.updated_at DESC, s.id DESC`)
	if err != nil {
		return nil, err
	}
	list := []*shareListRow{}
	for rows.Next() {
		r, serr := scanShareListRow(rows)
		if serr != nil {
			rows.Close()
			return nil, serr
		}
		list = append(list, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return assembleArticleItems(ctx, list, now, false)
}

// assembleArticleItems 可见性过滤 + 摘要回退 + 组装响应条目；带 score 时用于搜索结果。
func assembleArticleItems(ctx context.Context, rows []*shareListRow, now time.Time, withScore bool) (map[string]any, error) {
	needFallback := []int64{}
	for _, row := range rows {
		if !hasUsablePublicListMetadata(row.publicExcerpt, row.readingMinutes) ||
			strings.TrimSpace(derefPtr(row.publicContentHash)) == "" {
			needFallback = append(needFallback, row.articleID)
		}
	}
	fallbackByArticle, ferr := loadFallbackMetadata(ctx, needFallback)
	if ferr != nil {
		return nil, ferr
	}
	tagsByArticle, terr := loadTagsByArticleIDs(ctx, articleIDsOf(rows))
	if terr != nil {
		return nil, terr
	}

	items := []map[string]any{}
	for _, row := range rows {
		status := resolveHomepageShareStatus(row, now)
		if !status.listed {
			continue
		}
		fallback, hasFallback := fallbackByArticle[row.articleID]
		item := map[string]any{
			"articleId":      formatInt(row.articleID),
			"shareCode":      row.shareCode,
			"title":          row.title,
			"updatedAt":      httpx.FormatISO(row.updatedAt),
			"tags":           tagsFor(tagsByArticle, row.articleID),
			"href":           resolveHref(row.shareCode, row.internalURL),
			"expired":        status.expired,
			"expiresAt":      isoPtr(row.expiresAt),
			"hasPassword":    status.hasPassword,
			"isPinned":       row.pinOrder != nil,
			"pinOrder":       pinOrderOrNil(row.pinOrder),
			"isInternalLink": validInternalLink(row.internalURL) != "",
		}
		for key, value := range buildRepostAttribution(row.isRepost, row.originalURL, row.originalAuthorName) {
			item[key] = value
		}
		excerpt := buildAiSummaryExcerpt(row.aiSummary)
		if excerpt == "" {
			excerpt = strings.TrimSpace(derefPtr(row.publicExcerpt))
		}
		if excerpt == "" && hasFallback {
			excerpt = fallback.publicExcerpt
		}
		if excerpt == "" {
			excerpt = "暂无摘要"
		}
		item["excerpt"] = excerpt
		fallbackMinutes := int32(0)
		if hasFallback {
			fallbackMinutes = fallback.readingMinutes
		}
		item["readingMinutes"] = resolveReadingMinutes(row.readingMinutes, fallbackMinutes)
		if withScore {
			item["score"] = row.searchScore
		}
		items = append(items, item)
	}
	return map[string]any{"items": items}, nil
}

func articleIDsOf(rows []*shareListRow) []int64 {
	ids := make([]int64, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.articleID)
	}
	return ids
}

func derefPtr(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

func isoPtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.FormatISO(*t)
}

func pinOrderOrNil(v *int32) any {
	if v == nil {
		return nil
	}
	return *v
}

func validInternalLink(internalURL *string) string {
	url := derefTrim(internalURL)
	if url == "" || !isInternalSitePath(url) {
		return ""
	}
	return url
}

// isInternalSitePath 站内路径判定（对应 share-logic.ts 同名函数）。
func isInternalSitePath(value string) bool {
	trimmed := strings.TrimSpace(value)
	if !strings.HasPrefix(trimmed, "/") || strings.HasPrefix(trimmed, "//") {
		return false
	}
	return len(strings.Fields(trimmed)) >= 1 && !strings.ContainsAny(trimmed[1:], " \t\n\r")
}

// parseJSONOrNull 解析 JSON 文本列；失败返回 nil。
func parseJSONOrNull(raw *string) any {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil
	}
	var parsed any
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return nil
	}
	return parsed
}

// ===== 端点 =====

// ArticleList GET+POST /api/public/article/list。
func ArticleList(c *gin.Context) {
	ctx := c.Request.Context()
	resp, err := cache.ReadThrough(sitecontent.ArticleListCacheKey(), sitecontent.TTLSeconds,
		func() (map[string]any, error) { return PublicArticleListResponse(ctx) })
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	c.Header("Cache-Control", publicArticleListCacheControl)
	httpx.OK(c, resp)
}
