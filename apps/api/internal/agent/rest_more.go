package agent

import (
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticle"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticletag"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbnode"
	"github.com/Ciao1019/Petrichor/apps/api/ent/knowledgebase"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
	"github.com/Ciao1019/Petrichor/apps/api/internal/kb"
)

func (h *Handler) UpdateArticleREST(c *gin.Context) {
	var req struct {
		ArticleID       agentID  `json:"articleId"`
		Title           string   `json:"title" binding:"required"`
		ContentMd       string   `json:"contentMd" binding:"required"`
		ContentJSON     *string  `json:"contentJson"`
		ContentMetaJSON *string  `json:"contentMetaJson"`
		Tags            []string `json:"tags"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := parseAgentID(string(req.ArticleID), "articleId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	userID := agentUserID(c)
	article, err := h.client.KBArticle.Query().Where(
		kbarticle.IDEQ(id), kbarticle.UserIDEQ(userID),
	).Only(c.Request.Context())
	if ent.IsNotFound(err) {
		response.Fail(c, response.NotFound("文章不存在"))
		return
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	previousObjectKeys := extractAgentStorageObjectKeys(article.ContentMd, article.ContentJSON, userID)
	nextObjectKeys := extractAgentStorageObjectKeys(req.ContentMd, req.ContentJSON, userID)
	removedObjectKeys := agentStringSetDifference(previousObjectKeys, nextObjectKeys)
	title := strings.TrimSpace(req.Title)
	if title == "" || len([]rune(title)) > 200 {
		response.Fail(c, response.BadRequest("标题不能为空且不能超过 200 个字符"))
		return
	}
	if req.ContentMd == "" {
		response.Fail(c, response.BadRequest("contentMd 不能为空"))
		return
	}
	tags, err := normalizeAgentTags(req.Tags)
	if err != nil {
		response.Fail(c, err)
		return
	}
	metadata := kb.DerivePublicArticleMetadata(req.ContentMd)
	tx, err := h.client.Tx(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	update := tx.KBArticle.UpdateOneID(id).
		SetTitle(title).SetContentMd(req.ContentMd).
		SetPublicExcerpt(metadata.Excerpt).SetReadingMinutes(metadata.ReadingMinutes).
		SetTocJSON(metadata.TOCJSON).SetPublicContentHash(metadata.ContentHash)
	if req.ContentJSON == nil || *req.ContentJSON == "" {
		update.ClearContentJSON()
	} else {
		update.SetContentJSON(*req.ContentJSON)
	}
	if req.ContentMetaJSON == nil || *req.ContentMetaJSON == "" {
		update.ClearContentMetaJSON()
	} else {
		update.SetContentMetaJSON(*req.ContentMetaJSON)
	}
	if _, err := update.Save(c.Request.Context()); err != nil {
		_ = tx.Rollback()
		response.Fail(c, err)
		return
	}
	if _, err := tx.KBNode.Update().Where(
		kbnode.IDEQ(article.NodeID), kbnode.UserIDEQ(userID),
	).SetName(title).Save(c.Request.Context()); err != nil {
		_ = tx.Rollback()
		response.Fail(c, err)
		return
	}
	if _, err := tx.KBArticleTag.Delete().Where(kbarticletag.ArticleIDEQ(id)).Exec(c.Request.Context()); err != nil {
		_ = tx.Rollback()
		response.Fail(c, err)
		return
	}
	for _, tag := range tags {
		if _, err := tx.KBArticleTag.Create().SetArticleID(id).SetTag(tag).Save(c.Request.Context()); err != nil {
			_ = tx.Rollback()
			response.Fail(c, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		response.Fail(c, err)
		return
	}
	h.scheduleAgentStorageCleanup(userID, removedObjectKeys)
	response.OK(c, gin.H{
		"articleId": fmt.Sprintf("%d", article.ID), "nodeId": fmt.Sprintf("%d", article.NodeID),
		"knowledgeBaseId": fmt.Sprintf("%d", article.KnowledgeBaseID), "title": title,
		"updatedAt": time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func (h *Handler) DeleteArticleREST(c *gin.Context) {
	var req struct {
		ArticleID agentID `json:"articleId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := parseAgentID(string(req.ArticleID), "articleId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	userID := agentUserID(c)
	article, err := h.client.KBArticle.Query().
		Where(kbarticle.IDEQ(id), kbarticle.UserIDEQ(userID)).
		Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			response.Fail(c, response.NotFound("文章不存在"))
			return
		}
		response.Fail(c, err)
		return
	}
	objectKeys := extractAgentStorageObjectKeys(article.ContentMd, article.ContentJSON, userID)
	tx, err := h.client.Tx(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	if _, err := tx.KBArticleTag.Delete().Where(kbarticletag.ArticleIDEQ(id)).Exec(c.Request.Context()); err != nil {
		_ = tx.Rollback()
		response.Fail(c, err)
		return
	}
	if _, err := tx.KBArticle.Delete().Where(kbarticle.IDEQ(id)).Exec(c.Request.Context()); err != nil {
		_ = tx.Rollback()
		response.Fail(c, err)
		return
	}
	if _, err := tx.KBNode.Delete().Where(kbnode.IDEQ(article.NodeID)).Exec(c.Request.Context()); err != nil {
		_ = tx.Rollback()
		response.Fail(c, err)
		return
	}
	if err := tx.Commit(); err != nil {
		response.Fail(c, err)
		return
	}
	h.scheduleAgentStorageCleanup(userID, objectKeys)
	response.OK(c, gin.H{
		"articleId": fmt.Sprintf("%d", article.ID), "nodeId": fmt.Sprintf("%d", article.NodeID),
		"knowledgeBaseId": fmt.Sprintf("%d", article.KnowledgeBaseID), "title": article.Title,
		"deletedAt": time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func (h *Handler) CreateFolderREST(c *gin.Context) {
	var req struct {
		KnowledgeBaseID agentID  `json:"knowledgeBaseId"`
		ParentID        *agentID `json:"parentId"`
		Name            string   `json:"name" binding:"required"`
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
	userID := agentUserID(c)
	exists, err := h.client.KnowledgeBase.Query().
		Where(knowledgebase.IDEQ(kbID), knowledgebase.UserIDEQ(userID)).Exist(c.Request.Context())
	if err != nil || !exists {
		response.Fail(c, response.NotFound("知识库不存在"))
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || len([]rune(name)) > 200 {
		response.Fail(c, response.BadRequest("文件夹名称不能为空且不能超过 200 个字符"))
		return
	}
	var parentID *int64
	if req.ParentID != nil && strings.TrimSpace(string(*req.ParentID)) != "" {
		value, err := parseAgentID(string(*req.ParentID), "parentId")
		if err != nil {
			response.Fail(c, err)
			return
		}
		parentID = &value
	}
	if err := h.assertAgentFolderParent(c.Request.Context(), userID, kbID, parentID); err != nil {
		response.Fail(c, err)
		return
	}
	sortOrder, err := h.nextAgentSortOrder(c.Request.Context(), userID, kbID, parentID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	builder := h.client.KBNode.Create().
		SetUserID(userID).SetKnowledgeBaseID(kbID).SetType("FOLDER").SetName(name).SetSortOrder(sortOrder)
	if parentID != nil {
		builder.SetParentID(*parentID)
	}
	node, err := builder.Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{
		"nodeId": fmt.Sprintf("%d", node.ID), "knowledgeBaseId": fmt.Sprintf("%d", node.KnowledgeBaseID),
		"parentId": formatOptionalID(node.ParentID), "name": node.Name,
		"createdAt": node.CreatedAt.UTC().Format(time.RFC3339Nano),
	})
}

func (h *Handler) SearchDocuments(c *gin.Context) {
	var req struct {
		Keyword         string   `json:"keyword"`
		Query           string   `json:"query"`
		KnowledgeBaseID *agentID `json:"knowledgeBaseId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	keyword := strings.TrimSpace(req.Keyword)
	if keyword == "" {
		keyword = strings.TrimSpace(req.Query)
	}
	if keyword == "" {
		response.OK(c, gin.H{"results": []any{}})
		return
	}
	if len([]rune(keyword)) > 200 {
		response.Fail(c, response.BadRequest("query 不能超过 200 个字符"))
		return
	}
	userID := agentUserID(c)
	q := h.client.KBArticle.Query().Where(
		kbarticle.UserIDEQ(userID),
		kbarticle.Or(
			kbarticle.TitleContainsFold(keyword),
			kbarticle.ContentMdContainsFold(keyword),
		),
	)
	if req.KnowledgeBaseID != nil && strings.TrimSpace(string(*req.KnowledgeBaseID)) != "" {
		kbID, err := parseAgentID(string(*req.KnowledgeBaseID), "knowledgeBaseId")
		if err != nil {
			response.Fail(c, err)
			return
		}
		q = q.Where(kbarticle.KnowledgeBaseIDEQ(kbID))
	}
	rows, err := q.Limit(50).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		snippet := truncateAgentRunes(row.ContentMd, 200)
		out = append(out, gin.H{
			"id":      fmt.Sprintf("%d", row.ID),
			"title":   row.Title,
			"snippet": snippet,
		})
	}
	response.OK(c, gin.H{"results": out})
}
