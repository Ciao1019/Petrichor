// exports.go 供 internal/routes 注册路由使用的导出包装。
package agentapi

import (
	"github.com/gin-gonic/gin"

	"petrichor/api/internal/auth"
)

// UserEndpoint 用户态端点（配合 auth.RequireUser() 中间件使用）。
func UserEndpoint(fn func(c *gin.Context) (any, error)) gin.HandlerFunc {
	return userHandler(fn)
}

// AgentEndpoint Agent Key 端点（配合 auth.RequireAgentKey("") 中间件使用；
// 各端点核心函数内部做 scope 校验，403 会进入调用日志，与 TS withAgent 语义一致）。
func AgentEndpoint(fn func(c *gin.Context, actx *auth.AgentAuthContext) (any, error)) gin.HandlerFunc {
	return agentHandler(fn)
}
