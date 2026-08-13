package kb

import (
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticle"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticletag"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbnode"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

type ArticleDTO struct {
	ID              string  `json:"id"`
	KnowledgeBaseID string  `json:"knowledgeBaseId"`
	NodeID          string  `json:"nodeId"`
	Title           string  `json:"title"`
	ContentMd       string  `json:"contentMd"`
	ContentJSON     *string `json:"contentJson"`
	AISummary       *string `json:"aiSummary"`
	CreatedAt       string  `json:"createdAt"`
	UpdatedAt       string  `json:"updatedAt"`
}

func toArticleDTO(row *ent.KBArticle) ArticleDTO {
	return ArticleDTO{
		ID:              fmt.Sprintf("%d", row.ID),
		KnowledgeBaseID: fmt.Sprintf("%d", row.KnowledgeBaseID),
		NodeID:          fmt.Sprintf("%d", row.NodeID),
		Title:           row.Title,
		ContentMd:       row.ContentMd,
		ContentJSON:     row.ContentJSON,
		AISummary:       row.AiSummary,
		CreatedAt:       row.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:       row.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

type createArticleRequest struct {
	KnowledgeBaseID string   `json:"knowledgeBaseId" binding:"required"`
	ParentID        *string  `json:"parentId"`
	Title           string   `json:"title"`
	ContentMd       string   `json:"contentMd"`
	ContentJSON     *string  `json:"contentJson"`
	ContentMetaJSON *string  `json:"contentMetaJson"`
	Tags            []string `json:"tags"`
}

type updateArticleRequest struct {
	ArticleID       string   `json:"articleId" binding:"required"`
	Title           string   `json:"title"`
	ContentMd       string   `json:"contentMd"`
	ContentJSON     *string  `json:"contentJson"`
	ContentMetaJSON *string  `json:"contentMetaJson"`
	Tags            []string `json:"tags"`
}

type articleIDRequest struct {
	ArticleID string `json:"articleId" binding:"required"`
}

func (h *Handler) CreateArticle(c *gin.Context) {
	var req createArticleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parsePositiveID(req.KnowledgeBaseID, "knowledgeBaseId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	if err := h.svc.assertKBOwner(c.Request.Context(), u.ID, kbID); err != nil {
		response.Fail(c, err)
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" || len([]rune(title)) > 200 {
		response.Fail(c, response.BadRequest("标题不能为空且不能超过 200 个字符"))
		return
	}
	var parentID *int64
	if req.ParentID != nil && strings.TrimSpace(*req.ParentID) != "" {
		id, err := parsePositiveID(*req.ParentID, "parentId")
		if err != nil {
			response.Fail(c, err)
			return
		}
		parentID = &id
	}
	if err := h.svc.assertFolderParent(c.Request.Context(), u.ID, kbID, parentID); err != nil {
		response.Fail(c, err)
		return
	}
	sortOrder, err := h.svc.nextSortOrder(c.Request.Context(), u.ID, kbID, parentID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	tags, err := normalizeArticleTags(req.Tags)
	if err != nil {
		response.Fail(c, err)
		return
	}
	metadata := derivePublicArticleMetadata(req.ContentMd)
	tx, err := h.svc.client.Tx(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	nodeBuilder := tx.KBNode.Create().
		SetUserID(u.ID).
		SetKnowledgeBaseID(kbID).
		SetType("ARTICLE").
		SetName(title).
		SetSortOrder(sortOrder)
	if parentID != nil {
		nodeBuilder.SetParentID(*parentID)
	}
	node, err := nodeBuilder.Save(c.Request.Context())
	if err != nil {
		_ = tx.Rollback()
		response.Fail(c, err)
		return
	}
	articleBuilder := tx.KBArticle.Create().
		SetUserID(u.ID).
		SetKnowledgeBaseID(kbID).
		SetNodeID(node.ID).
		SetTitle(title).
		SetContentMd(req.ContentMd).
		SetPublicExcerpt(metadata.Excerpt).
		SetReadingMinutes(metadata.ReadingMinutes).
		SetTocJSON(metadata.TOCJSON).
		SetPublicContentHash(metadata.ContentHash)
	if req.ContentJSON != nil {
		if value := strings.TrimSpace(*req.ContentJSON); value != "" {
			articleBuilder.SetContentJSON(value)
		}
	}
	if req.ContentMetaJSON != nil {
		if value := strings.TrimSpace(*req.ContentMetaJSON); value != "" {
			articleBuilder.SetContentMetaJSON(value)
		}
	}
	article, err := articleBuilder.Save(c.Request.Context())
	if err != nil {
		_ = tx.Rollback()
		response.Fail(c, err)
		return
	}
	for _, tag := range tags {
		if _, err := tx.KBArticleTag.Create().SetArticleID(article.ID).SetTag(tag).Save(c.Request.Context()); err != nil {
			_ = tx.Rollback()
			response.Fail(c, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{
		"articleId": fmt.Sprintf("%d", article.ID),
		"nodeId":    fmt.Sprintf("%d", node.ID),
	})
}

func (h *Handler) DetailArticle(c *gin.Context) {
	var req articleIDRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	articleID, err := parsePositiveID(req.ArticleID, "articleId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	row, err := h.svc.loadOwnedArticle(c.Request.Context(), u.ID, articleID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	node, err := h.svc.client.KBNode.Query().Where(
		kbnode.IDEQ(row.NodeID),
		kbnode.UserIDEQ(u.ID),
	).Only(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	nodes, err := h.svc.loadNodes(c.Request.Context(), u.ID, row.KnowledgeBaseID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	path, err := buildKBNodePath(nodes, node.ID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	tags, err := h.svc.loadArticleTags(c.Request.Context(), row.ID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	var parentID any
	if node.ParentID != nil {
		parentID = fmt.Sprintf("%d", *node.ParentID)
	}
	aiSummaryStale := false
	if row.AiSummary != nil && strings.TrimSpace(*row.AiSummary) != "" {
		aiSummaryStale = row.AiSummaryContentHash == nil || *row.AiSummaryContentHash != BuildArticleAiSummaryContentHash(row.ContentMd)
	}
	response.OK(c, gin.H{
		"articleId":            fmt.Sprintf("%d", row.ID),
		"nodeId":               fmt.Sprintf("%d", row.NodeID),
		"knowledgeBaseId":      fmt.Sprintf("%d", row.KnowledgeBaseID),
		"parentId":             parentID,
		"title":                row.Title,
		"contentMd":            row.ContentMd,
		"contentJson":          row.ContentJSON,
		"contentMetaJson":      row.ContentMetaJSON,
		"aiSummary":            row.AiSummary,
		"aiSummaryGeneratedAt": formatTimePtr(row.AiSummaryGeneratedAt),
		"aiSummaryStale":       aiSummaryStale,
		"tags":                 tags,
		"path":                 path,
		"permission":           "OWNER",
		"readOnly":             false,
		"createdAt":            row.CreatedAt.UTC().Format(time.RFC3339Nano),
		"updatedAt":            row.UpdatedAt.UTC().Format(time.RFC3339Nano),
	})
}

func (h *Handler) UpdateArticle(c *gin.Context) {
	var req updateArticleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	articleID, err := parsePositiveID(req.ArticleID, "articleId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	article, err := h.svc.loadOwnedArticle(c.Request.Context(), u.ID, articleID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" || len([]rune(title)) > 200 {
		response.Fail(c, response.BadRequest("标题不能为空且不能超过 200 个字符"))
		return
	}
	tags, err := normalizeArticleTags(req.Tags)
	if err != nil {
		response.Fail(c, err)
		return
	}
	metadata := derivePublicArticleMetadata(req.ContentMd)
	tx, err := h.svc.client.Tx(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	upd := tx.KBArticle.UpdateOneID(articleID).
		SetTitle(title).
		SetContentMd(req.ContentMd).
		SetPublicExcerpt(metadata.Excerpt).
		SetReadingMinutes(metadata.ReadingMinutes).
		SetTocJSON(metadata.TOCJSON).
		SetPublicContentHash(metadata.ContentHash)
	if req.ContentJSON == nil || strings.TrimSpace(*req.ContentJSON) == "" {
		upd.ClearContentJSON()
	} else {
		upd.SetContentJSON(*req.ContentJSON)
	}
	if req.ContentMetaJSON == nil || strings.TrimSpace(*req.ContentMetaJSON) == "" {
		upd.ClearContentMetaJSON()
	} else {
		upd.SetContentMetaJSON(*req.ContentMetaJSON)
	}
	if _, err := upd.Save(c.Request.Context()); err != nil {
		_ = tx.Rollback()
		response.Fail(c, err)
		return
	}
	if _, err := tx.KBNode.Update().
		Where(kbnode.IDEQ(article.NodeID), kbnode.UserIDEQ(u.ID)).
		SetName(title).
		Save(c.Request.Context()); err != nil {
		_ = tx.Rollback()
		response.Fail(c, err)
		return
	}
	if _, err := tx.KBArticleTag.Delete().Where(kbarticletag.ArticleIDEQ(articleID)).Exec(c.Request.Context()); err != nil {
		_ = tx.Rollback()
		response.Fail(c, err)
		return
	}
	for _, tag := range tags {
		if _, err := tx.KBArticleTag.Create().SetArticleID(articleID).SetTag(tag).Save(c.Request.Context()); err != nil {
			_ = tx.Rollback()
			response.Fail(c, err)
			return
		}
	}
	err = tx.Commit()
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{
		"articleId": fmt.Sprintf("%d", article.ID),
		"nodeId":    fmt.Sprintf("%d", article.NodeID),
	})
}

func (h *Handler) DeleteArticle(c *gin.Context) {
	var req articleIDRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	articleID, err := parsePositiveID(req.ArticleID, "articleId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	article, err := h.svc.client.KBArticle.Query().
		Where(kbarticle.IDEQ(articleID), kbarticle.UserIDEQ(u.ID)).
		Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			response.Fail(c, response.NotFound("文章不存在"))
			return
		}
		response.Fail(c, err)
		return
	}
	tx, err := h.svc.client.Tx(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	if _, err := tx.KBArticle.Delete().Where(kbarticle.IDEQ(articleID), kbarticle.UserIDEQ(u.ID)).Exec(c.Request.Context()); err != nil {
		_ = tx.Rollback()
		response.Fail(c, err)
		return
	}
	if _, err := tx.KBNode.Delete().Where(kbnode.IDEQ(article.NodeID), kbnode.UserIDEQ(u.ID)).Exec(c.Request.Context()); err != nil {
		_ = tx.Rollback()
		response.Fail(c, err)
		return
	}
	if err := tx.Commit(); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{
		"articleId": fmt.Sprintf("%d", article.ID),
		"nodeId":    fmt.Sprintf("%d", article.NodeID),
	})
}

func (h *Handler) SearchArticles(c *gin.Context) {
	var req struct {
		KnowledgeBaseID string   `json:"knowledgeBaseId" binding:"required"`
		Keyword         string   `json:"keyword"`
		Tags            []string `json:"tags"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parsePositiveID(req.KnowledgeBaseID, "knowledgeBaseId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	requiredTags, err := normalizeArticleTags(req.Tags)
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	if err := h.svc.assertKBOwner(c.Request.Context(), u.ID, kbID); err != nil {
		response.Fail(c, err)
		return
	}
	query := h.svc.client.KBArticle.Query().Where(
		kbarticle.UserIDEQ(u.ID),
		kbarticle.KnowledgeBaseIDEQ(kbID),
	)
	if keyword := strings.TrimSpace(req.Keyword); keyword != "" {
		query = query.Where(kbarticle.TitleContainsFold(keyword))
	}
	articles, err := query.Order(ent.Desc(kbarticle.FieldUpdatedAt), ent.Desc(kbarticle.FieldID)).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	nodes, err := h.svc.loadNodes(c.Request.Context(), u.ID, kbID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	items := make([]gin.H, 0, len(articles))
	for _, article := range articles {
		tags, err := h.svc.loadArticleTags(c.Request.Context(), article.ID)
		if err != nil {
			response.Fail(c, err)
			return
		}
		available := make(map[string]struct{}, len(tags))
		for _, tag := range tags {
			available[tag] = struct{}{}
		}
		matched := true
		for _, tag := range requiredTags {
			if _, ok := available[tag]; !ok {
				matched = false
				break
			}
		}
		if !matched {
			continue
		}
		path, err := buildKBNodePath(nodes, article.NodeID)
		if err != nil {
			response.Fail(c, err)
			return
		}
		items = append(items, gin.H{
			"articleId": fmt.Sprintf("%d", article.ID),
			"nodeId":    fmt.Sprintf("%d", article.NodeID),
			"title":     article.Title,
			"tags":      tags,
			"path":      path,
			"updatedAt": article.UpdatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	response.OK(c, gin.H{"items": items})
}
