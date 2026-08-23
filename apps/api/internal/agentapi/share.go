// share.go 对照 handlers.ts：share create/info/revoke（Agent 变体，不含转载/内部链接字段）。
package agentapi

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"regexp"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"

	"petrichor/api/internal/kb"
)

var sixDigitPasswordRe = regexp.MustCompile(`^\d{6}$`)

// generateShareCode 对应 randomBytes(18).toString("base64url")。
func generateShareCode() (string, error) {
	buf := make([]byte, 18)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

type shareLite struct {
	id           int64
	articleID    int64
	shareCode    string
	enabled      bool
	expiresAt    *time.Time
	passwordHash *string
	isRepost     bool
	originalURL  *string
	originalName *string
	revokedAt    *time.Time
	updatedAt    time.Time
}

const shareLiteColumns = `id, article_id, share_code, enabled, expires_at, password_hash,
	is_repost, original_url, original_author_name, revoked_at, updated_at`

func scanShareLite(row interface{ Scan(dest ...any) error }) (*shareLite, error) {
	var s shareLite
	if err := row.Scan(&s.id, &s.articleID, &s.shareCode, &s.enabled, &s.expiresAt,
		&s.passwordHash, &s.isRepost, &s.originalURL, &s.originalName,
		&s.revokedAt, &s.updatedAt); err != nil {
		return nil, err
	}
	return &s, nil
}

func loadShareByArticle(q querierLike, articleID int64) (*shareLite, error) {
	row := q.QueryRow(context.Background(),
		`SELECT `+shareLiteColumns+` FROM petrichor_kb_article_share WHERE article_id = $1 LIMIT 1`,
		articleID)
	share, err := scanShareLite(row)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return share, nil
}

// parseAgentShareExpiresAt 对照 handlers.ts 同名函数。
func parseAgentShareExpiresAt(value *string) (*time.Time, error) {
	text := ""
	if value != nil {
		text = trimSpaceCopy(*value)
	}
	if text == "" {
		return nil, nil
	}
	date, err := time.Parse(time.RFC3339, text)
	if err != nil {
		return nil, badReq("expiresAt 必须是合法 ISO 8601 时间，例如 2026-12-31T23:59:59Z")
	}
	if !date.After(time.Now()) {
		return nil, badReq("expiresAt 必须晚于当前时间")
	}
	return &date, nil
}

// resolveAgentSharePasswordHash 对照 handlers.ts resolveAgentSharePasswordHash。
func resolveAgentSharePasswordHash(existing *shareLite, passwordEnabled *bool, accessPassword string) (*string, error) {
	if passwordEnabled != nil && !*passwordEnabled {
		return nil, nil
	}
	hasExistingPassword := existing != nil && existing.passwordHash != nil && trimSpaceCopy(*existing.passwordHash) != ""
	if passwordEnabled != nil && *passwordEnabled && accessPassword == "" && !hasExistingPassword {
		return nil, badReq("启用密码时必须提供 accessPassword（6 位数字）")
	}
	if accessPassword == "" {
		if passwordEnabled != nil && *passwordEnabled && hasExistingPassword {
			return existing.passwordHash, nil
		}
		return nil, nil
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(accessPassword), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}
	s := string(hash)
	return &s, nil
}

// toAgentShareResponse 对照 handlers.ts toAgentShareResponse。
func toAgentShareResponse(share *shareLite) map[string]any {
	isRepost := false
	var originalURL, originalAuthorName any
	if share.isRepost {
		url := trimSpaceCopy(derefPtr(share.originalURL))
		name := trimSpaceCopy(derefPtr(share.originalName))
		if url != "" && name != "" {
			isRepost = true
			originalURL = url
			originalAuthorName = name
		}
	}
	hasPassword := false
	if share.passwordHash != nil && trimSpaceCopy(*share.passwordHash) != "" {
		hasPassword = true
	}
	resp := map[string]any{
		"articleId":          idStr(share.articleID),
		"shareCode":          share.shareCode,
		"shareUrl":           "/p/" + share.shareCode,
		"enabled":            share.enabled,
		"hasPassword":        hasPassword,
		"expiresAt":          isoPtr(share.expiresAt),
		"updatedAt":          iso(share.updatedAt),
		"isRepost":           isRepost,
		"originalUrl":        originalURL,
		"originalAuthorName": originalAuthorName,
	}
	return resp
}

// AgentShareCreate POST /api/agent/article/share/create（scope share:write）。
func AgentShareCreate(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "share:write"); err != nil {
		return nil, err
	}
	raw, err := readBodyMap(c)
	if err != nil {
		return nil, err
	}
	articleID, err := reqID(raw["articleId"], "ID 必须是正整数")
	if err != nil {
		return nil, err
	}
	q := dbPool()
	ctx := context.Background()
	if _, err := loadOwnedArticle(q, actx.UserID, articleID); err != nil {
		return nil, err
	}

	existing, err := loadShareByArticle(q, articleID)
	if err != nil {
		return nil, err
	}

	var expiresAtInput *string
	if v, ok := raw["expiresAt"]; ok && v != nil {
		s, _ := v.(string)
		expiresAtInput = &s
	}
	expiresAt, err := parseAgentShareExpiresAt(expiresAtInput)
	if err != nil {
		return nil, err
	}
	passwordEnabled := boolPtr(raw, "passwordEnabled")
	accessPassword := trimSpaceCopy(rawStringOrEmpty(raw, "accessPassword"))
	if accessPassword != "" && !sixDigitPasswordRe.MatchString(accessPassword) {
		return nil, badReq("访问密码必须是 6 位数字")
	}
	passwordHash, err := resolveAgentSharePasswordHash(existing, passwordEnabled, accessPassword)
	if err != nil {
		return nil, err
	}
	shareCode := ""
	if existing != nil && existing.enabled && trimSpaceCopy(existing.shareCode) != "" {
		shareCode = existing.shareCode
	} else {
		code, gerr := generateShareCode()
		if gerr != nil {
			return nil, gerr
		}
		shareCode = code
	}

	var share *shareLite
	if existing != nil {
		rows, uerr := q.Query(ctx,
			`UPDATE petrichor_kb_article_share SET share_code = $3, enabled = true, expires_at = $4,
			 password_hash = $5, revoked_at = NULL, updated_at = now()
			 WHERE id = $2 AND user_id = $1 RETURNING `+shareLiteColumns,
			actx.UserID, existing.id, shareCode, expiresAt, passwordHash)
		if uerr != nil {
			return nil, uerr
		}
		defer rows.Close()
		if rows.Next() {
			share, err = scanShareLite(rows)
			if err != nil {
				return nil, err
			}
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	} else {
		rows, ierr := q.Query(ctx,
			`INSERT INTO petrichor_kb_article_share (user_id, article_id, share_code, enabled, expires_at, password_hash)
			 VALUES ($1,$2,$3,true,$4,$5) RETURNING `+shareLiteColumns,
			actx.UserID, articleID, shareCode, expiresAt, passwordHash)
		if ierr != nil {
			return nil, ierr
		}
		defer rows.Close()
		if rows.Next() {
			share, err = scanShareLite(rows)
			if err != nil {
				return nil, err
			}
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	if share == nil {
		return nil, badReq("分享创建失败")
	}

	kb.InvalidatePublicArticleCaches(share.shareCode)
	if existing != nil && existing.shareCode != share.shareCode {
		kb.InvalidatePublicArticleCaches(existing.shareCode)
	}
	return toAgentShareResponse(share), nil
}

// AgentShareRevoke POST /api/agent/article/share/revoke（scope share:write）。
func AgentShareRevoke(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "share:write"); err != nil {
		return nil, err
	}
	raw, err := readBodyMap(c)
	if err != nil {
		return nil, err
	}
	articleID, err := reqID(raw["articleId"], "ID 必须是正整数")
	if err != nil {
		return nil, err
	}
	q := dbPool()
	ctx := context.Background()
	if _, err := loadOwnedArticle(q, actx.UserID, articleID); err != nil {
		return nil, err
	}

	share, err := loadShareByArticle(q, articleID)
	if err != nil {
		return nil, err
	}
	if share == nil {
		return map[string]any{
			"articleId": idStr(articleID),
			"enabled":   false,
			"revokedAt": nil,
		}, nil
	}
	if !share.enabled {
		return map[string]any{
			"articleId": idStr(articleID),
			"enabled":   false,
			"revokedAt": isoPtr(share.revokedAt),
		}, nil
	}

	revokedAt := time.Now()
	if _, err := q.Exec(ctx,
		`UPDATE petrichor_kb_article_share SET enabled = false, revoked_at = $1, updated_at = $1
		 WHERE id = $2`, revokedAt, share.id); err != nil {
		return nil, err
	}
	kb.InvalidatePublicArticleCaches(share.shareCode)
	return map[string]any{
		"articleId": idStr(articleID),
		"enabled":   false,
		"revokedAt": iso(revokedAt),
	}, nil
}

// AgentShareInfo POST /api/agent/article/share/info（scope share:write）。
func AgentShareInfo(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "share:write"); err != nil {
		return nil, err
	}
	raw, err := readBodyMap(c)
	if err != nil {
		return nil, err
	}
	articleID, err := reqID(raw["articleId"], "ID 必须是正整数")
	if err != nil {
		return nil, err
	}
	q := dbPool()
	if _, err := loadOwnedArticle(q, actx.UserID, articleID); err != nil {
		return nil, err
	}

	share, err := loadShareByArticle(q, articleID)
	if err != nil {
		return nil, err
	}
	if share == nil {
		return map[string]any{
			"articleId":   idStr(articleID),
			"shareCode":   nil,
			"shareUrl":    nil,
			"enabled":     false,
			"hasPassword": false,
			"expiresAt":   nil,
			"updatedAt":   nil,
		}, nil
	}
	resp := toAgentShareResponse(share)
	if !(share.enabled && trimSpaceCopy(share.shareCode) != "") {
		resp["shareCode"] = nil
		resp["shareUrl"] = nil
	}
	return resp, nil
}
