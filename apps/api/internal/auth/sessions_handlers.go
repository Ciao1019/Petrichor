// Sa-Token 登录设备管理。
package auth

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	httpx "petrichor/api/internal/httpx"
)

func tokenSessionMetadata(token string) (deviceInfo, ip, userAgent *string) {
	manager, _ := managerAndPlugin()
	session, err := manager.GetTokenSession(token, false)
	if err != nil || session == nil {
		return nil, nil, nil
	}
	toPointer := func(value string) *string {
		if value == "" {
			return nil
		}
		copy := value
		return &copy
	}
	return toPointer(session.GetString(saTokenDeviceInfoKey)),
		toPointer(session.GetString(saTokenIPKey)),
		toPointer(session.GetString(saTokenUserAgentKey))
}

func formatUnixTime(seconds int64) any {
	if seconds <= 0 {
		return nil
	}
	return httpx.FormatISO(time.Unix(seconds, 0))
}

// ListSessions GET /api/auth/sessions：列出 Sa-Token 中当前用户的有效登录。
func ListSessions(c *gin.Context) {
	user := CurrentUser(c)
	currentToken := currentSaToken(c)
	manager, _ := managerAndPlugin()
	tokens, err := manager.GetTokenValueListByLoginID(strconv.FormatInt(user.ID, 10))
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	sessions := make([]gin.H, 0, len(tokens))
	var currentSessionID *string
	for _, token := range tokens {
		info, err := manager.GetTokenInfo(token)
		if err != nil || info == nil {
			continue
		}
		deviceInfo, ip, userAgent := tokenSessionMetadata(token)
		isCurrent := token == currentToken
		if isCurrent {
			id := info.Device
			currentSessionID = &id
		}
		expiresAt := saTokenExpiry(token)
		var expiresAtValue any
		if !expiresAt.IsZero() {
			expiresAtValue = httpx.FormatISO(expiresAt)
		}
		sessions = append(sessions, gin.H{
			"id":         info.Device,
			"deviceInfo": deviceInfo,
			"ip":         ip,
			"userAgent":  userAgent,
			"lastSeenAt": formatUnixTime(info.ActiveTime),
			"expiresAt":  expiresAtValue,
			"createdAt":  formatUnixTime(info.CreateTime),
			"updatedAt":  formatUnixTime(info.ActiveTime),
			"current":    isCurrent,
		})
	}

	httpx.OK(c, gin.H{
		"sessions":         sessions,
		"currentSessionId": currentSessionID,
	})
}

// RevokeSession POST /api/auth/sessions/revoke {id}，id 为 Sa-Token device id。
func RevokeSession(c *gin.Context) {
	user := CurrentUser(c)
	var body struct {
		ID string `json:"id"`
	}
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	deviceID := strings.TrimSpace(body.ID)
	if deviceID == "" {
		httpx.ErrorJSON(c, http.StatusBadRequest, "会话 ID 不能为空")
		return
	}

	manager, _ := managerAndPlugin()
	token, err := manager.GetTokenValue(strconv.FormatInt(user.ID, 10), deviceID)
	if err != nil || token == "" {
		httpx.ErrorJSON(c, http.StatusNotFound, "会话不存在或已下线")
		return
	}
	if token == currentSaToken(c) {
		httpx.ErrorJSON(c, http.StatusBadRequest, "不能下线当前登录的会话")
		return
	}
	if err := manager.LogoutByToken(token); err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, gin.H{"success": true})
}

// RevokeOtherSessions POST /api/auth/sessions/revoke-others。
func RevokeOtherSessions(c *gin.Context) {
	currentToken := currentSaToken(c)
	if currentToken == "" {
		httpx.ErrorJSON(c, http.StatusUnauthorized, "登录信息已失效，请重新登录")
		return
	}
	revoked, err := logoutOtherSaTokenSessions(CurrentUser(c).ID, currentToken)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, gin.H{"success": true, "revokedCount": revoked})
}
