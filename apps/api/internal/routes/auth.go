package routes

import (
	"github.com/gin-gonic/gin"

	"petrichor/api/internal/auth"
)

func registerAuthRoutes(rg *gin.RouterGroup) {
	g := rg.Group("/auth")

	// 首次部署初始化：状态公开可读，初始化写入只允许成功一次。
	g.GET("/setup/status", auth.SetupStatus)
	g.POST("/setup", auth.Setup)
	initialized := auth.RequireSiteInitialized()

	// 登录态端点
	g.POST("/login", initialized, auth.Login)
	g.POST("/register", initialized, auth.Register)
	g.POST("/logout", initialized, auth.Logout)
	g.GET("/me", initialized, auth.RequireUser(), auth.Me)
	g.GET("/profile", initialized, auth.RequireUser(), auth.Profile)
	g.POST("/profile/update", initialized, auth.RequireUser(), auth.ProfileUpdate)
	g.POST("/password/change", initialized, auth.RequireUser(), auth.ChangePassword)

	// 自建会话管理
	g.GET("/sessions", initialized, auth.RequireUser(), auth.ListSessions)
	g.POST("/sessions/revoke", initialized, auth.RequireUser(), auth.RevokeSession)
	g.POST("/sessions/revoke-others", initialized, auth.RequireUser(), auth.RevokeOtherSessions)

	// LinuxDo OAuth
	g.GET("/linuxdo/login/start", initialized, auth.LinuxDoLoginStart)
	g.GET("/linuxdo/bind/start", initialized, auth.RequireUser(), auth.LinuxDoBindStart)
	g.POST("/linuxdo/callback", initialized, auth.LinuxDoCallbackPost)
	g.GET("/callback", initialized, auth.LinuxDoCallbackGet)
}
