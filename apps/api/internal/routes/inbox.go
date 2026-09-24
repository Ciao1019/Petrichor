package routes

import (
	"github.com/gin-gonic/gin"
	"petrichor/api/internal/auth"
	"petrichor/api/internal/capturesvc"
	"petrichor/api/internal/kb"
)

func registerInboxRoutes(rg *gin.RouterGroup) {
	g := rg.Group("/inbox", auth.RequireUser())
	g.POST("/list", kb.ListInboxNotes)
	g.POST("/create", kb.CreateInboxNote)
	g.POST("/update", kb.UpdateInboxNote)
	g.POST("/pin", kb.PinInboxNote)
	g.POST("/delete", kb.DeleteInboxNote)
	g.POST("/archive", kb.ArchiveInboxNote)
	g.POST("/recommendation/config", kb.InboxRecommendationConfig)
	g.POST("/recommendation", kb.RecommendInboxArchive)
	g.POST("/capture/config", capturesvc.Config)
	g.POST("/capture/create", capturesvc.CreateHandler)
	g.POST("/capture/list", capturesvc.ListHandler)
	g.POST("/capture/lookup", capturesvc.LookupHandler)
	g.POST("/capture/result", capturesvc.ResultHandler)
	g.POST("/capture/cancel", capturesvc.CancelHandler)
	g.POST("/capture/delete", capturesvc.DeleteHandler)
	g.POST("/capture/regenerate", capturesvc.RegenerateHandler)
}
