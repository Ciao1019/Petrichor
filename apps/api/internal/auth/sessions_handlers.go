// 自建会话管理：列出/下线 petrichor_auth_session 会话（2FA 已移除，无需 TOTP）。
package auth

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

const petrichorSessionColumns = `id, token_hash, device_info, ip, user_agent, last_seen_at, expires_at, created_at, updated_at`

type petrichorSessionRow struct {
	id         int64
	tokenHash  string
	deviceInfo *string
	ip         *string
	userAgent  *string
	lastSeenAt *time.Time
	expiresAt  time.Time
	createdAt  time.Time
	updatedAt  time.Time
}

func scanPetrichorSessionRow(row interface{ Scan(dest ...any) error }) (*petrichorSessionRow, error) {
	var s petrichorSessionRow
	err := row.Scan(&s.id, &s.tokenHash, &s.deviceInfo, &s.ip, &s.userAgent,
		&s.lastSeenAt, &s.expiresAt, &s.createdAt, &s.updatedAt)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (s *petrichorSessionRow) toListItem(currentHash *string) gin.H {
	idStr := strconv.FormatInt(s.id, 10)
	isCurrent := currentHash != nil && s.tokenHash == *currentHash
	return gin.H{
		"id":         idStr,
		"deviceInfo": s.deviceInfo,
		"ip":         s.ip,
		"userAgent":  s.userAgent,
		"lastSeenAt": formatNullableTime(s.lastSeenAt),
		"expiresAt":  httpx.FormatISO(s.expiresAt),
		"createdAt":  httpx.FormatISO(s.createdAt),
		"updatedAt":  httpx.FormatISO(s.updatedAt),
		"current":    isCurrent,
	}
}

func formatNullableTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.FormatISO(*t)
}

func currentTokenHash(c *gin.Context) *string {
	token := getSessionTokenRaw(c)
	if token == "" {
		return nil
	}
	hash := HashSessionToken(token)
	return &hash
}

// ListSessions GET /api/auth/sessions：当前用户的有效自建会话，current 标记 token_hash 命中项。
func ListSessions(c *gin.Context) {
	user := CurrentUser(c)
	currentHash := currentTokenHash(c)

	rows, err := db.Pool().Query(ctx(),
		`SELECT `+petrichorSessionColumns+` FROM petrichor_auth_session
		 WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
		 ORDER BY updated_at DESC`, user.ID)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	defer rows.Close()

	sessions := make([]gin.H, 0, 4)
	var currentSessionID *string
	for rows.Next() {
		s, serr := scanPetrichorSessionRow(rows)
		if serr != nil {
			httpx.HandleError(c, serr)
			return
		}
		item := s.toListItem(currentHash)
		if item["current"] == true {
			id := item["id"].(string)
			currentSessionID = &id
		}
		sessions = append(sessions, item)
	}
	if rerr := rows.Err(); rerr != nil {
		httpx.HandleError(c, rerr)
		return
	}

	httpx.OK(c, gin.H{
		"sessions":         sessions,
		"currentSessionId": currentSessionID,
		"twoFactorEnabled": false, // 2FA 已移除，恒 false
	})
}

// RevokeSession POST /api/auth/sessions/revoke {id}。
func RevokeSession(c *gin.Context) {
	user := CurrentUser(c)

	var body struct {
		ID httpx.FlexID `json:"id"`
	}
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	sessionID := body.ID.Int64()

	bg := context.Background()
	target, terr := scanPetrichorSessionRow(db.Pool().QueryRow(bg,
		`SELECT `+petrichorSessionColumns+` FROM petrichor_auth_session
		 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL LIMIT 1`, sessionID, user.ID))
	if terr != nil {
		if errors.Is(terr, pgx.ErrNoRows) {
			httpx.ErrorJSON(c, http.StatusNotFound, "会话不存在或已下线")
			return
		}
		httpx.HandleError(c, terr)
		return
	}
	if currentHash := currentTokenHash(c); currentHash != nil && target.tokenHash == *currentHash {
		httpx.ErrorJSON(c, http.StatusBadRequest, "不能下线当前登录的会话")
		return
	}

	if _, uerr := db.Pool().Exec(bg,
		`UPDATE petrichor_auth_session SET revoked_at = now(), updated_at = now()
		 WHERE id = $1 AND user_id = $2`, sessionID, user.ID); uerr != nil {
		httpx.HandleError(c, uerr)
		return
	}
	httpx.OK(c, gin.H{"success": true})
}

// RevokeOtherSessions POST /api/auth/sessions/revoke-others：下线除当前登录外的所有自建会话。
func RevokeOtherSessions(c *gin.Context) {
	user := CurrentUser(c)
	currentHash := currentTokenHash(c)
	if currentHash == nil {
		httpx.ErrorJSON(c, http.StatusUnauthorized, "登录信息已失效，请重新登录")
		return
	}

	tag, err := db.Pool().Exec(context.Background(),
		`UPDATE petrichor_auth_session SET revoked_at = now(), updated_at = now()
		 WHERE user_id = $1 AND revoked_at IS NULL AND token_hash <> $2`,
		user.ID, *currentHash)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, gin.H{"success": true, "revokedCount": tag.RowsAffected()})
}
