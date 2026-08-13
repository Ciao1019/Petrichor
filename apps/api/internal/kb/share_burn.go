package kb

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticleburnlink"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticleshare"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

const burnMaxViewsLimit = 100

var sixDigitPasswordRE = regexp.MustCompile(`^\d{6}$`)

func randomCode(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func parseOptionalExpiry(raw *string) (*time.Time, error) {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil, nil
	}
	value := strings.TrimSpace(*raw)
	var parsed time.Time
	var err error
	for _, layout := range []string{"2006-01-02T15:04:05", "2006-01-02 15:04:05", time.RFC3339} {
		if layout == time.RFC3339 {
			parsed, err = time.Parse(layout, value)
		} else {
			parsed, err = time.ParseInLocation(layout, value, time.Local)
		}
		if err == nil {
			break
		}
	}
	if err != nil {
		return nil, response.BadRequest("到期时间格式非法")
	}
	if !parsed.After(time.Now()) {
		return nil, response.BadRequest("到期时间必须晚于当前时间")
	}
	parsed = parsed.UTC()
	return &parsed, nil
}

func validateAccessPassword(value string) error {
	value = strings.TrimSpace(value)
	if value != "" && !sixDigitPasswordRE.MatchString(value) {
		return response.BadRequest("访问密码格式非法")
	}
	return nil
}

func validHTTPURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != ""
}

type shareCreateRequest struct {
	ArticleID          string  `json:"articleId" binding:"required"`
	PasswordEnabled    *bool   `json:"passwordEnabled"`
	AccessPassword     string  `json:"accessPassword"`
	ExpiresAt          *string `json:"expiresAt"`
	IsRepost           *bool   `json:"isRepost"`
	OriginalURL        *string `json:"originalUrl"`
	OriginalAuthorName *string `json:"originalAuthorName"`
	IsInternalLink     *bool   `json:"isInternalLink"`
	InternalURL        *string `json:"internalUrl"`
}

func (h *Handler) CreateShare(c *gin.Context) {
	var req shareCreateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	articleID, err := parsePositiveID(req.ArticleID, "articleId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	if err := validateAccessPassword(req.AccessPassword); err != nil {
		response.Fail(c, err)
		return
	}
	expiresAt, err := parseOptionalExpiry(req.ExpiresAt)
	if err != nil {
		response.Fail(c, err)
		return
	}
	isRepost := req.IsRepost != nil && *req.IsRepost
	originalURL := strings.TrimSpace(stringValue(req.OriginalURL))
	originalAuthor := strings.TrimSpace(stringValue(req.OriginalAuthorName))
	if isRepost {
		if originalURL == "" || !validHTTPURL(originalURL) {
			response.Fail(c, response.BadRequest("原文链接必须是有效的 http:// 或 https:// 地址"))
			return
		}
		if len(originalURL) > 2048 {
			response.Fail(c, response.BadRequest("原文链接长度不能超过 2048"))
			return
		}
		if originalAuthor == "" || len([]rune(originalAuthor)) > 120 {
			response.Fail(c, response.BadRequest("请填写不超过 120 个字符的原作者名称"))
			return
		}
	}
	internalURL := strings.TrimSpace(stringValue(req.InternalURL))
	isInternal := req.IsInternalLink != nil && *req.IsInternalLink
	if isInternal && (internalURL == "" || !strings.HasPrefix(internalURL, "/") || strings.HasPrefix(internalURL, "//") || strings.ContainsAny(internalURL, " \t\r\n")) {
		response.Fail(c, response.BadRequest("内部链接必须是以 / 开头的站内路径"))
		return
	}
	if isRepost && isInternal {
		response.Fail(c, response.BadRequest("内部链接和转载只能开启一个"))
		return
	}
	u := auth.MustUser(c)
	if _, err := h.svc.loadOwnedArticle(c.Request.Context(), u.ID, articleID); err != nil {
		response.Fail(c, err)
		return
	}
	existing, err := h.svc.client.KBArticleShare.Query().Where(kbarticleshare.ArticleIDEQ(articleID)).Only(c.Request.Context())
	if err != nil && !ent.IsNotFound(err) {
		response.Fail(c, err)
		return
	}
	if ent.IsNotFound(err) {
		existing = nil
	}
	passwordHash, err := resolveSharePasswordHash(existing, req.PasswordEnabled, strings.TrimSpace(req.AccessPassword))
	if err != nil {
		response.Fail(c, err)
		return
	}
	shareCode := ""
	if existing != nil && existing.Enabled && strings.TrimSpace(existing.ShareCode) != "" {
		shareCode = existing.ShareCode
	} else if shareCode, err = randomCode(18); err != nil {
		response.Fail(c, err)
		return
	}
	now := time.Now().UTC()
	var share *ent.KBArticleShare
	if existing == nil {
		builder := h.svc.client.KBArticleShare.Create().
			SetUserID(u.ID).
			SetArticleID(articleID).
			SetShareCode(shareCode).
			SetEnabled(true).
			SetIsRepost(isRepost).
			SetUpdatedAt(now)
		if expiresAt != nil {
			builder.SetExpiresAt(*expiresAt)
		}
		if passwordHash != nil {
			builder.SetPasswordHash(*passwordHash)
		}
		if isRepost {
			builder.SetOriginalURL(originalURL).SetOriginalAuthorName(originalAuthor)
		}
		if isInternal {
			builder.SetInternalURL(internalURL)
		}
		share, err = builder.Save(c.Request.Context())
	} else {
		builder := existing.Update().
			SetUserID(u.ID).
			SetShareCode(shareCode).
			SetEnabled(true).
			SetIsRepost(isRepost).
			ClearRevokedAt().
			SetUpdatedAt(now)
		if expiresAt == nil {
			builder.ClearExpiresAt()
		} else {
			builder.SetExpiresAt(*expiresAt)
		}
		if passwordHash == nil {
			builder.ClearPasswordHash()
		} else {
			builder.SetPasswordHash(*passwordHash)
		}
		if isRepost {
			builder.SetOriginalURL(originalURL).SetOriginalAuthorName(originalAuthor)
		} else {
			builder.ClearOriginalURL().ClearOriginalAuthorName()
		}
		if isInternal {
			builder.SetInternalURL(internalURL)
		} else {
			builder.ClearInternalURL()
		}
		share, err = builder.Save(c.Request.Context())
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, buildShareResponse(articleID, share, true))
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func resolveSharePasswordHash(existing *ent.KBArticleShare, enabled *bool, password string) (*string, error) {
	if enabled != nil && !*enabled {
		return nil, nil
	}
	if enabled != nil && *enabled && password == "" && (existing == nil || existing.PasswordHash == nil || strings.TrimSpace(*existing.PasswordHash) == "") {
		return nil, response.BadRequest("请填写 6 位访问密码")
	}
	if password == "" {
		if enabled != nil && *enabled && existing != nil {
			return existing.PasswordHash, nil
		}
		return nil, nil
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 10)
	if err != nil {
		return nil, err
	}
	value := string(hash)
	return &value, nil
}

func buildShareResponse(articleID int64, share *ent.KBArticleShare, includeCode bool) gin.H {
	result := gin.H{
		"articleId":          fmt.Sprintf("%d", articleID),
		"enabled":            share.Enabled,
		"hasPassword":        share.PasswordHash != nil && strings.TrimSpace(*share.PasswordHash) != "",
		"expiresAt":          formatTimePtr(share.ExpiresAt),
		"isRepost":           share.IsRepost && share.OriginalURL != nil && share.OriginalAuthorName != nil,
		"originalUrl":        nil,
		"originalAuthorName": nil,
		"internalUrl":        nil,
		"updatedAt":          share.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
	if includeCode && share.Enabled && strings.TrimSpace(share.ShareCode) != "" {
		result["shareCode"] = share.ShareCode
	} else {
		result["shareCode"] = nil
	}
	if result["isRepost"].(bool) {
		result["originalUrl"] = strings.TrimSpace(*share.OriginalURL)
		result["originalAuthorName"] = strings.TrimSpace(*share.OriginalAuthorName)
	}
	if share.InternalURL != nil && strings.HasPrefix(strings.TrimSpace(*share.InternalURL), "/") {
		result["internalUrl"] = strings.TrimSpace(*share.InternalURL)
	}
	return result
}

func (h *Handler) ShareInfo(c *gin.Context) {
	articleID, user, ok := h.bindOwnedArticleID(c)
	if !ok {
		return
	}
	share, err := h.svc.client.KBArticleShare.Query().Where(
		kbarticleshare.ArticleIDEQ(articleID),
		kbarticleshare.UserIDEQ(user.ID),
	).Only(c.Request.Context())
	if ent.IsNotFound(err) {
		response.OK(c, gin.H{
			"articleId": fmt.Sprintf("%d", articleID), "shareCode": nil, "enabled": false,
			"hasPassword": false, "expiresAt": nil, "isRepost": false, "originalUrl": nil,
			"originalAuthorName": nil, "internalUrl": nil, "pinOrder": nil, "isPinned": false, "updatedAt": nil,
		})
		return
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	result := buildShareResponse(articleID, share, true)
	result["pinOrder"] = share.PinOrder
	result["isPinned"] = share.PinOrder != nil
	response.OK(c, result)
}

func (h *Handler) RevokeShare(c *gin.Context) {
	articleID, user, ok := h.bindOwnedArticleID(c)
	if !ok {
		return
	}
	share, err := h.svc.client.KBArticleShare.Query().Where(
		kbarticleshare.ArticleIDEQ(articleID),
		kbarticleshare.UserIDEQ(user.ID),
	).Only(c.Request.Context())
	if ent.IsNotFound(err) {
		response.OK(c, gin.H{"articleId": fmt.Sprintf("%d", articleID), "enabled": false, "revokedAt": nil})
		return
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	if !share.Enabled {
		response.OK(c, gin.H{"articleId": fmt.Sprintf("%d", articleID), "enabled": false, "revokedAt": formatTimePtr(share.RevokedAt)})
		return
	}
	now := time.Now().UTC()
	if _, err := share.Update().SetEnabled(false).SetRevokedAt(now).SetUpdatedAt(now).Save(c.Request.Context()); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"articleId": fmt.Sprintf("%d", articleID), "enabled": false, "revokedAt": now.Format(time.RFC3339Nano)})
}

func (h *Handler) bindOwnedArticleID(c *gin.Context) (int64, *ent.User, bool) {
	var req struct {
		ArticleID string `json:"articleId" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return 0, nil, false
	}
	articleID, err := parsePositiveID(req.ArticleID, "articleId")
	if err != nil {
		response.Fail(c, err)
		return 0, nil, false
	}
	u := auth.MustUser(c)
	if _, err := h.svc.loadOwnedArticle(c.Request.Context(), u.ID, articleID); err != nil {
		response.Fail(c, err)
		return 0, nil, false
	}
	return articleID, u, true
}

func (h *Handler) SharePin(c *gin.Context) {
	var req struct {
		ArticleID string `json:"articleId" binding:"required"`
		PinOrder  *int   `json:"pinOrder"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	articleID, err := parsePositiveID(req.ArticleID, "articleId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	if req.PinOrder != nil && (*req.PinOrder < 0 || *req.PinOrder > 1_000_000) {
		response.Fail(c, response.BadRequest("置顶排序值必须在 0 到 1000000 之间"))
		return
	}
	u := auth.MustUser(c)
	if _, err := h.svc.loadOwnedArticle(c.Request.Context(), u.ID, articleID); err != nil {
		response.Fail(c, err)
		return
	}
	share, err := h.svc.client.KBArticleShare.Query().Where(
		kbarticleshare.ArticleIDEQ(articleID), kbarticleshare.UserIDEQ(u.ID),
	).Only(c.Request.Context())
	if ent.IsNotFound(err) {
		response.Fail(c, response.NotFound("文章尚未公开,无法置顶"))
		return
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	if !share.Enabled || share.RevokedAt != nil {
		response.Fail(c, response.BadRequest("文章未处于公开状态,无法置顶"))
		return
	}
	now := time.Now().UTC()
	update := share.Update().SetUpdatedAt(now)
	if req.PinOrder == nil {
		update.ClearPinOrder()
	} else {
		update.SetPinOrder(*req.PinOrder)
	}
	updated, err := update.Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{
		"articleId": fmt.Sprintf("%d", articleID), "pinOrder": updated.PinOrder,
		"isPinned": updated.PinOrder != nil, "updatedAt": updated.UpdatedAt.UTC().Format(time.RFC3339Nano),
	})
}

type burnCreateRequest struct {
	ArticleID       string  `json:"articleId" binding:"required"`
	MaxViews        *int    `json:"maxViews"`
	PasswordEnabled *bool   `json:"passwordEnabled"`
	AccessPassword  string  `json:"accessPassword"`
	ExpiresAt       *string `json:"expiresAt"`
}

func buildBurnLinkResponse(link *ent.KBArticleBurnLink) gin.H {
	return gin.H{
		"id": fmt.Sprintf("%d", link.ID), "articleId": fmt.Sprintf("%d", link.ArticleID),
		"linkCode": link.LinkCode, "maxViews": link.MaxViews, "viewCount": link.ViewCount,
		"hasPassword": link.PasswordHash != nil && strings.TrimSpace(*link.PasswordHash) != "",
		"expiresAt":   formatTimePtr(link.ExpiresAt), "status": link.Status,
		"burnedAt": formatTimePtr(link.BurnedAt), "revokedAt": formatTimePtr(link.RevokedAt),
		"createdAt": link.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func (h *Handler) CreateBurnLink(c *gin.Context) {
	var req burnCreateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	articleID, err := parsePositiveID(req.ArticleID, "articleId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	maxViews := 1
	if req.MaxViews != nil {
		maxViews = *req.MaxViews
	}
	if maxViews < 1 || maxViews > burnMaxViewsLimit {
		response.Fail(c, response.BadRequest("访问次数必须在 1 到 100 之间"))
		return
	}
	if err := validateAccessPassword(req.AccessPassword); err != nil {
		response.Fail(c, err)
		return
	}
	passwordEnabled := req.PasswordEnabled != nil && *req.PasswordEnabled
	password := strings.TrimSpace(req.AccessPassword)
	if passwordEnabled && password == "" {
		response.Fail(c, response.BadRequest("请填写 6 位访问密码"))
		return
	}
	expiresAt, err := parseOptionalExpiry(req.ExpiresAt)
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	if _, err := h.svc.loadOwnedArticle(c.Request.Context(), u.ID, articleID); err != nil {
		response.Fail(c, err)
		return
	}
	code, err := randomCode(18)
	if err != nil {
		response.Fail(c, err)
		return
	}
	builder := h.svc.client.KBArticleBurnLink.Create().
		SetUserID(u.ID).SetArticleID(articleID).SetLinkCode(code).
		SetMaxViews(maxViews).SetViewCount(0).SetStatus("ACTIVE")
	if passwordEnabled {
		hash, err := bcrypt.GenerateFromPassword([]byte(password), 10)
		if err != nil {
			response.Fail(c, err)
			return
		}
		builder.SetPasswordHash(string(hash))
	}
	if expiresAt != nil {
		builder.SetExpiresAt(*expiresAt)
	}
	link, err := builder.Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, buildBurnLinkResponse(link))
}

func (h *Handler) ListBurnLinks(c *gin.Context) {
	articleID, user, ok := h.bindOwnedArticleID(c)
	if !ok {
		return
	}
	rows, err := h.svc.client.KBArticleBurnLink.Query().Where(
		kbarticleburnlink.ArticleIDEQ(articleID), kbarticleburnlink.UserIDEQ(user.ID),
	).Order(ent.Desc(kbarticleburnlink.FieldCreatedAt), ent.Desc(kbarticleburnlink.FieldID)).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	items := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		items = append(items, buildBurnLinkResponse(row))
	}
	response.OK(c, gin.H{"items": items})
}

func (h *Handler) RevokeBurnLink(c *gin.Context) {
	var req struct {
		ID string `json:"id" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := parsePositiveID(req.ID, "id")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	link, err := h.svc.client.KBArticleBurnLink.Query().Where(
		kbarticleburnlink.IDEQ(id), kbarticleburnlink.UserIDEQ(u.ID),
	).Only(c.Request.Context())
	if ent.IsNotFound(err) {
		response.Fail(c, response.NotFound("链接不存在"))
		return
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	if link.Status != "REVOKED" {
		now := time.Now().UTC()
		link, err = link.Update().SetStatus("REVOKED").SetRevokedAt(now).Save(c.Request.Context())
		if err != nil {
			response.Fail(c, err)
			return
		}
	}
	response.OK(c, buildBurnLinkResponse(link))
}
