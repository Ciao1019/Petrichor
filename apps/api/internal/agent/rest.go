package agent

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/agentapikey"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticle"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbnode"
	"github.com/Ciao1019/Petrichor/apps/api/ent/knowledgebase"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
	"github.com/Ciao1019/Petrichor/apps/api/internal/kb"
)

const (
	ctxAgentKey  = "agent_api_key"
	ctxAgentUser = "agent_user_id"
)

func (h *Handler) APIKeyAuth(requiredScopes ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := extractAgentToken(c)
		if token == "" {
			response.Fail(c, response.Unauthorized("缺少 Agent API Key"))
			return
		}
		sum := sha256.Sum256([]byte(token))
		hash := hex.EncodeToString(sum[:])
		key, err := h.client.AgentAPIKey.Query().
			Where(
				agentapikey.KeyHashEQ(hash),
				agentapikey.RevokedAtIsNil(),
			).
			Only(c.Request.Context())
		if err != nil || (key.ExpiresAt != nil && !key.ExpiresAt.After(time.Now().UTC())) {
			response.Fail(c, response.Unauthorized("Agent API Key 无效或已过期"))
			return
		}
		scopes := parseScopes(key.ScopesJSON)
		scopeSet := make(map[string]bool, len(scopes))
		for _, s := range scopes {
			scopeSet[s] = true
		}
		_, _ = key.Update().SetLastUsedAt(time.Now().UTC()).Save(c.Request.Context())
		c.Set(ctxAgentKey, key)
		c.Set(ctxAgentUser, key.UserID)
		c.Set(ctxAgentScopes, scopeSet)

		startedAt := time.Now()
		requestText := readAgentRequestText(c)
		writer := &agentAuditWriter{ResponseWriter: c.Writer}
		c.Writer = writer
		missing := ""
		for _, scope := range requiredScopes {
			if !scopeSet[scope] {
				missing = scope
				break
			}
		}
		if missing != "" {
			response.Fail(c, response.Forbidden("当前 API Key 缺少 "+missing+" 权限"))
		} else {
			c.Next()
		}
		h.recordAgentCall(c, key, requestText, writer.body.String(), time.Since(startedAt))
	}
}

const ctxAgentScopes = "agent_scopes"

type agentAuditWriter struct {
	gin.ResponseWriter
	body bytes.Buffer
}

func (w *agentAuditWriter) Write(data []byte) (int, error) {
	_, _ = w.body.Write(data)
	return w.ResponseWriter.Write(data)
}

func (w *agentAuditWriter) WriteString(value string) (int, error) {
	_, _ = w.body.WriteString(value)
	return w.ResponseWriter.WriteString(value)
}

func extractAgentToken(c *gin.Context) string {
	authorization := strings.TrimSpace(c.GetHeader("Authorization"))
	parts := strings.SplitN(authorization, " ", 2)
	if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") && strings.TrimSpace(parts[1]) != "" {
		return strings.TrimSpace(parts[1])
	}
	return strings.TrimSpace(c.GetHeader("X-Petrichor-Api-Key"))
}

func readAgentRequestText(c *gin.Context) *string {
	if c.Request.Body == nil {
		return nil
	}
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		return nil
	}
	c.Request.Body = io.NopCloser(bytes.NewReader(body))
	return clipAgentLogText(string(body), 100_000)
}

func clipAgentLogText(value string, maxLength int) *string {
	if value == "" {
		return nil
	}
	runes := []rune(value)
	if len(runes) > maxLength {
		value = fmt.Sprintf("%s\n...[已截断，原始长度 %d]", string(runes[:maxLength]), len(runes))
	}
	return &value
}

func (h *Handler) recordAgentCall(c *gin.Context, key *ent.AgentAPIKey, requestText *string, responseBody string, duration time.Duration) {
	responseText := clipAgentLogText(responseBody, 100_000)
	var errorMessage *string
	if c.Writer.Status() >= 400 {
		var payload struct {
			Message string `json:"msg"`
		}
		if json.Unmarshal([]byte(responseBody), &payload) == nil && strings.TrimSpace(payload.Message) != "" {
			errorMessage = clipAgentLogText(payload.Message, 1000)
		}
	}
	ip := strings.TrimSpace(strings.Split(c.GetHeader("X-Forwarded-For"), ",")[0])
	if ip == "" {
		ip = strings.TrimSpace(c.GetHeader("X-Real-Ip"))
	}
	if ip == "" {
		ip = strings.TrimSpace(c.GetHeader("Cf-Connecting-Ip"))
	}
	userAgent := clipAgentLogText(c.GetHeader("User-Agent"), 1000)
	create := h.client.AgentCallLog.Create().
		SetUserID(key.UserID).
		SetAPIKeyID(key.ID).
		SetAPIKeyPrefix(key.KeyPrefix).
		SetMethod(c.Request.Method).
		SetPath(c.Request.URL.Path).
		SetStatusCode(c.Writer.Status()).
		SetDurationMs(max(0, int(duration.Milliseconds()))).
		SetNillableRequestJSON(requestText).
		SetNillableResponseJSON(responseText).
		SetNillableErrorMessage(errorMessage)
	if ip != "" {
		create.SetIP(ip)
	}
	if userAgent != nil {
		create.SetUserAgent(*userAgent)
	}
	_, _ = create.Save(c.Request.Context())
}

func agentHasScope(c *gin.Context, scope string) bool {
	value, ok := c.Get(ctxAgentScopes)
	if !ok {
		return false
	}
	scopes, ok := value.(map[string]bool)
	return ok && scopes[scope]
}

func agentUserID(c *gin.Context) int64 {
	v, _ := c.Get(ctxAgentUser)
	return v.(int64)
}

func (h *Handler) Manifest(c *gin.Context) {
	c.Header("Cache-Control", "public, max-age=300")
	response.OK(c, buildAgentManifest(agentRequestBaseURL(c)))
}

func (h *Handler) Capabilities(c *gin.Context) {
	userID := agentUserID(c)
	knowledgeBases, err := h.listAgentKnowledgeBases(c.Request.Context(), userID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	keyValue, _ := c.Get(ctxAgentKey)
	key, _ := keyValue.(*ent.AgentAPIKey)
	keyPrefix := ""
	scopes := []string{}
	if key != nil {
		keyPrefix = key.KeyPrefix
		scopes = parseScopes(key.ScopesJSON)
	}
	baseURL := agentRequestBaseURL(c)
	response.OK(c, gin.H{
		"name": "Petrichor Agent API", "version": "2026-06-08", "baseUrl": baseURL,
		"keyPrefix": keyPrefix, "scopes": scopes, "supportedScopes": agentAPIKeyScopes,
		"capabilities": []string{
			"knowledge-base.list", "knowledge-base.tree", "folder.create",
			"article.create", "article.update", "article.delete", "article.list", "article.move",
			"article.share.create", "article.share.revoke", "article.share.info",
			"article.summary.generate", "article.mindmap.generate", "document.search", "document.tree",
			"document.semantic-search", "document.view", "document.qa", "wiki.page.list",
			"wiki.page.detail", "wiki.lint", "wiki.ingest",
		},
		"manifest": buildAgentManifest(baseURL), "mcp": buildAgentMCPInfo(baseURL),
		"knowledgeBases": knowledgeBases,
	})
}

func (h *Handler) ListKnowledgeBases(c *gin.Context) {
	userID := agentUserID(c)
	items, err := h.listAgentKnowledgeBases(c.Request.Context(), userID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"items": items})
}

func (h *Handler) GetKnowledgeBaseTree(c *gin.Context) {
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
	knowledgeBase, err := h.client.KnowledgeBase.Query().
		Where(knowledgebase.IDEQ(kbID), knowledgebase.UserIDEQ(userID)).Only(c.Request.Context())
	if ent.IsNotFound(err) {
		response.Fail(c, response.NotFound("知识库不存在"))
		return
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	nodes, err := h.client.KBNode.Query().
		Where(kbnode.UserIDEQ(userID), kbnode.KnowledgeBaseIDEQ(kbID)).
		Order(ent.Asc(kbnode.FieldSortOrder), ent.Asc(kbnode.FieldID)).
		All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	articles, err := h.client.KBArticle.Query().Where(
		kbarticle.UserIDEQ(userID), kbarticle.KnowledgeBaseIDEQ(kbID),
	).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	articleByNode := make(map[int64]*ent.KBArticle, len(articles))
	for _, article := range articles {
		articleByNode[article.NodeID] = article
	}
	response.OK(c, gin.H{
		"knowledgeBase": gin.H{"id": fmt.Sprintf("%d", knowledgeBase.ID), "name": knowledgeBase.Name, "description": knowledgeBase.Description},
		"roots":         buildAgentTree(nodes, articleByNode, nil),
	})
}

func (h *Handler) ListArticles(c *gin.Context) {
	var req struct {
		KnowledgeBaseID agentID         `json:"knowledgeBaseId"`
		ParentID        json.RawMessage `json:"parentId"`
		ParentScope     string          `json:"parentScope"`
		Tags            []string        `json:"tags"`
		Keyword         string          `json:"keyword"`
		Limit           int             `json:"limit"`
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
	if _, err := h.client.KnowledgeBase.Query().Where(
		knowledgebase.IDEQ(kbID), knowledgebase.UserIDEQ(userID),
	).Only(c.Request.Context()); err != nil {
		if ent.IsNotFound(err) {
			response.Fail(c, response.NotFound("知识库不存在"))
		} else {
			response.Fail(c, err)
		}
		return
	}
	limit := req.Limit
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 200 {
		response.Fail(c, response.BadRequest("limit 必须在 1 到 200 之间"))
		return
	}
	parentScope := strings.TrimSpace(req.ParentScope)
	if parentScope == "" {
		parentScope = "ANY"
	}
	if parentScope != "ANY" && parentScope != "DIRECT" {
		response.Fail(c, response.BadRequest("parentScope 必须是 ANY 或 DIRECT"))
		return
	}
	parentID, hasParentFilter, err := parseOptionalAgentIDJSON(req.ParentID, "parentId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	requiredTags, err := normalizeAgentTags(req.Tags)
	if err != nil {
		response.Fail(c, err)
		return
	}
	query := h.client.KBArticle.Query().
		Where(kbarticle.UserIDEQ(userID), kbarticle.KnowledgeBaseIDEQ(kbID)).
		Order(ent.Desc(kbarticle.FieldUpdatedAt), ent.Desc(kbarticle.FieldID))
	if keyword := strings.TrimSpace(req.Keyword); keyword != "" {
		if len([]rune(keyword)) > 200 {
			response.Fail(c, response.BadRequest("keyword 不能超过 200 个字符"))
			return
		}
		query = query.Where(kbarticle.TitleContainsFold(keyword))
	}
	rows, err := query.All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	nodes, err := h.client.KBNode.Query().Where(
		kbnode.UserIDEQ(userID), kbnode.KnowledgeBaseIDEQ(kbID),
	).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	nodeByID := make(map[int64]*ent.KBNode, len(nodes))
	for _, node := range nodes {
		nodeByID[node.ID] = node
	}
	articleIDs := make([]int64, 0, len(rows))
	for _, row := range rows {
		articleIDs = append(articleIDs, row.ID)
	}
	tagsByArticle, err := h.loadAgentTagsByArticle(c.Request.Context(), articleIDs)
	if err != nil {
		response.Fail(c, err)
		return
	}
	items := make([]gin.H, 0, min(limit, len(rows)))
	total := 0
	for _, row := range rows {
		node := nodeByID[row.NodeID]
		if node == nil || !hasAllAgentTags(tagsByArticle[row.ID], requiredTags) {
			continue
		}
		if hasParentFilter {
			if parentScope == "DIRECT" {
				if !sameOptionalID(node.ParentID, parentID) {
					continue
				}
			} else if parentID != nil && !agentNodeUnderAncestor(nodeByID, node.ID, *parentID) {
				continue
			}
		}
		total++
		if len(items) >= limit {
			continue
		}
		items = append(items, gin.H{
			"articleId": fmt.Sprintf("%d", row.ID), "nodeId": fmt.Sprintf("%d", node.ID),
			"knowledgeBaseId": fmt.Sprintf("%d", row.KnowledgeBaseID), "parentId": formatOptionalID(node.ParentID),
			"title": row.Title, "tags": tagsByArticle[row.ID], "path": buildAgentNodePath(nodeByID, node.ID),
			"sortOrder": node.SortOrder, "createdAt": row.CreatedAt.UTC().Format(time.RFC3339Nano),
			"updatedAt": row.UpdatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	response.OK(c, gin.H{"knowledgeBaseId": fmt.Sprintf("%d", kbID), "items": items, "hasMore": total > len(items)})
}

func (h *Handler) ViewDocument(c *gin.Context) {
	var req struct {
		ArticleID       agentID `json:"articleId"`
		KnowledgeBaseID agentID `json:"knowledgeBaseId"`
		PageKey         string  `json:"pageKey"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	userID := agentUserID(c)
	if strings.TrimSpace(string(req.ArticleID)) == "" {
		if strings.TrimSpace(string(req.KnowledgeBaseID)) == "" || strings.TrimSpace(req.PageKey) == "" {
			response.Fail(c, response.BadRequest("必须提供 articleId，或同时提供 knowledgeBaseId 与 pageKey"))
			return
		}
		kbID, err := parseAgentID(string(req.KnowledgeBaseID), "knowledgeBaseId")
		if err != nil {
			response.Fail(c, err)
			return
		}
		page, err := h.readAgentWikiDocument(c.Request.Context(), userID, kbID, strings.TrimSpace(req.PageKey))
		if err != nil {
			response.Fail(c, err)
			return
		}
		response.OK(c, page)
		return
	}
	id, err := parseAgentID(string(req.ArticleID), "articleId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	row, err := h.client.KBArticle.Query().
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
	tagsByArticle, err := h.loadAgentTagsByArticle(c.Request.Context(), []int64{row.ID})
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{
		"type": "article", "articleId": fmt.Sprintf("%d", row.ID),
		"knowledgeBaseId": fmt.Sprintf("%d", row.KnowledgeBaseID), "nodeId": fmt.Sprintf("%d", row.NodeID),
		"title": row.Title, "contentMd": row.ContentMd, "tags": tagsByArticle[row.ID],
		"createdAt": row.CreatedAt.UTC().Format(time.RFC3339Nano), "updatedAt": row.UpdatedAt.UTC().Format(time.RFC3339Nano),
	})
}

func (h *Handler) CreateArticleREST(c *gin.Context) {
	var req struct {
		KnowledgeBaseID agentID  `json:"knowledgeBaseId"`
		ParentID        *agentID `json:"parentId"`
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
	metadata := kb.DerivePublicArticleMetadata(req.ContentMd)
	tx, err := h.client.Tx(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	nodeBuilder := tx.KBNode.Create().
		SetUserID(userID).SetKnowledgeBaseID(kbID).SetType("ARTICLE").SetName(title).SetSortOrder(sortOrder)
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
		SetUserID(userID).SetKnowledgeBaseID(kbID).SetNodeID(node.ID).
		SetTitle(title).SetContentMd(req.ContentMd).
		SetPublicExcerpt(metadata.Excerpt).SetReadingMinutes(metadata.ReadingMinutes).
		SetTocJSON(metadata.TOCJSON).SetPublicContentHash(metadata.ContentHash)
	if req.ContentJSON != nil && *req.ContentJSON != "" {
		articleBuilder.SetContentJSON(*req.ContentJSON)
	}
	if req.ContentMetaJSON != nil && *req.ContentMetaJSON != "" {
		articleBuilder.SetContentMetaJSON(*req.ContentMetaJSON)
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
		"articleId": fmt.Sprintf("%d", article.ID), "nodeId": fmt.Sprintf("%d", node.ID),
		"knowledgeBaseId": fmt.Sprintf("%d", article.KnowledgeBaseID), "title": article.Title,
		"createdAt": article.CreatedAt.UTC().Format(time.RFC3339Nano),
	})
}

func (h *Handler) Skill(c *gin.Context) {
	baseURL := agentRequestBaseURL(c)
	c.Header("Content-Type", "text/markdown; charset=utf-8")
	c.Header("Content-Disposition", `attachment; filename="SKILL.md"`)
	c.Header("Cache-Control", "public, max-age=300")
	c.String(200, buildAgentSkillMarkdown(baseURL))
}

// Ensure json import used if needed for future payloads.
var _ = json.Marshal
