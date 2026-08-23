// burn.go 复刻 burn-link-handlers.ts 的公开端点：publicBurnMeta / publicBurnConsume。
// 全程 no-store，meta 只暴露状态/是否需要密码/封面图，绝不返回正文。
package publicapi

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"

	httpx "petrichor/api/internal/httpx"
)

type burnLinkRow struct {
	id           int64
	userID       int64
	articleID    int64
	linkCode     string
	maxViews     int32
	viewCount    int32
	passwordHash *string
	expiresAt    *time.Time
	status       string
	burnedAt     *time.Time
}

const burnLinkColumns = `id, user_id, article_id, link_code, max_views, view_count,
	password_hash, expires_at, status, burned_at`

func scanBurnLink(scanner interface{ Scan(dest ...any) error }) (*burnLinkRow, error) {
	var r burnLinkRow
	err := scanner.Scan(&r.id, &r.userID, &r.articleID, &r.linkCode, &r.maxViews, &r.viewCount,
		&r.passwordHash, &r.expiresAt, &r.status, &r.burnedAt)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func loadBurnLinkByCode(ctx context.Context, code string) (*burnLinkRow, error) {
	row := pool().QueryRow(ctx,
		`SELECT `+burnLinkColumns+`
		 FROM petrichor_kb_article_burn_link WHERE link_code = $1 LIMIT 1`, code)
	r, err := scanBurnLink(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return r, err
}

// resolveBurnLinkPublicState 把存储状态 + 过期时间归一为面向公开端的可达状态。
func resolveBurnLinkPublicState(status string, expiresAt *time.Time, now time.Time) string {
	switch status {
	case "REVOKED":
		return "REVOKED"
	case "BURNED":
		return "BURNED"
	}
	if expiresAt != nil && !expiresAt.After(now) {
		return "EXPIRED"
	}
	return "ACTIVE"
}

var (
	mdFirstImageRe = regexp.MustCompile(`!\[[^\]]*\]\(([^)\s"]+)`)
	htmlImgSrcRe   = regexp.MustCompile(`<img[^>]+src=["']([^"']+)["']`)
	httpURLCheckRe = regexp.MustCompile(`^https?://`)
)

// extractFirstImageUrl 提取正文首图 URL（Markdown 图片优先，其次内联 <img>）。
func extractFirstImageUrl(contentMd string) string {
	if contentMd == "" {
		return ""
	}
	if m := mdFirstImageRe.FindStringSubmatch(contentMd); m != nil && m[1] != "" {
		return m[1]
	}
	if m := htmlImgSrcRe.FindStringSubmatch(contentMd); m != nil && m[1] != "" {
		return m[1]
	}
	return ""
}

// BurnMeta GET /api/public/burn/meta?code=...。
func BurnMeta(c *gin.Context) {
	code, verr := validateBurnLinkCode(c.Query("code"))
	if verr != nil {
		httpx.HandleError(c, verr)
		return
	}
	ctx := c.Request.Context()
	link, err := loadBurnLinkByCode(ctx, code)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	c.Header("Cache-Control", burnNoStore)
	if link == nil {
		httpx.OK(c, map[string]any{"state": "NOT_FOUND", "requiresPassword": false, "coverImageUrl": nil})
		return
	}
	now := timeNow()
	state := resolveBurnLinkPublicState(link.status, link.expiresAt, now)

	var remaining int32
	if link.viewCount < link.maxViews {
		remaining = link.maxViews - link.viewCount
	}
	resp := map[string]any{
		"state":            state,
		"requiresPassword": strings.TrimSpace(derefStr(link.passwordHash)) != "",
		"remainingViews":   remaining,
		// 仅 ACTIVE 时给出封面图作为确认页的预览图；失效状态不暴露任何内容线索。
		"coverImageUrl": nil,
	}
	if state == "ACTIVE" {
		resp["coverImageUrl"] = resolvePublicCoverImageUrl(c, firstImageURLForArticle(ctx, link.articleID))
	}
	httpx.OK(c, resp)
}

// firstImageURLForArticle 读取正文并提取首图引用。
func firstImageURLForArticle(ctx context.Context, articleID int64) string {
	row := pool().QueryRow(ctx,
		`SELECT content_md FROM petrichor_kb_article WHERE id = $1 LIMIT 1`, articleID)
	var contentMd string
	if err := row.Scan(&contentMd); err != nil {
		return ""
	}
	return extractFirstImageUrl(contentMd)
}

// BurnConsume POST /api/public/burn/consume：先只读校验，再原子自增 + 达上限焚毁。
func BurnConsume(c *gin.Context) {
	raw, err := readBody(c)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	codeInput := rawString(raw, "code")
	if codeInput == "" {
		codeInput = rawString(raw, "linkCode")
	}
	code, verr := validateBurnLinkCode(codeInput)
	if verr != nil {
		httpx.HandleError(c, verr)
		return
	}
	accessPassword := rawString(raw, "accessPassword")
	if perr := validateAccessPassword(accessPassword); perr != nil {
		httpx.HandleError(c, perr)
		return
	}

	ctx := c.Request.Context()
	link, lerr := loadBurnLinkByCode(ctx, code)
	if lerr != nil {
		httpx.HandleError(c, lerr)
		return
	}
	if link == nil {
		httpx.HandleError(c, notFoundErr("链接不存在或已失效"))
		return
	}

	// 1) 只读校验（状态 / 过期 / 密码）——密码错误不消耗任何阅读次数。
	now := timeNow()
	state := resolveBurnLinkPublicState(link.status, link.expiresAt, now)
	switch state {
	case "REVOKED":
		httpx.ErrorJSON(c, 410, "该链接已被撤销")
		return
	case "BURNED":
		httpx.ErrorJSON(c, 410, "该链接为阅后即焚，已被销毁")
		return
	case "EXPIRED":
		httpx.ErrorJSON(c, 410, "该链接已过期")
		return
	}
	if hash := strings.TrimSpace(derefStr(link.passwordHash)); hash != "" {
		if strings.TrimSpace(accessPassword) == "" {
			httpx.HandleError(c, forbiddenErr("该链接需要访问密码"))
			return
		}
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(accessPassword)) != nil {
			httpx.HandleError(c, forbiddenErr("访问密码错误"))
			return
		}
	}

	// 2) 原子消费：view_count < max_views 守卫 + 行锁，保证并发下不超额；达上限即焚。
	var (
		consumedArticleID int64
		consumedViewCount int32
		consumedMaxViews  int32
		consumedStatus    string
	)
	cerr := pool().QueryRow(ctx,
		`UPDATE petrichor_kb_article_burn_link
		 SET view_count = view_count + 1,
		     status = CASE WHEN view_count + 1 >= max_views THEN 'BURNED' ELSE status END,
		     burned_at = CASE WHEN view_count + 1 >= max_views THEN now() ELSE burned_at END,
		     updated_at = $2
		 WHERE link_code = $1 AND status = 'ACTIVE'
		   AND (expires_at IS NULL OR expires_at > $2)
		   AND view_count < max_views
		 RETURNING article_id, view_count, max_views, status`,
		code, now).Scan(&consumedArticleID, &consumedViewCount, &consumedMaxViews, &consumedStatus)
	if errors.Is(cerr, pgx.ErrNoRows) {
		// 并发竞态：名额已被其他请求抢光 / 刚好被焚毁。
		httpx.ErrorJSON(c, 410, "该链接为阅后即焚，已被销毁")
		return
	}
	if cerr != nil {
		httpx.HandleError(c, cerr)
		return
	}

	// 3) 读取正文。
	article, aerr := loadArticleByID(ctx, consumedArticleID)
	if aerr != nil {
		httpx.HandleError(c, aerr)
		return
	}
	if article == nil {
		httpx.HandleError(c, notFoundErr("文章不存在"))
		return
	}
	resp, derr := buildPublicArticleDetailResponse(ctx, article, map[string]any{
		"isRepost":           false,
		"originalUrl":        nil,
		"originalAuthorName": nil,
	})
	if derr != nil {
		httpx.HandleError(c, derr)
		return
	}
	resp["burn"] = map[string]any{
		"viewCount": consumedViewCount,
		"maxViews":  consumedMaxViews,
		"burned":    consumedStatus == "BURNED",
	}
	c.Header("Cache-Control", burnNoStore)
	httpx.OK(c, resp)
}
