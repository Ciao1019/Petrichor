package kb

import (
	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

type summaryGenerateRequest struct {
	ArticleID    string `json:"articleId" binding:"required"`
	ForceRebuild bool   `json:"forceRebuild"`
}

func (h *Handler) GenerateArticleSummary(c *gin.Context) {
	var req summaryGenerateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	input, err := ValidateSummaryGenerateInput(req.ArticleID, req.ForceRebuild)
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	result, err := h.svc.GenerateArticleSummary(c.Request.Context(), u.ID, input)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{
		"articleId":   result.ArticleID,
		"summary":     result.Summary,
		"fromCache":   result.FromCache,
		"generatedAt": result.GeneratedAt,
	})
}

type mindmapGenerateRequest struct {
	ArticleID    string `json:"articleId" binding:"required"`
	Mode         string `json:"mode"`
	ForceRebuild bool   `json:"forceRebuild"`
}

func (h *Handler) GenerateArticleMindmap(c *gin.Context) {
	var req mindmapGenerateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	input, err := ValidateMindmapGenerateInput(req.ArticleID, req.Mode, req.ForceRebuild)
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	result, err := h.svc.GenerateArticleMindmap(c.Request.Context(), u.ID, input)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{
		"articleId":   result.ArticleID,
		"fromCache":   result.FromCache,
		"generatedAt": result.GeneratedAt,
		"data":        result.Data,
	})
}
