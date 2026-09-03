package routes

import (
	"github.com/gin-gonic/gin"

	"petrichor/api/internal/publicapi"
)

// registerPublicRoutes 公开接口组：站点内容、公开文章、阅后即焚、公开 Wiki 与下载预签名。
func registerPublicRoutes(rg *gin.RouterGroup) {
	g := rg.Group("/public")

	// 站点内容（公开读取，GET+POST 双通道对齐前端调用习惯）
	about := g.Group("/about")
	about.GET("/profile", publicapi.AboutProfile)
	about.POST("/profile", publicapi.AboutProfile)

	appearance := g.Group("/appearance")
	appearance.GET("", publicapi.SiteAppearance)
	appearance.POST("", publicapi.SiteAppearance)

	filing := g.Group("/filing")
	filing.GET("", publicapi.SiteFiling)
	filing.POST("", publicapi.SiteFiling)

	projects := g.Group("/projects")
	projects.GET("", publicapi.ProjectShowcase)
	projects.POST("", publicapi.ProjectShowcase)

	siteGraph := g.Group("/site-graph")
	siteGraph.GET("", publicapi.SiteGraph)
	siteGraph.POST("", publicapi.SiteGraph)

	// 公开文章
	article := g.Group("/article")
	article.GET("/list", publicapi.ArticleList)
	article.POST("/list", publicapi.ArticleList)
	article.GET("/search", publicapi.ArticleSearch)
	g.GET("/search", publicapi.Search)
	g.GET("/feed/rss", publicapi.RSSFeed)
	g.HEAD("/feed/rss", publicapi.RSSFeed)
	g.GET("/feed/rss.xml", publicapi.RSSFeed)
	g.HEAD("/feed/rss.xml", publicapi.RSSFeed)
	g.GET("/feed/atom", publicapi.AtomFeed)
	g.HEAD("/feed/atom", publicapi.AtomFeed)
	g.GET("/feed/atom.xml", publicapi.AtomFeed)
	g.HEAD("/feed/atom.xml", publicapi.AtomFeed)
	article.GET("/share/detail", publicapi.ShareDetailGet)
	article.POST("/share/detail", publicapi.ShareDetail)

	// 阅后即焚
	burn := g.Group("/burn")
	burn.GET("/meta", publicapi.BurnMeta)
	burn.POST("/consume", publicapi.BurnConsume)

	// 前台问答（本轮不做流式 → 503）
	g.POST("/qa/chat", publicapi.QaChat)

	// 公开 Wiki
	g.GET("/wiki/knowledge-bases", publicapi.WikiKnowledgeBases)
	g.GET("/wiki/pages", publicapi.WikiPageList)
	g.GET("/wiki/page", publicapi.WikiPageDetail)
	g.GET("/wiki/graph", publicapi.WikiGraph)

	// 公开下载预签名
	g.POST("/upload/presign-get", publicapi.PresignGetObject)
}
