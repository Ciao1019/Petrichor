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

// anySliceFromAttributes 把类型化属性转回弱类型数组，复用统一归一化入口。
func anySliceFromAttributes(items []Attribute) []any {
	raw := make([]any, 0, len(items))
	for _, item := range items {
		raw = append(raw, map[string]any{"name": item.Name, "value": item.Value})
	}
	return raw
}
