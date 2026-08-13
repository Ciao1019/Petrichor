package agent

import (
	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
	"github.com/Ciao1019/Petrichor/apps/api/internal/kb"
)

func (h *Handler) GenerateSummaryREST(c *gin.Context) {
	var req struct {
		ArticleID    agentID `json:"articleId"`
		ForceRebuild bool    `json:"forceRebuild"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	input, err := kb.ValidateSummaryGenerateInput(string(req.ArticleID), req.ForceRebuild)
	if err != nil {
		response.Fail(c, err)
		return
	}
	result, err := h.kbSvc.GenerateArticleSummary(c.Request.Context(), agentUserID(c), input)
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

func (h *Handler) GenerateMindmapREST(c *gin.Context) {
	var req struct {
		ArticleID    agentID `json:"articleId"`
		Mode         string  `json:"mode"`
		ForceRebuild bool    `json:"forceRebuild"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	input, err := kb.ValidateMindmapGenerateInput(string(req.ArticleID), req.Mode, req.ForceRebuild)
	if err != nil {
		response.Fail(c, err)
		return
	}
	result, err := h.kbSvc.GenerateArticleMindmap(c.Request.Context(), agentUserID(c), input)
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

func (h *Handler) WikiLintREST(c *gin.Context) {
	var req struct {
		KnowledgeBaseID agentID `json:"knowledgeBaseId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parseAgentID(string(req.KnowledgeBaseID), "knowledgeBaseId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	lint, err := h.kbSvc.RunWikiLintForAgent(c.Request.Context(), agentUserID(c), kbID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, lint)
}

func (h *Handler) WikiIngestREST(c *gin.Context) {
	var req struct {
		KnowledgeBaseID agentID   `json:"knowledgeBaseId"`
		DocumentIDs     []agentID `json:"documentIds"`
		ForceRebuild    bool      `json:"forceRebuild"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parseAgentID(string(req.KnowledgeBaseID), "knowledgeBaseId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	if len(req.DocumentIDs) > 500 {
		response.Fail(c, response.BadRequest("documentIds 数量不能超过 500"))
		return
	}
	documentIDs := make([]string, 0, len(req.DocumentIDs))
	for _, rawID := range req.DocumentIDs {
		if _, err := parseAgentID(string(rawID), "documentId"); err != nil {
			response.Fail(c, err)
			return
		}
		documentIDs = append(documentIDs, string(rawID))
	}
	result, err := h.kbSvc.QueueKnowledgeBaseDocumentsWiki(
		c.Request.Context(), agentUserID(c), kbID, documentIDs, req.ForceRebuild,
	)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, result)
}
