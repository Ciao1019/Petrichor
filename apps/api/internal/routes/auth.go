package routes

import (
	"github.com/gin-gonic/gin"

	"petrichor/api/internal/auth"
)

func registerAuthRoutes(rg *gin.RouterGroup) {
	g := rg.Group("/auth")

	// 登录态端点
	g.POST("/login", auth.Login)
	g.POST("/register", auth.Register)
	g.POST("/logout", auth.Logout)
	g.GET("/me", auth.RequireUser(), auth.Me)
	g.GET("/profile", auth.RequireUser(), auth.Profile)
	g.POST("/profile/update", auth.RequireUser(), auth.ProfileUpdate)
	g.POST("/password/change", auth.RequireUser(), auth.ChangePassword)

	// 自建会话管理
	g.GET("/sessions", auth.RequireUser(), auth.ListSessions)
	g.POST("/sessions/revoke", auth.RequireUser(), auth.RevokeSession)
	g.POST("/sessions/revoke-others", auth.RequireUser(), auth.RevokeOtherSessions)

	// LinuxDo OAuth
	g.GET("/linuxdo/login/start", auth.LinuxDoLoginStart)
	g.GET("/linuxdo/bind/start", auth.RequireUser(), auth.LinuxDoBindStart)
	g.POST("/linuxdo/callback", auth.LinuxDoCallbackPost)
	g.GET("/callback", auth.LinuxDoCallbackGet)
}
