// Package routes 汇总各业务域路由注册。
package routes

import "github.com/gin-gonic/gin"

// RegisterPublic 公开接口组。
func RegisterPublic(rg *gin.RouterGroup) { registerPublicRoutes(rg) }

// RegisterAuth 认证组。
func RegisterAuth(rg *gin.RouterGroup) { registerAuthRoutes(rg) }

// RegisterNotification 通知组。
func RegisterNotification(rg *gin.RouterGroup) { registerNotificationRoutes(rg) }

// RegisterDashboard 控制台总览。
func RegisterDashboard(rg *gin.RouterGroup) { registerDashboardRoutes(rg) }

// RegisterKB 知识库组。
func RegisterKB(rg *gin.RouterGroup) { registerKBRoutes(rg) }

// RegisterDocLibrary 文档库组。
func RegisterDocLibrary(rg *gin.RouterGroup) { registerDocLibraryRoutes(rg) }

// RegisterAdmin 管理员组。
func RegisterAdmin(rg *gin.RouterGroup) { registerAdminRoutes(rg) }

// RegisterUpload 上传下载组。
func RegisterUpload(rg *gin.RouterGroup) { registerUploadRoutes(rg) }

// RegisterAI AI 配置与写作组。
func RegisterAI(rg *gin.RouterGroup) { registerAIRoutes(rg) }

// RegisterAssistant 助手组。
func RegisterAssistant(rg *gin.RouterGroup) { registerAssistantRoutes(rg) }

// RegisterAgent Agent 开放接口组。
func RegisterAgent(rg *gin.RouterGroup) { registerAgentRoutes(rg) }
