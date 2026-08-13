package agent

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticle"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticleshare"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbnode"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

func agentRandomCode(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// MoveArticleREST 移动文章节点到新的父文件夹。
func (h *Handler) MoveArticleREST(c *gin.Context) {
	var req struct {
		ArticleID   agentID  `json:"articleId"`
		ParentID    *agentID `json:"parentId"`
		TargetIndex *int     `json:"targetIndex"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	articleID, err := parseAgentID(string(req.ArticleID), "articleId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	if req.TargetIndex != nil && *req.TargetIndex < 0 {
		response.Fail(c, response.BadRequest("targetIndex 不能小于 0"))
		return
	}
	userID := agentUserID(c)
	article, err := h.client.KBArticle.Query().
		Where(kbarticle.IDEQ(articleID), kbarticle.UserIDEQ(userID)).
		Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			response.Fail(c, response.NotFound("文章不存在"))
			return
		}
		response.Fail(c, err)
		return
	}

	var targetParentID *int64
	if req.ParentID == nil || strings.TrimSpace(string(*req.ParentID)) == "" {
	} else {
		parentID, err := parseAgentID(string(*req.ParentID), "parentId")
		if err != nil {
			response.Fail(c, err)
			return
		}
		targetParentID = &parentID
	}
	if err := h.assertAgentFolderParent(c.Request.Context(), userID, article.KnowledgeBaseID, targetParentID); err != nil {
		response.Fail(c, err)
		return
	}
	nodes, err := h.client.KBNode.Query().Where(
		kbnode.UserIDEQ(userID), kbnode.KnowledgeBaseIDEQ(article.KnowledgeBaseID),
	).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	nodeByID := make(map[int64]*ent.KBNode, len(nodes))
	for _, node := range nodes {
		nodeByID[node.ID] = node
	}
	node := nodeByID[article.NodeID]
	if node == nil {
		response.Fail(c, response.NotFound("文章节点不存在"))
		return
	}
	if targetParentID != nil && (*targetParentID == node.ID || agentNodeUnderAncestor(nodeByID, *targetParentID, node.ID)) {
		response.Fail(c, response.BadRequest("不能把节点移动到自身或子文件夹中"))
		return
	}
	targetOrder := sortedAgentSiblingIDs(nodes, targetParentID, &node.ID)
	targetIndex := len(targetOrder)
	if req.TargetIndex != nil && *req.TargetIndex < targetIndex {
		targetIndex = *req.TargetIndex
	}
	targetOrder = append(targetOrder, 0)
	copy(targetOrder[targetIndex+1:], targetOrder[targetIndex:])
	targetOrder[targetIndex] = node.ID
	sourceParentID := node.ParentID
	sourceOrder := targetOrder
	if !sameOptionalID(sourceParentID, targetParentID) {
		sourceOrder = sortedAgentSiblingIDs(nodes, sourceParentID, &node.ID)
	}
	tx, err := h.client.Tx(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	rollback := func(cause error) {
		_ = tx.Rollback()
		response.Fail(c, cause)
	}
	if !sameOptionalID(sourceParentID, targetParentID) {
		for index, id := range sourceOrder {
			if _, err := tx.KBNode.UpdateOneID(id).SetSortOrder(index + 1).Save(c.Request.Context()); err != nil {
				rollback(err)
				return
			}
		}
	}
	for index, id := range targetOrder {
		update := tx.KBNode.UpdateOneID(id).SetSortOrder(index + 1)
		if id == node.ID {
			if targetParentID == nil {
				update.ClearParentID()
			} else {
				update.SetParentID(*targetParentID)
			}
		}
		if _, err := update.Save(c.Request.Context()); err != nil {
			rollback(err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{
		"articleId":       fmt.Sprintf("%d", article.ID),
		"nodeId":          fmt.Sprintf("%d", article.NodeID),
		"knowledgeBaseId": fmt.Sprintf("%d", article.KnowledgeBaseID),
		"parentId":        formatOptionalID(targetParentID),
		"updatedAt":       time.Now().UTC().Format(time.RFC3339Nano),
	})
}

// ShareCreateREST 创建或复用文章分享链接。
func (h *Handler) ShareCreateREST(c *gin.Context) {
	var req struct {
		ArticleID       agentID `json:"articleId"`
		AccessPassword  *string `json:"accessPassword"`
		PasswordEnabled *bool   `json:"passwordEnabled"`
		ExpiresAt       *string `json:"expiresAt"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	articleID, err := parseAgentID(string(req.ArticleID), "articleId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	userID := agentUserID(c)
	article, err := h.client.KBArticle.Query().
		Where(kbarticle.IDEQ(articleID), kbarticle.UserIDEQ(userID)).
		Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			response.Fail(c, response.NotFound("文章不存在"))
			return
		}
		response.Fail(c, err)
		return
	}
	existing, err := h.client.KBArticleShare.Query().
		Where(kbarticleshare.ArticleIDEQ(article.ID)).
		Only(c.Request.Context())
	if !ent.IsNotFound(err) {
		if err != nil {
			response.Fail(c, err)
			return
		}
	} else {
		existing = nil
	}
	var expiresAt *time.Time
	if req.ExpiresAt != nil && strings.TrimSpace(*req.ExpiresAt) != "" {
		value, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(*req.ExpiresAt))
		if err != nil || !value.After(time.Now()) {
			response.Fail(c, response.BadRequest("expiresAt 必须是晚于当前时间的合法 ISO 8601 时间"))
			return
		}
		value = value.UTC()
		expiresAt = &value
	}
	password := ""
	if req.AccessPassword != nil {
		password = strings.TrimSpace(*req.AccessPassword)
		if password != "" && (len(password) != 6 || strings.Trim(password, "0123456789") != "") {
			response.Fail(c, response.BadRequest("访问密码必须是 6 位数字"))
			return
		}
	}
	var passwordHash *string
	if req.PasswordEnabled != nil && *req.PasswordEnabled && password == "" && (existing == nil || existing.PasswordHash == nil || strings.TrimSpace(*existing.PasswordHash) == "") {
		response.Fail(c, response.BadRequest("启用密码时必须提供 accessPassword（6 位数字）"))
		return
	}
	if password != "" && (req.PasswordEnabled == nil || *req.PasswordEnabled) {
		hash, err := bcrypt.GenerateFromPassword([]byte(password), 10)
		if err != nil {
			response.Fail(c, err)
			return
		}
		value := string(hash)
		passwordHash = &value
	} else if req.PasswordEnabled != nil && *req.PasswordEnabled && existing != nil {
		passwordHash = existing.PasswordHash
	}
	shareCode := ""
	if existing != nil && existing.Enabled && strings.TrimSpace(existing.ShareCode) != "" {
		shareCode = existing.ShareCode
	} else {
		shareCode, err = agentRandomCode(18)
		if err != nil {
			response.Fail(c, err)
			return
		}
	}
	var row *ent.KBArticleShare
	if existing == nil {
		create := h.client.KBArticleShare.Create().SetUserID(userID).SetArticleID(article.ID).
			SetShareCode(shareCode).SetEnabled(true)
		if expiresAt != nil {
			create.SetExpiresAt(*expiresAt)
		}
		if passwordHash != nil {
			create.SetPasswordHash(*passwordHash)
		}
		row, err = create.Save(c.Request.Context())
	} else {
		update := existing.Update().SetShareCode(shareCode).SetEnabled(true).ClearRevokedAt()
		if expiresAt == nil {
			update.ClearExpiresAt()
		} else {
			update.SetExpiresAt(*expiresAt)
		}
		if passwordHash == nil {
			update.ClearPasswordHash()
		} else {
			update.SetPasswordHash(*passwordHash)
		}
		row, err = update.Save(c.Request.Context())
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, agentShareResponse(row))
}

// ShareInfoREST 查询文章分享状态。
func (h *Handler) ShareInfoREST(c *gin.Context) {
	var req struct {
		ArticleID agentID `json:"articleId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	articleID, err := parseAgentID(string(req.ArticleID), "articleId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	userID := agentUserID(c)
	if _, err := h.client.KBArticle.Query().
		Where(kbarticle.IDEQ(articleID), kbarticle.UserIDEQ(userID)).
		Only(c.Request.Context()); err != nil {
		if ent.IsNotFound(err) {
			response.Fail(c, response.NotFound("文章不存在"))
			return
		}
		response.Fail(c, err)
		return
	}
	row, err := h.client.KBArticleShare.Query().
		Where(kbarticleshare.ArticleIDEQ(articleID), kbarticleshare.UserIDEQ(userID)).
		Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			response.OK(c, gin.H{
				"articleId": fmt.Sprintf("%d", articleID), "shareCode": nil, "shareUrl": nil,
				"enabled": false, "hasPassword": false, "expiresAt": nil, "updatedAt": nil,
			})
			return
		}
		response.Fail(c, err)
		return
	}
	payload := agentShareResponse(row)
	if !row.Enabled || row.RevokedAt != nil {
		payload["shareCode"] = nil
	}
	response.OK(c, payload)
}

// ShareRevokeREST 撤销文章分享。
func (h *Handler) ShareRevokeREST(c *gin.Context) {
	var req struct {
		ArticleID agentID `json:"articleId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	articleID, err := parseAgentID(string(req.ArticleID), "articleId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	userID := agentUserID(c)
	if _, err := h.client.KBArticle.Query().Where(
		kbarticle.IDEQ(articleID), kbarticle.UserIDEQ(userID),
	).Only(c.Request.Context()); err != nil {
		if ent.IsNotFound(err) {
			response.Fail(c, response.NotFound("文章不存在"))
		} else {
			response.Fail(c, err)
		}
		return
	}
	share, err := h.client.KBArticleShare.Query().Where(
		kbarticleshare.ArticleIDEQ(articleID), kbarticleshare.UserIDEQ(userID),
	).Only(c.Request.Context())
	if ent.IsNotFound(err) {
		response.OK(c, gin.H{"articleId": fmt.Sprintf("%d", articleID), "enabled": false, "revokedAt": nil})
		return
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	if !share.Enabled {
		response.OK(c, gin.H{
			"articleId": fmt.Sprintf("%d", articleID), "enabled": false,
			"revokedAt": formatOptionalTime(share.RevokedAt),
		})
		return
	}
	revokedAt := time.Now().UTC()
	if _, err := share.Update().SetEnabled(false).SetRevokedAt(revokedAt).Save(c.Request.Context()); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{
		"articleId": fmt.Sprintf("%d", articleID), "enabled": false,
		"revokedAt": revokedAt.Format(time.RFC3339Nano),
	})
}

// WikiPageListREST 列出知识库 Wiki 页面。
func (h *Handler) WikiPageListREST(c *gin.Context) {
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
	userID := agentUserID(c)
	pages, err := h.kbSvc.ListWikiPagesForAgent(c.Request.Context(), userID, kbID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{
		"knowledgeBaseId": fmt.Sprintf("%d", kbID),
		"pages":           pages,
	})
}

// WikiPageDetailREST 读取 Wiki 页面详情。
func (h *Handler) WikiPageDetailREST(c *gin.Context) {
	var req struct {
		KnowledgeBaseID agentID `json:"knowledgeBaseId"`
		PageKey         string  `json:"pageKey" binding:"required"`
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
	pageKey := strings.TrimSpace(req.PageKey)
	if pageKey == "" || len([]rune(pageKey)) > 200 {
		response.Fail(c, response.BadRequest("pageKey 不能为空且不能超过 200 个字符"))
		return
	}
	detail, err := h.kbSvc.LoadWikiPageDetailForAgent(c.Request.Context(), agentUserID(c), kbID, pageKey)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, detail)
}

// DocumentSearchREST 已迁移至 document_search.go，保留 SearchDocuments 供 /knowledge/search。

// AskDocumentREST 检索 Wiki/源文章上下文，并调用用户的 CHAT 模型回答。
func (h *Handler) AskDocumentREST(c *gin.Context) {
	var req struct {
		ConfigID        *agentID `json:"configId"`
		KnowledgeBaseID *agentID `json:"knowledgeBaseId"`
		Limit           int      `json:"limit"`
		Question        string   `json:"question"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	question := strings.TrimSpace(req.Question)
	if question == "" || len([]rune(question)) > 1000 {
		response.Fail(c, response.BadRequest("question 不能为空且不能超过 1000 个字符"))
		return
	}
	limit := req.Limit
	if limit == 0 {
		limit = 6
	}
	if limit < 1 || limit > 10 {
		response.Fail(c, response.BadRequest("limit 必须在 1 到 10 之间"))
		return
	}
	var kbID *int64
	if req.KnowledgeBaseID != nil && strings.TrimSpace(string(*req.KnowledgeBaseID)) != "" {
		value, err := parseAgentID(string(*req.KnowledgeBaseID), "knowledgeBaseId")
		if err != nil {
			response.Fail(c, err)
			return
		}
		kbID = &value
	}
	var configID *int64
	if req.ConfigID != nil && strings.TrimSpace(string(*req.ConfigID)) != "" {
		value, err := parseAgentID(string(*req.ConfigID), "configId")
		if err != nil {
			response.Fail(c, err)
			return
		}
		configID = &value
	}
	result, err := h.answerAgentDocuments(
		c.Request.Context(), agentUserID(c), configID, kbID, question, limit,
	)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, result)
}

// SkillPack 返回可直接安装的完整 Petrichor Skill ZIP。
func (h *Handler) SkillPack(c *gin.Context) {
	data, err := buildAgentSkillPackageZip(agentRequestBaseURL(c))
	if err != nil {
		response.Fail(c, err)
		return
	}
	c.Header("Content-Type", "application/zip")
	c.Header("Content-Disposition", `attachment; filename="petrichor-agent-skills.zip"`)
	c.Header("Cache-Control", "public, max-age=300")
	c.Data(200, "application/zip", data)
}
