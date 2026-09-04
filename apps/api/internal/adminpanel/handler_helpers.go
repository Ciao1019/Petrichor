// handler_helpers.go adminpanel HTTP 层共享小工具。
package adminpanel

import (
	"strings"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/auth"
)

// authUserID 取当前登录用户 ID（RequireUser 之后可用）。
func authUserID(c *gin.Context) int64 {
	u := auth.CurrentUser(c)
	if u == nil {
		return 0
	}
	return u.ID
}

func trimSpaces(s string) string { return strings.TrimSpace(s) }

func inList(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}
