package routes

import (
	"github.com/gin-gonic/gin"

	"petrichor/api/internal/auth"
	"petrichor/api/internal/kb"
)

// registerKBRoutes 知识库组：全部 POST，鉴权 RequireUser。
func registerKBRoutes(rg *gin.RouterGroup) {
	kbGroup := rg.Group("/kb", auth.RequireUser())

	// 知识库 CRUD
	kbGroup.POST("/knowledge-base/list", func(c *gin.Context) { kb.ListKnowledgeBases(c) })
	kbGroup.POST("/knowledge-base/create", func(c *gin.Context) { kb.CreateKnowledgeBase(c) })
	kbGroup.POST("/knowledge-base/detail", func(c *gin.Context) { kb.DetailKnowledgeBase(c) })
	kbGroup.POST("/knowledge-base/update", func(c *gin.Context) { kb.UpdateKnowledgeBase(c) })
	kbGroup.POST("/knowledge-base/delete", func(c *gin.Context) { kb.DeleteKnowledgeBase(c) })

	// 节点树
	kbGroup.POST("/node/roots", func(c *gin.Context) { kb.RootNodes(c) })
	kbGroup.POST("/node/children", func(c *gin.Context) { kb.ChildNodes(c) })
	kbGroup.POST("/node/tree", func(c *gin.Context) { kb.TreeNodes(c) })
	kbGroup.POST("/node/detail", func(c *gin.Context) { kb.DetailNode(c) })
	kbGroup.POST("/node/move", func(c *gin.Context) { kb.MoveNode(c) })
	kbGroup.POST("/node/create-folder", func(c *gin.Context) { kb.CreateFolder(c) })
	kbGroup.POST("/node/update-folder", func(c *gin.Context) { kb.UpdateFolder(c) })
	kbGroup.POST("/node/delete-folder", func(c *gin.Context) { kb.DeleteFolder(c) })

	// 文章
	kbGroup.POST("/article/create", func(c *gin.Context) { kb.CreateArticle(c) })
	kbGroup.POST("/article/detail", func(c *gin.Context) { kb.DetailArticle(c) })
	kbGroup.POST("/article/update", func(c *gin.Context) { kb.UpdateArticle(c) })
	kbGroup.POST("/article/delete", func(c *gin.Context) { kb.DeleteArticle(c) })
	kbGroup.POST("/article/search", func(c *gin.Context) { kb.SearchArticles(c) })
	kbGroup.POST("/article/public-cache/refresh", func(c *gin.Context) { kb.RefreshArticlePublicCache(c) })

	// 公开分享管理
	kbGroup.POST("/article/share/create", func(c *gin.Context) { kb.CreateArticleShare(c) })
	kbGroup.POST("/article/share/info", func(c *gin.Context) { kb.ArticleShareInfo(c) })
	kbGroup.POST("/article/share/pin", func(c *gin.Context) { kb.SetArticleSharePin(c) })
	kbGroup.POST("/article/share/revoke", func(c *gin.Context) { kb.RevokeArticleShare(c) })

	// 阅后即焚
	kbGroup.POST("/burn-link/create", func(c *gin.Context) { kb.CreateBurnLink(c) })
	kbGroup.POST("/burn-link/list", func(c *gin.Context) { kb.ListBurnLinks(c) })
	kbGroup.POST("/burn-link/revoke", func(c *gin.Context) { kb.RevokeBurnLink(c) })

	// PDF 导入
	kbGroup.POST("/import/create", func(c *gin.Context) { kb.CreateImportJob(c) })
	kbGroup.POST("/import/attach-ocr", func(c *gin.Context) { kb.AttachImportOcrPages(c) })
	kbGroup.POST("/import/finalize", func(c *gin.Context) { kb.FinalizeImportJob(c) })
	kbGroup.POST("/import/cancel", func(c *gin.Context) { kb.CancelImportJob(c) })
	kbGroup.POST("/import/retry-page", func(c *gin.Context) { kb.RetryImportPage(c) })
	kbGroup.POST("/import/retry-failed", func(c *gin.Context) { kb.RetryImportJobFailedPages(c) })
	kbGroup.POST("/import/page-convert", func(c *gin.Context) { kb.ConvertImportPage(c) })
	kbGroup.POST("/import/delete", func(c *gin.Context) { kb.DeleteImportJobs(c) })
	kbGroup.POST("/import/list", func(c *gin.Context) { kb.ListImportJobs(c) })
	kbGroup.POST("/import/detail", func(c *gin.Context) { kb.DetailImportJob(c) })

	// 构建知识（LLM 注入）
	kbGroup.POST("/knowledge/build", func(c *gin.Context) { kb.ArticleKnowledgeBuild(c) })
	kbGroup.POST("/knowledge/chunk/list", func(c *gin.Context) { kb.ArticleKnowledgeChunkList(c) })

	// LLM Wiki
	kbGroup.POST("/wiki/dashboard", func(c *gin.Context) { kb.WikiDashboard(c) })
	kbGroup.POST("/wiki/tree", func(c *gin.Context) { kb.WikiTree(c) })
	kbGroup.POST("/wiki/page/list", func(c *gin.Context) { kb.WikiPageList(c) })
	kbGroup.POST("/wiki/page/detail", func(c *gin.Context) { kb.WikiPageDetail(c) })
	// TODO(kb 会话): kb.WikiIngest 尚未在 internal/kb 中实现（对应 wiki-agent-handlers 的 ingest），
	// 为保证 go build ./... 通过暂时下线该路由；实现补齐后恢复本行。
	// kbGroup.POST("/wiki/ingest", func(c *gin.Context) { kb.WikiIngest(c) })
	kbGroup.POST("/wiki/lint", func(c *gin.Context) { kb.RunWikiLint(c) })
	kbGroup.POST("/wiki/embedding/run", func(c *gin.Context) { kb.WikiEmbeddingRun(c) })
	kbGroup.POST("/wiki/patch/list", func(c *gin.Context) { kb.WikiPatchList(c) })
	kbGroup.POST("/wiki/patch/apply", func(c *gin.Context) { kb.WikiPatchApply(c) })
	kbGroup.POST("/wiki/patch/reject", func(c *gin.Context) { kb.WikiPatchReject(c) })

	// 问答辅助
	kbGroup.POST("/qa/knowledge-base/list", func(c *gin.Context) { kb.QAKnowledgeBaseList(c) })
	kbGroup.POST("/qa/model-info", func(c *gin.Context) { kb.QAModelInfo(c) })

	// 思维导图 / 摘要（LLM 注入）
	kbGroup.POST("/article/mindmap/generate", func(c *gin.Context) { kb.GenerateArticleMindmap(c) })
	kbGroup.POST("/article/summary/generate", func(c *gin.Context) { kb.GenerateArticleSummary(c) })
}
