package router

import (
	"context"
	"database/sql"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/internal/about"
	"github.com/Ciao1019/Petrichor/apps/api/internal/admin"
	"github.com/Ciao1019/Petrichor/apps/api/internal/agent"
	aiconfig "github.com/Ciao1019/Petrichor/apps/api/internal/ai/config"
	aireview "github.com/Ciao1019/Petrichor/apps/api/internal/ai/review"
	aiwrite "github.com/Ciao1019/Petrichor/apps/api/internal/ai/write"
	"github.com/Ciao1019/Petrichor/apps/api/internal/appearance"
	"github.com/Ciao1019/Petrichor/apps/api/internal/assistant"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
	"github.com/Ciao1019/Petrichor/apps/api/internal/dashboard"
	"github.com/Ciao1019/Petrichor/apps/api/internal/feed"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/middleware"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
	"github.com/Ciao1019/Petrichor/apps/api/internal/kb"
	"github.com/Ciao1019/Petrichor/apps/api/internal/notification"
	"github.com/Ciao1019/Petrichor/apps/api/internal/projects"
	"github.com/Ciao1019/Petrichor/apps/api/internal/publicqa"
	"github.com/Ciao1019/Petrichor/apps/api/internal/upload"
)

type Dependencies struct {
	Context context.Context
	Config  *config.Config
	Client  *ent.Client
	SQL     *sql.DB
	Log     *zap.Logger
}

func New(deps Dependencies) *gin.Engine {
	if deps.Config.IsProduction() {
		gin.SetMode(gin.ReleaseMode)
	}

	r := gin.New()
	r.Use(middleware.Recovery(deps.Log), middleware.RequestLogger(deps.Log))

	authSvc := auth.NewService(deps.Client, deps.Config)
	authHandler := auth.NewHandler(authSvc, deps.Config)
	authMW := auth.Middleware(authSvc, deps.Config)
	assistantRuntime := assistant.NewRuntime(deps.Client, deps.SQL, deps.Log, deps.Config)
	kbSvc := kb.NewService(deps.Client, deps.SQL, deps.Log, deps.Config)
	kbSvc.StartWikiWorker(deps.Context)
	kbHandler := kb.NewHandler(kbSvc)
	aboutHandler := about.NewHandler(deps.Client)
	appearanceHandler := appearance.NewHandler(deps.Client)
	projectsHandler := projects.NewHandler(deps.Client)
	adminHandler := admin.NewHandler(deps.Client)
	notificationHandler := notification.NewHandler(deps.Client)
	uploadHandler := upload.NewHandler(deps.Config)
	publicQAHandler := publicqa.NewHandler(deps.Client, deps.SQL, deps.Config)
	feedHandler := feed.NewHandler(deps.Client, deps.Config)
	writeHandler := aiwrite.NewHandler(deps.Client, deps.Config)
	reviewHandler := aireview.NewHandler(deps.Client, deps.Config)
	aiConfigHandler := aiconfig.NewHandler(deps.Client, deps.Config)
	agentHandler := agent.NewHandler(deps.Client, kbSvc, deps.Config)
	dashboardHandler := dashboard.NewHandler(deps.Client, deps.SQL)

	r.GET("/healthz", func(c *gin.Context) {
		response.OK(c, gin.H{"status": "ok", "runtime": "go"})
	})
	r.GET("/rss.xml", feedHandler.RSS)
	r.GET("/atom.xml", feedHandler.Atom)

	api := r.Group("/api")
	{
		authGroup := api.Group("/auth")
		{
			authGroup.POST("/login", authHandler.Login)
			authGroup.POST("/register", authHandler.Register)
			authGroup.POST("/logout", authHandler.Logout)
			authGroup.GET("/linuxdo/login/start", authHandler.LinuxDoLoginStart)
			authGroup.GET("/linuxdo/bind/start", authMW, authHandler.LinuxDoBindStart)
			authGroup.GET("/callback", authHandler.LinuxDoCallbackGet)
			authGroup.POST("/linuxdo/callback", authHandler.LinuxDoCallbackPost)
			secured := authGroup.Group("")
			secured.Use(authMW)
			{
				secured.GET("/me", authHandler.Me)
				secured.GET("/profile", authHandler.Profile)
				secured.POST("/profile/update", authHandler.UpdateProfile)
				secured.POST("/password/change", authHandler.ChangePassword)
				secured.GET("/sessions", authHandler.ListSessions)
				secured.POST("/sessions/revoke", authHandler.RevokeSession)
				secured.POST("/sessions/revoke-others", authHandler.RevokeOtherSessions)
			}
		}

		api.GET("/public/about/profile", aboutHandler.PublicGet)
		api.POST("/public/about/profile", aboutHandler.PublicGet)
		api.GET("/public/appearance", appearanceHandler.PublicGet)
		api.POST("/public/appearance", appearanceHandler.PublicGet)
		api.GET("/public/projects", projectsHandler.PublicGet)
		api.POST("/public/projects", projectsHandler.PublicGet)
		api.POST("/public/upload/presign-get", uploadHandler.PublicPresignGet)
		api.GET("/upload/local/*objectKey", uploadHandler.LocalGet)
		api.GET("/public/article/list", kbHandler.PublicArticleList)
		api.POST("/public/article/list", kbHandler.PublicArticleList)
		api.GET("/public/article/search", kbHandler.PublicArticleSearch)
		api.POST("/public/article/search", kbHandler.PublicArticleSearch)
		api.GET("/public/article/share/detail", kbHandler.PublicShareDetail)
		api.POST("/public/article/share/detail", kbHandler.PublicShareDetail)
		api.GET("/public/burn/meta", kbHandler.PublicBurnMeta)
		api.POST("/public/burn/meta", kbHandler.PublicBurnMeta)
		api.POST("/public/burn/consume", kbHandler.PublicBurnConsume)
		api.POST("/public/qa/chat", publicQAHandler.Chat)

		adminGroup := api.Group("/admin")
		adminGroup.Use(authMW)
		{
			adminGroup.GET("/about/profile", aboutHandler.AdminGet)
			adminGroup.POST("/about/profile", aboutHandler.AdminSave)
			adminGroup.GET("/appearance", appearanceHandler.AdminGet)
			adminGroup.POST("/appearance", appearanceHandler.AdminSave)
			adminGroup.GET("/projects", projectsHandler.AdminGet)
			adminGroup.POST("/projects", projectsHandler.AdminSave)
			adminGroup.POST("/user/list", adminHandler.ListUsers)
			adminGroup.POST("/user/create", adminHandler.CreateUser)
			adminGroup.POST("/user/delete", adminHandler.DeleteUser)
		}

		assistantGroup := api.Group("/assistant")
		assistantGroup.Use(authMW)
		{
			assistantGroup.GET("/health", assistantRuntime.Health)
			assistantGroup.POST("/chat", assistantRuntime.Chat)
			assistantGroup.POST("/chat/json", assistantRuntime.ChatJSON)
			assistantGroup.POST("/thread/list", assistantRuntime.ListThreads)
			assistantGroup.POST("/thread/create", assistantRuntime.CreateThread)
			assistantGroup.POST("/thread/detail", assistantRuntime.DetailThread)
			assistantGroup.POST("/thread/delete", assistantRuntime.DeleteThread)
			assistantGroup.POST("/thread/delete-many", assistantRuntime.DeleteManyThreads)
			assistantGroup.POST("/plan/patch", assistantRuntime.PatchPlanTodo)
		}

		kbGroup := api.Group("/kb")
		kbGroup.Use(authMW)
		{
			kbGroup.POST("/knowledge-base/list", kbHandler.List)
			kbGroup.POST("/knowledge-base/create", kbHandler.Create)
			kbGroup.POST("/knowledge-base/detail", kbHandler.Detail)
			kbGroup.POST("/knowledge-base/update", kbHandler.Update)
			kbGroup.POST("/knowledge-base/delete", kbHandler.Delete)
			kbGroup.POST("/document-folder/list", kbHandler.DocumentFolderList)
			kbGroup.POST("/document-folder/save", kbHandler.DocumentFolderSave)
			kbGroup.POST("/document-folder/delete", kbHandler.DocumentFolderDelete)
			kbGroup.POST("/document/list", kbHandler.DocumentList)
			kbGroup.POST("/document/register", kbHandler.DocumentRegister)
			kbGroup.POST("/document/detail", kbHandler.DocumentDetail)
			kbGroup.POST("/document/move", kbHandler.DocumentMove)
			kbGroup.POST("/document/delete", kbHandler.DocumentDelete)
			kbGroup.POST("/document/rechunk", kbHandler.DocumentRechunk)
			kbGroup.POST("/document/spans", kbHandler.DocumentSpans)
			kbGroup.POST("/document/tag/list", kbHandler.DocumentTagList)
			kbGroup.POST("/document/tag/save", kbHandler.DocumentTagSave)
			kbGroup.POST("/chunk/preview", kbHandler.ChunkPreview)
			kbGroup.POST("/chunk/question/add", kbHandler.ChunkQuestionAdd)
			kbGroup.POST("/chunk/question/delete", kbHandler.ChunkQuestionDelete)
			kbGroup.POST("/chunk/question/regenerate", kbHandler.ChunkQuestionRegenerate)
			kbGroup.POST("/document/embedding/run", kbHandler.DocumentEmbeddingRun)
			kbGroup.POST("/document/embedding/status", kbHandler.DocumentEmbeddingStatus)
			kbGroup.POST("/node/tree", kbHandler.Tree)
			kbGroup.POST("/node/roots", kbHandler.Roots)
			kbGroup.POST("/node/children", kbHandler.Children)
			kbGroup.POST("/node/detail", kbHandler.DetailNode)
			kbGroup.POST("/node/create-folder", kbHandler.CreateFolder)
			kbGroup.POST("/node/update-folder", kbHandler.UpdateFolder)
			kbGroup.POST("/node/delete-folder", kbHandler.DeleteFolder)
			kbGroup.POST("/node/move", kbHandler.MoveNode)
			kbGroup.POST("/article/create", kbHandler.CreateArticle)
			kbGroup.POST("/article/detail", kbHandler.DetailArticle)
			kbGroup.POST("/article/update", kbHandler.UpdateArticle)
			kbGroup.POST("/article/delete", kbHandler.DeleteArticle)
			kbGroup.POST("/article/search", kbHandler.SearchArticles)
			kbGroup.POST("/article/summary/generate", kbHandler.GenerateArticleSummary)
			kbGroup.POST("/article/mindmap/generate", kbHandler.GenerateArticleMindmap)
			kbGroup.POST("/article/share/create", kbHandler.CreateShare)
			kbGroup.POST("/article/share/info", kbHandler.ShareInfo)
			kbGroup.POST("/article/share/revoke", kbHandler.RevokeShare)
			kbGroup.POST("/article/share/pin", kbHandler.SharePin)
			kbGroup.POST("/article/public-cache/refresh", kbHandler.RefreshArticlePublicCache)
			kbGroup.POST("/burn-link/create", kbHandler.CreateBurnLink)
			kbGroup.POST("/burn-link/list", kbHandler.ListBurnLinks)
			kbGroup.POST("/burn-link/revoke", kbHandler.RevokeBurnLink)
			kbGroup.POST("/wiki/page/list", kbHandler.WikiPageList)
			kbGroup.POST("/wiki/page/detail", kbHandler.WikiPageDetail)
			kbGroup.POST("/wiki/document-ingest", kbHandler.WikiDocumentIngest)
			kbGroup.POST("/wiki/ingest-status", kbHandler.WikiIngestStatus)
			kbGroup.POST("/wiki/graph", kbHandler.WikiGraph)
			kbGroup.POST("/wiki/lint", kbHandler.WikiLint)
			kbGroup.POST("/qa/knowledge-base/list", kbHandler.QAKnowledgeBaseList)
			kbGroup.POST("/qa/model-info", kbHandler.QAModelInfo)
			kbGroup.POST("/import/list", kbHandler.ListImportJobs)
			kbGroup.POST("/import/detail", kbHandler.DetailImportJob)
			kbGroup.POST("/import/create", kbHandler.CreateImportJob)
			kbGroup.POST("/import/finalize", kbHandler.FinalizeImportJob)
			kbGroup.POST("/import/cancel", kbHandler.CancelImportJob)
			kbGroup.POST("/import/delete", kbHandler.DeleteImportJobs)
			kbGroup.POST("/import/attach-ocr-pages", kbHandler.AttachImportOcrPages)
			kbGroup.POST("/import/attach-ocr", kbHandler.AttachImportOcrPages)
			kbGroup.POST("/import/page-convert", kbHandler.ConvertImportPage)
			kbGroup.POST("/import/retry-page", kbHandler.RetryImportPage)
			kbGroup.POST("/import/retry-failed", kbHandler.RetryImportFailedPages)
		}

		agentGroup := api.Group("/agent")
		{
			agentMgmt := agentGroup.Group("")
			agentMgmt.Use(authMW)
			{
				agentMgmt.POST("/api-key/list", agentHandler.ListAPIKeys)
				agentMgmt.POST("/api-key/create", agentHandler.CreateAPIKey)
				agentMgmt.POST("/api-key/revoke", agentHandler.RevokeAPIKey)
				agentMgmt.POST("/call-log/list", agentHandler.ListCallLogs)
			}
			agentGroup.GET("/manifest", agentHandler.Manifest)
			agentGroup.GET("/capabilities", agentHandler.APIKeyAuth(), agentHandler.Capabilities)
			agentGroup.GET("/skill", agentHandler.Skill)
			agentGroup.GET("/skill-pack", agentHandler.SkillPack)
			agentAPI := agentGroup.Group("")
			{
				agentAPI.POST("/knowledge-base/list", agentHandler.APIKeyAuth("doc:read"), agentHandler.ListKnowledgeBases)
				agentAPI.POST("/knowledge-base/tree", agentHandler.APIKeyAuth("doc:read"), agentHandler.GetKnowledgeBaseTree)
				agentAPI.POST("/article/list", agentHandler.APIKeyAuth("doc:read"), agentHandler.ListArticles)
				agentAPI.POST("/article/create", agentHandler.APIKeyAuth("article:write"), agentHandler.CreateArticleREST)
				agentAPI.POST("/article/update", agentHandler.APIKeyAuth("article:write"), agentHandler.UpdateArticleREST)
				agentAPI.POST("/article/delete", agentHandler.APIKeyAuth("article:delete"), agentHandler.DeleteArticleREST)
				agentAPI.POST("/article/move", agentHandler.APIKeyAuth("article:write"), agentHandler.MoveArticleREST)
				agentAPI.POST("/article/share/create", agentHandler.APIKeyAuth("share:write"), agentHandler.ShareCreateREST)
				agentAPI.POST("/article/share/info", agentHandler.APIKeyAuth("share:write"), agentHandler.ShareInfoREST)
				agentAPI.POST("/article/share/revoke", agentHandler.APIKeyAuth("share:write"), agentHandler.ShareRevokeREST)
				agentAPI.POST("/article/summary/generate", agentHandler.APIKeyAuth("ai:write"), agentHandler.GenerateSummaryREST)
				agentAPI.POST("/article/mindmap/generate", agentHandler.APIKeyAuth("ai:write"), agentHandler.GenerateMindmapREST)
				agentAPI.POST("/folder/create", agentHandler.APIKeyAuth("article:write"), agentHandler.CreateFolderREST)
				agentAPI.POST("/document/view", agentHandler.APIKeyAuth("doc:read"), agentHandler.ViewDocument)
				agentAPI.POST("/document/search", agentHandler.APIKeyAuth("doc:read"), agentHandler.DocumentSearchREST)
				agentAPI.POST("/document/qa", agentHandler.APIKeyAuth("qa:read"), agentHandler.AskDocumentREST)
				agentAPI.POST("/knowledge/search", agentHandler.APIKeyAuth("doc:read"), agentHandler.SearchDocuments)
				agentAPI.POST("/wiki/page/list", agentHandler.APIKeyAuth("wiki:read"), agentHandler.WikiPageListREST)
				agentAPI.POST("/wiki/page/detail", agentHandler.APIKeyAuth("wiki:read"), agentHandler.WikiPageDetailREST)
				agentAPI.POST("/wiki/lint", agentHandler.APIKeyAuth("wiki:read"), agentHandler.WikiLintREST)
				agentAPI.POST("/wiki/ingest", agentHandler.APIKeyAuth("wiki:write"), agentHandler.WikiIngestREST)
			}
		}
		api.POST("/mcp", agentHandler.APIKeyAuth(), agentHandler.MCP)
		api.DELETE("/mcp", agentHandler.APIKeyAuth(), agentHandler.MCP)

		aiGroup := api.Group("/ai")
		aiGroup.Use(authMW)
		{
			aiGroup.POST("/config/list", aiConfigHandler.List)
			aiGroup.POST("/config/create", aiConfigHandler.Create)
			aiGroup.POST("/config/detail", aiConfigHandler.Detail)
			aiGroup.POST("/config/update", aiConfigHandler.Update)
			aiGroup.POST("/config/delete", aiConfigHandler.Delete)
			aiGroup.POST("/config/set-default", aiConfigHandler.SetDefault)
			aiGroup.POST("/write/stream", writeHandler.Stream)
			aiGroup.POST("/review/get", reviewHandler.Get)
			aiGroup.POST("/review/regenerate", reviewHandler.Regenerate)
			aiGroup.POST("/review/list", reviewHandler.List)
			aiGroup.POST("/review/period-options", reviewHandler.PeriodOptions)
		}

		notifGroup := api.Group("/notification")
		notifGroup.Use(authMW)
		{
			notifGroup.GET("/summary", notificationHandler.Summary)
			notifGroup.POST("/summary", notificationHandler.Summary)
			notifGroup.POST("/list", notificationHandler.List)
			notifGroup.POST("/read", notificationHandler.Read)
			notifGroup.POST("/read-all", notificationHandler.ReadAll)
		}

		uploadGroup := api.Group("/upload")
		uploadGroup.Use(authMW)
		{
			uploadGroup.POST("/presign-put", uploadHandler.PresignPut)
			uploadGroup.POST("/presign-get", uploadHandler.PresignGet)
			uploadGroup.PUT("/local/*objectKey", uploadHandler.LocalPut)
		}

		dashboardGroup := api.Group("/dashboard")
		dashboardGroup.Use(authMW)
		{
			dashboardGroup.POST("/overview", dashboardHandler.Overview)
		}
	}

	return r
}
