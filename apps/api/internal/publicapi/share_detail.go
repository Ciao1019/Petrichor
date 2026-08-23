// share_detail.go 复刻 publicShareDetail / publicShareDetailGet：
// 分享码 + 可选访问密码的公开文章详情；GET 走缓存且不带密码，POST 支持密码但 no-store。
package publicapi

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"

	"petrichor/api/internal/cache"
	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/sitecontent"
)

// articleDetailColumns 公开详情所需的文章列（与 scanArticleDetail 一一对应）。
const articleDetailColumns = `id, title, content_md, content_json, content_meta_json,
	toc_json, public_content_hash, ai_summary, ai_summary_content_hash, ai_summary_generated_at,
	mindmap_json, mindmap_generated_at,
	mindmap_kg_json, mindmap_kg_generated_at,
	created_at, updated_at`

type articleDetailRow struct {
	id                   int64
	title                string
	contentMd            string
	contentJson          *string
	contentMetaJson      *string
	tocJSON              *string
	publicContentHash    *string
	aiSummary            *string
	aiSummaryContentHash *string
	aiSummaryGeneratedAt *time.Time
	mindmapJSON          *string
	mindmapGeneratedAt   *time.Time
	mindmapKgJSON        *string
	mindmapKgGeneratedAt *time.Time
	createdAt            time.Time
	updatedAt            time.Time
}

func scanArticleDetail(scanner interface{ Scan(dest ...any) error }) (*articleDetailRow, error) {
	var r articleDetailRow
	err := scanner.Scan(&r.id, &r.title, &r.contentMd,
		&r.contentJson, &r.contentMetaJson, &r.tocJSON,
		&r.publicContentHash, &r.aiSummary, &r.aiSummaryContentHash, &r.aiSummaryGeneratedAt,
		&r.mindmapJSON, &r.mindmapGeneratedAt,
		&r.mindmapKgJSON, &r.mindmapKgGeneratedAt,
		&r.createdAt, &r.updatedAt)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

type shareDetailRecord struct {
	id                 int64
	userID             int64
	articleID          int64
	shareCode          string
	expiresAt          *time.Time
	passwordHash       *string
	isRepost           bool
	originalURL        *string
	originalAuthorName *string
	internalURL        *string
}

// loadShareByCode 按 shareCode 读取启用中的分享。
func loadShareByCode(ctx context.Context, shareCode string) (*shareDetailRecord, error) {
	row := pool().QueryRow(ctx,
		`SELECT id, user_id, article_id, share_code, expires_at, password_hash,
		        is_repost, original_url, original_author_name, internal_url
		 FROM petrichor_kb_article_share
		 WHERE share_code = $1 AND enabled = true LIMIT 1`, shareCode)
	var r shareDetailRecord
	err := row.Scan(&r.id, &r.userID, &r.articleID, &r.shareCode, &r.expiresAt, &r.passwordHash,
		&r.isRepost, &r.originalURL, &r.originalAuthorName, &r.internalURL)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// loadArticleByID 读取文章正文与派生元数据。
func loadArticleByID(ctx context.Context, articleID int64) (*articleDetailRow, error) {
	row := pool().QueryRow(ctx,
		`SELECT `+articleDetailColumns+` FROM petrichor_kb_article WHERE id = $1 LIMIT 1`, articleID)
	r, err := scanArticleDetail(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return r, err
}

func loadArticleTags(ctx context.Context, articleID int64) ([]string, error) {
	rows, err := pool().Query(ctx,
		`SELECT tag FROM petrichor_kb_article_tag WHERE article_id = $1 ORDER BY tag ASC`, articleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tags := []string{}
	for rows.Next() {
		var tag string
		if serr := rows.Scan(&tag); serr != nil {
			return nil, serr
		}
		tags = append(tags, tag)
	}
	return tags, rows.Err()
}

// resolveUsableAiSummary 对应 resolveUsableArticleAiSummary。
func resolveUsableAiSummary(summary, summaryHash, currentHash string) string {
	if summary == "" {
		return ""
	}
	if summaryHash == "" || currentHash == "" || summaryHash != currentHash {
		return ""
	}
	return summary
}

// buildPublicArticleDetailResponse 对应 loadPublicShareDetailResponse 的响应组装。
func buildPublicArticleDetailResponse(ctx context.Context, article *articleDetailRow, repost map[string]any) (map[string]any, error) {
	tags, err := loadArticleTags(ctx, article.id)
	if err != nil {
		return nil, err
	}
	currentHash := contentMD5(article.contentMd)
	usableAiSummary := resolveUsableAiSummary(
		strings.TrimSpace(derefStr(article.aiSummary)),
		strings.TrimSpace(derefStr(article.aiSummaryContentHash)),
		currentHash,
	)
	displaySummary := strings.TrimSpace(derefStr(article.aiSummary))
	var displayAny any
	if displaySummary != "" {
		displayAny = displaySummary
	}

	resp := map[string]any{
		"title":                     article.title,
		"contentMd":                 article.contentMd,
		"contentJson":               jsonRawOrNil(article.contentJson),
		"contentMetaJson":           jsonRawOrNil(article.contentMetaJson),
		"tocJson":                   resolvePublicArticleToc(article.contentMd, article.tocJSON, article.publicContentHash),
		"aiSummary":                 displayAny,
		"aiSummaryGeneratedAt":      generatedOrNil(displaySummary != "", article.aiSummaryGeneratedAt),
		"aiSummaryStale":            displaySummary != "" && usableAiSummary == "",
		"tags":                      tags,
		"createdAt":                 httpx.FormatISO(article.createdAt),
		"updatedAt":                 httpx.FormatISO(article.updatedAt),
		"mindmapData":               parseJSONOrNull(article.mindmapJSON),
		"mindmapGeneratedAt":        isoPtr(article.mindmapGeneratedAt),
		"knowledgeGraphData":        parseJSONOrNull(article.mindmapKgJSON),
		"knowledgeGraphGeneratedAt": isoPtr(article.mindmapKgGeneratedAt),
	}
	for key, value := range repost {
		resp[key] = value
	}
	return resp, nil
}

func derefStr(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

func jsonRawOrNil(raw *string) any {
	if raw == nil {
		return nil
	}
	return *raw
}

func generatedOrNil(present bool, t *time.Time) any {
	if !present || t == nil {
		return nil
	}
	return httpx.FormatISO(*t)
}

// loadPublicShareDetailResponse 对应 loadPublicShareDetailResponse：
// 校验存在性 / 过期 / 密码后组装详情。allowPassword=false 时带密码的链接直接拒绝。
func loadPublicShareDetailResponse(ctx context.Context, shareCode, accessPassword string, allowPassword bool) (map[string]any, error) {
	code, verr := validateShareCode(shareCode)
	if verr != nil {
		return nil, verr
	}
	if perr := validateAccessPassword(accessPassword); perr != nil {
		return nil, perr
	}

	share, err := loadShareByCode(ctx, code)
	if err != nil {
		return nil, err
	}
	if share == nil {
		return nil, notFoundErr("分享不存在或已撤销")
	}
	now := timeNow()
	if share.expiresAt != nil && !share.expiresAt.After(now) {
		return nil, notFoundErr("分享已过期")
	}
	// TS 侧在输入校验阶段已对密码做 trim，这里保持一致。
	trimmedPassword := strings.TrimSpace(accessPassword)
	if hash := strings.TrimSpace(derefStr(share.passwordHash)); hash != "" {
		if !allowPassword || trimmedPassword == "" {
			return nil, forbiddenErr("该链接需要访问密码")
		}
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(trimmedPassword)) != nil {
			return nil, forbiddenErr("访问密码错误")
		}
	}

	article, aerr := loadArticleByID(ctx, share.articleID)
	if aerr != nil {
		return nil, aerr
	}
	if article == nil {
		return nil, notFoundErr("文章不存在")
	}

	repost := buildRepostAttribution(share.isRepost, share.originalURL, share.originalAuthorName)
	return buildPublicArticleDetailResponse(ctx, article, repost)
}

// ShareDetail POST /api/public/article/share/detail：body {shareCode, accessPassword?}。
func ShareDetail(c *gin.Context) {
	raw, err := readBody(c)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	resp, derr := loadPublicShareDetailResponse(c.Request.Context(),
		rawString(raw, "shareCode"), rawString(raw, "accessPassword"), true)
	if derr != nil {
		httpx.HandleError(c, derr)
		return
	}
	c.Header("Cache-Control", privateDetailNoStore)
	httpx.OK(c, resp)
}

// ShareDetailGet GET /api/public/article/share/detail?shareCode=...：
// 无密码通道，读穿透缓存并附 CDN 缓存头。
func ShareDetailGet(c *gin.Context) {
	shareCode := c.Query("shareCode")
	code, verr := validateShareCode(shareCode)
	if verr != nil {
		httpx.HandleError(c, verr)
		return
	}
	ctx := c.Request.Context()
	resp, derr := cache.ReadThrough(sitecontent.ArticleDetailCacheKey(code), sitecontent.TTLSeconds,
		func() (map[string]any, error) {
			return loadPublicShareDetailResponse(ctx, code, "", false)
		})
	if derr != nil {
		httpx.HandleError(c, derr)
		return
	}
	c.Header("Cache-Control", publicArticleDetailCacheControl)
	httpx.OK(c, resp)
}
