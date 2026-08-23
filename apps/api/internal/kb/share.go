// share.go 对照 share-handlers.ts 的分享管理端点（create/info/pin/revoke）。
package kb

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

var (
	expiresAtRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}(T| )\d{2}:\d{2}:\d{2}$`)
	shareCodeRe = regexp.MustCompile(`^[A-Za-z0-9_-]{10,64}$`)
	digits6Re   = regexp.MustCompile(`^\d{6}$`)
	httpURLRe   = regexp.MustCompile(`^https?://`)
)

// Go regexp 不支持负向前瞻，站内路径校验手工展开 `/` 开头、非 `//`、无空白。
func isInternalSitePath(v string) bool {
	trimmed := trimSpace(v)
	if !strings.HasPrefix(trimmed, "/") || strings.HasPrefix(trimmed, "//") {
		return false
	}
	return !strings.ContainsAny(trimmed, " \t\n\r")
}

// parseShareExpiresAt 对应 share-logic.ts 同名函数。
func parseShareExpiresAt(raw any) (*time.Time, error) {
	value := ""
	if raw != nil {
		value = trimSpace(toStr(raw))
	}
	if value == "" {
		return nil, nil
	}
	m := expiresAtRe.FindStringSubmatch(value)
	if m == nil {
		return nil, badReq("到期时间格式非法")
	}
	normalized := strings.Replace(value, " ", "T", 1)
	parsed, err := time.ParseInLocation("2006-01-02T15:04:05", normalized, time.Local)
	if err != nil {
		return nil, badReq("到期时间格式非法")
	}
	if !parsed.After(time.Now()) {
		return nil, badReq("到期时间必须晚于当前时间")
	}
	return &parsed, nil
}

func validateSharePassword(accessPassword string) error {
	password := trimSpace(accessPassword)
	if password != "" && !digits6Re.MatchString(password) {
		return badReq("访问密码格式非法")
	}
	return nil
}

// repostAttribution 对应 validatePublicShareRepostAttributionInput。
type repostAttribution struct {
	isRepost           bool
	originalURL        *string
	originalAuthorName *string
}

func validateRepostAttribution(raw map[string]any) (*repostAttribution, error) {
	const (
		maxOriginalURLLength        = 2048
		maxOriginalAuthorNameLength = 120
	)
	if rawBool(raw, "isRepost") != true {
		return &repostAttribution{}, nil
	}
	originalURL := trimmedString(raw, "originalUrl")
	authorName := trimmedString(raw, "originalAuthorName")
	if originalURL == "" {
		return nil, badReq("请填写原文链接")
	}
	if len(originalURL) > maxOriginalURLLength {
		return nil, badReq("原文链接长度不能超过 2048")
	}
	if !isHTTPURL(originalURL) {
		return nil, badReq("原文链接必须是有效的 http:// 或 https:// 地址")
	}
	if authorName == "" {
		return nil, badReq("请填写原作者名称")
	}
	if len([]rune(authorName)) > maxOriginalAuthorNameLength {
		return nil, badReq("原作者名称长度不能超过 120")
	}
	return &repostAttribution{
		isRepost:           true,
		originalURL:        &originalURL,
		originalAuthorName: &authorName,
	}, nil
}

func isHTTPURL(v string) bool { return httpURLRe.MatchString(v) }

// internalLink 对应 validatePublicShareInternalLinkInput。
func validateInternalLink(raw map[string]any) (*string, error) {
	const maxInternalURLLength = 2048
	if rawBool(raw, "isInternalLink") != true {
		return nil, nil
	}
	internalURL := trimmedString(raw, "internalUrl")
	if internalURL == "" {
		return nil, badReq("请填写内部链接")
	}
	if len(internalURL) > maxInternalURLLength {
		return nil, badReq("内部链接长度不能超过 2048")
	}
	if !isInternalSitePath(internalURL) {
		return nil, badReq("内部链接必须是以 / 开头的站内路径")
	}
	return &internalURL, nil
}

// buildRepostAttribution 对应 buildPublicShareRepostAttribution（读取态归一）。
func buildRepostAttribution(isRepost bool, originalURL, originalAuthorName *string) map[string]any {
	url := derefStr(originalURL)
	name := derefStr(originalAuthorName)
	if !isRepost || url == "" || name == "" {
		return map[string]any{"isRepost": false, "originalUrl": nil, "originalAuthorName": nil}
	}
	return map[string]any{"isRepost": true, "originalUrl": url, "originalAuthorName": name}
}

// buildInternalLink 对应 buildPublicShareInternalLink（读取态归一）。
func buildInternalLink(internalURL *string) map[string]any {
	url := derefStr(internalURL)
	if url == "" || !isInternalSitePath(url) {
		return map[string]any{"internalUrl": nil}
	}
	return map[string]any{"internalUrl": url}
}

// requireOwner 对应 share-handlers.ts 的 requireOwner：文章不存在 404，非属主 403。
func requireOwner(q execQuerier, userID, articleID int64) error {
	var ownerUserID int64
	err := q.QueryRow(context.Background(),
		`SELECT b.user_id FROM petrichor_kb_article a
		 JOIN petrichor_kb_node n ON n.id = a.node_id
		 JOIN petrichor_kb_knowledge_base b ON b.id = n.knowledge_base_id
		 WHERE a.id = $1 LIMIT 1`, articleID).Scan(&ownerUserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return notFoundErr("文章不存在")
		}
		return err
	}
	if ownerUserID != userID {
		return forbiddenErr("仅文档拥有者可执行该操作")
	}
	return nil
}

// resolvePublicPasswordHash 对应同名函数：密码开关与密码值组合出最终哈希。
func resolvePublicPasswordHash(existing *ShareRow, passwordEnabled *bool, accessPassword string) (*string, error) {
	password := trimSpace(accessPassword)
	existingHash := derefStr(existingPasswordHash(existing))
	if passwordEnabled != nil && !*passwordEnabled {
		return nil, nil
	}
	if passwordEnabled != nil && *passwordEnabled && password == "" && existingHash == "" {
		return nil, badReq("请填写 6 位访问密码")
	}
	if password == "" {
		if passwordEnabled != nil && *passwordEnabled && existingHash != "" {
			h := existingHash
			return &h, nil
		}
		return nil, nil
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 10)
	if err != nil {
		return nil, err
	}
	s := string(hash)
	return &s, nil
}

func existingPasswordHash(existing *ShareRow) *string {
	if existing == nil {
		return nil
	}
	return existing.PasswordHash
}

// loadShareByArticle 按文章取唯一分享记录（ux_petrichor_kb_article_share_article）。
func loadShareByArticle(q execQuerier, articleID int64) (*ShareRow, error) {
	rows, err := q.Query(context.Background(),
		`SELECT `+shareColumns+` FROM petrichor_kb_article_share WHERE article_id = $1 LIMIT 1`, articleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	return scanShareRows(rows)
}

func nullableIDPtr(v *int32) any {
	if v == nil {
		return nil
	}
	return int64(*v)
}

// CreateArticleShare 创建或恢复分享。
func CreateArticleShare(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		articleIDRaw := raw["articleId"]
		if articleIDRaw == nil || trimSpace(toStr(articleIDRaw)) == "" {
			return nil, badReq("文章ID不能为空")
		}
		articleID, err := reqID(articleIDRaw, "文章ID非法")
		if err != nil {
			return nil, err
		}
		expiresAt, err := parseShareExpiresAt(raw["expiresAt"])
		if err != nil {
			return nil, err
		}
		repost, err := validateRepostAttribution(raw)
		if err != nil {
			return nil, err
		}
		internalLink, err := validateInternalLink(raw)
		if err != nil {
			return nil, err
		}
		if repost.isRepost && internalLink != nil {
			return nil, badReq("内部链接和转载只能开启一个")
		}
		accessPassword := trimSpace(rawString(raw, "accessPassword"))
		if err := validateSharePassword(accessPassword); err != nil {
			return nil, err
		}
		q := pool()
		if err := requireOwner(q, user.ID, articleID); err != nil {
			return nil, err
		}
		existing, err := loadShareByArticle(q, articleID)
		if err != nil {
			return nil, err
		}

		var passwordEnabled *bool
		if v, ok := raw["passwordEnabled"]; ok && v != nil {
			b, isBool := v.(bool)
			if !isBool {
				return nil, badReq("passwordEnabled 非法")
			}
			passwordEnabled = &b
		}
		passwordHash, err := resolvePublicPasswordHash(existing, passwordEnabled, accessPassword)
		if err != nil {
			return nil, err
		}
		shareCode := ""
		if existing != nil && existing.Enabled && trimSpace(existing.ShareCode) != "" {
			shareCode = existing.ShareCode
		} else {
			code, cerr := generateCode()
			if cerr != nil {
				return nil, cerr
			}
			shareCode = code
		}

		var share *ShareRow
		if existing != nil {
			rows, uerr := q.Query(c,
				`UPDATE petrichor_kb_article_share SET share_code = $3, enabled = $4,
				 expires_at = $5, password_hash = $6, is_repost = $7, original_url = $8,
				 original_author_name = $9, internal_url = $10, revoked_at = NULL, updated_at = now()
				 WHERE id = $2 AND user_id = $1 RETURNING `+shareColumns,
				user.ID, existing.ID, shareCode, true, expiresAt, passwordHash,
				repost.isRepost, repost.originalURL, repost.originalAuthorName, internalLink)
			if uerr != nil {
				return nil, uerr
			}
			share, uerr = scanSingleShare(rows)
			if uerr != nil {
				return nil, uerr
			}
		} else {
			rows, ierr := q.Query(c,
				`INSERT INTO petrichor_kb_article_share (user_id, article_id, share_code, enabled,
				 expires_at, password_hash, is_repost, original_url, original_author_name, internal_url)
				 VALUES ($1,$2,$3,true,$4,$5,$6,$7,$8,$9) RETURNING `+shareColumns,
				user.ID, articleID, shareCode, expiresAt, passwordHash,
				repost.isRepost, repost.originalURL, repost.originalAuthorName, internalLink)
			if ierr != nil {
				return nil, ierr
			}
			share, ierr = scanSingleShare(rows)
			if ierr != nil {
				return nil, ierr
			}
		}

		invalidatePublicArticleListCache()
		invalidateSiteGraphCache()
		invalidatePublicArticleDetailCache(share.ShareCode)
		if existing != nil && existing.ShareCode != share.ShareCode {
			invalidatePublicArticleDetailCache(existing.ShareCode)
		}
		return buildShareCreateResponse(articleID, share), nil
	})
}

func scanSingleShare(rows interface {
	Next() bool
	Scan(dest ...any) error
	Close()
	Err() error
}) (*ShareRow, error) {
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	return scanShareRows(rows)
}

func invalidateSiteGraphCache() {
	cacheImpl.Drop("petrichor:public:site-graph")
}

func buildShareCreateResponse(articleID int64, share *ShareRow) map[string]any {
	resp := map[string]any{
		"articleId":   strconv.FormatInt(articleID, 10),
		"shareCode":   share.ShareCode,
		"enabled":     share.Enabled,
		"hasPassword": derefStr(share.PasswordHash) != "",
		"expiresAt":   isoPtr(share.ExpiresAt),
		"updatedAt":   iso(share.UpdatedAt),
	}
	for k, v := range buildRepostAttribution(share.IsRepost, share.OriginalURL, share.OriginalAuthorName) {
		resp[k] = v
	}
	for k, v := range buildInternalLink(share.InternalURL) {
		resp[k] = v
	}
	return resp
}

// RevokeArticleShare 撤销公开分享（幂等）。
func RevokeArticleShare(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		if raw["articleId"] == nil || trimSpace(toStr(raw["articleId"])) == "" {
			return nil, badReq("文章ID不能为空")
		}
		articleID, err := reqID(raw["articleId"], "文章ID非法")
		if err != nil {
			return nil, err
		}
		q := pool()
		if err := requireOwner(q, user.ID, articleID); err != nil {
			return nil, err
		}
		share, err := loadShareByArticle(q, articleID)
		if err != nil {
			return nil, err
		}
		if share == nil {
			return map[string]any{"articleId": strconv.FormatInt(articleID, 10), "enabled": false, "revokedAt": nil}, nil
		}
		if !share.Enabled {
			return map[string]any{
				"articleId": strconv.FormatInt(articleID, 10),
				"enabled":   false,
				"revokedAt": isoPtr(share.RevokedAt),
			}, nil
		}
		now := time.Now()
		if _, err := q.Exec(c,
			`UPDATE petrichor_kb_article_share SET enabled = false, revoked_at = $1, updated_at = $1
			 WHERE id = $2`, now, share.ID); err != nil {
			return nil, err
		}
		invalidatePublicArticleListCache()
		invalidateSiteGraphCache()
		invalidatePublicArticleDetailCache(share.ShareCode)
		return map[string]any{
			"articleId": strconv.FormatInt(articleID, 10),
			"enabled":   false,
			"revokedAt": iso(now),
		}, nil
	})
}

// ArticleShareInfo 分享状态查询（未创建时返回默认关闭形态）。
func ArticleShareInfo(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		if raw["articleId"] == nil || trimSpace(toStr(raw["articleId"])) == "" {
			return nil, badReq("文章ID不能为空")
		}
		articleID, err := reqID(raw["articleId"], "文章ID非法")
		if err != nil {
			return nil, err
		}
		q := pool()
		if err := requireOwner(q, user.ID, articleID); err != nil {
			return nil, err
		}
		share, err := loadShareByArticle(q, articleID)
		if err != nil {
			return nil, err
		}
		if share == nil {
			resp := map[string]any{
				"articleId":   strconv.FormatInt(articleID, 10),
				"shareCode":   nil,
				"enabled":     false,
				"hasPassword": false,
				"expiresAt":   nil,
				"pinOrder":    nil,
				"isPinned":    false,
				"updatedAt":   nil,
			}
			for k, v := range buildRepostAttribution(false, nil, nil) {
				resp[k] = v
			}
			for k, v := range buildInternalLink(nil) {
				resp[k] = v
			}
			return resp, nil
		}

		resp := map[string]any{
			"articleId":   strconv.FormatInt(articleID, 10),
			"shareCode":   nil,
			"enabled":     share.Enabled,
			"hasPassword": derefStr(share.PasswordHash) != "",
			"expiresAt":   isoPtr(share.ExpiresAt),
			"pinOrder":    nullableIDPtr(share.PinOrder),
			"isPinned":    share.PinOrder != nil,
			"updatedAt":   iso(share.UpdatedAt),
		}
		if share.Enabled && trimSpace(share.ShareCode) != "" {
			resp["shareCode"] = share.ShareCode
		}
		for k, v := range buildRepostAttribution(share.IsRepost, share.OriginalURL, share.OriginalAuthorName) {
			resp[k] = v
		}
		for k, v := range buildInternalLink(share.InternalURL) {
			resp[k] = v
		}
		return resp, nil
	})
}

// SetArticleSharePin 置顶 / 取消置顶。
func SetArticleSharePin(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		if raw["articleId"] == nil || trimSpace(toStr(raw["articleId"])) == "" {
			return nil, badReq("文章ID不能为空")
		}
		articleID, err := reqID(raw["articleId"], "文章ID非法")
		if err != nil {
			return nil, err
		}
		const maxPinOrder = 1_000_000
		var pinOrder *int32
		if v, ok := raw["pinOrder"]; ok && v != nil {
			text := trimSpace(toStr(v))
			if text != "" {
				n, perr := strconv.Atoi(text)
				if perr != nil {
					return nil, badReq("置顶排序值非法")
				}
				if n < 0 || n > maxPinOrder {
					return nil, badReq("置顶排序值必须在 0 到 1000000 之间")
				}
				pinOrder = ptrInt32(int32(n))
			}
		}
		q := pool()
		if err := requireOwner(q, user.ID, articleID); err != nil {
			return nil, err
		}
		share, err := loadShareByArticle(q, articleID)
		if err != nil {
			return nil, err
		}
		if share == nil {
			return nil, notFoundErr("文章尚未公开,无法置顶")
		}
		if !share.Enabled || share.RevokedAt != nil {
			return nil, badReq("文章未处于公开状态,无法置顶")
		}
		now := time.Now()
		updated, err := updateShareReturning(q,
			`UPDATE petrichor_kb_article_share SET pin_order = $1, updated_at = $2 WHERE id = $3 RETURNING `+shareColumns,
			pinOrder, now, share.ID)
		if err != nil {
			return nil, err
		}
		invalidatePublicArticleListCache()
		invalidateSiteGraphCache()
		invalidatePublicArticleDetailCache(updated.ShareCode)
		return map[string]any{
			"articleId": strconv.FormatInt(articleID, 10),
			"pinOrder":  nullableIDPtr(updated.PinOrder),
			"isPinned":  updated.PinOrder != nil,
			"updatedAt": iso(updated.UpdatedAt),
		}, nil
	})
}

func ptrInt32(v int32) *int32 { return &v }

func updateShareReturning(q execQuerier, sql string, args ...any) (*ShareRow, error) {
	rows, err := q.Query(context.Background(), sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	return scanShareRows(rows)
}
