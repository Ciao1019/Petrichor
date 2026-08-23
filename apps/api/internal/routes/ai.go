// registerAIRoutes AI 配置与写作组：对照 apps/web/app/api/ai/**/route.ts 的 23 个端点。
// TS 源全部经 requireCurrentUser 鉴权，这里统一挂在 RequireUser 中间件上。
package routes

import (
	"github.com/gin-gonic/gin"

	"petrichor/api/internal/aisvc"
	"petrichor/api/internal/auth"
)

func registerAIRoutes(rg *gin.RouterGroup) {
	g := rg.Group("/ai", auth.RequireUser())

	// 用途绑定（binding-handlers.ts）
	g.POST("/binding/list", aisvc.ListBindings)
	g.POST("/binding/set", aisvc.SetBinding)
	g.POST("/binding/clear", aisvc.ClearBinding)

	// 凭证库（credential-handlers.ts）
	g.POST("/credential/list", aisvc.ListCredentials)
	g.POST("/credential/create", aisvc.CreateCredential)
	g.POST("/credential/update", aisvc.UpdateCredential)
	g.POST("/credential/delete", aisvc.DeleteCredential)

	// 供应商实例与模型发现（provider-handlers.ts + provider-models.ts）
	g.POST("/provider/catalog", aisvc.ListProviderCatalog)
	g.POST("/provider/list", aisvc.ListProviders)
	g.POST("/provider/create", aisvc.CreateProvider)
	g.POST("/provider/update", aisvc.UpdateProvider)
	g.POST("/provider/delete", aisvc.DeleteProvider)
	g.POST("/provider/fetch-models", aisvc.FetchProviderModels)
	g.POST("/provider/sync-models", aisvc.SyncProviderModels)
	g.POST("/provider/test", aisvc.TestProvider)

	// 模型（provider-handlers.ts 模型部分 + embedding.ts）
	g.POST("/model/list", aisvc.ListModels)
	g.POST("/model/toggle", aisvc.ToggleModel)
	g.POST("/model/probe-dimensions", aisvc.ProbeModelDimensions)

	// AI 写作回顾（review/handlers.ts）
	g.POST("/review/get", aisvc.GetReview)
	g.POST("/review/list", aisvc.ListReviews)
	g.POST("/review/regenerate", aisvc.RegenerateReview)
	g.POST("/review/period-options", aisvc.GetReviewPeriodOptions)

	// AI 写作助手流式输出（write/handlers.ts）
	g.POST("/write/stream", aisvc.StreamWrite)
}
