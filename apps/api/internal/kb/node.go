package kb

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticle"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticleshare"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbnode"
	"github.com/Ciao1019/Petrichor/apps/api/ent/knowledgebase"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

type TreeNodeDTO struct {
	ID          string             `json:"id"`
	ParentID    *string            `json:"parentId"`
	Type        string             `json:"type"`
	Name        string             `json:"name"`
	SortOrder   int                `json:"sortOrder"`
	ArticleID   *string            `json:"articleId"`
	HasChildren bool               `json:"hasChildren"`
	Children    []TreeNodeDTO      `json:"children"`
	Status      *ArticleTreeStatus `json:"status,omitempty"`
}

type ArticleTreeStatus struct {
	HasMindmap  bool   `json:"hasMindmap"`
	ShareStatus string `json:"shareStatus"`
}

type treeRequest struct {
	KnowledgeBaseID string `json:"knowledgeBaseId" binding:"required"`
	Keyword         string `json:"keyword"`
	PageNum         int    `json:"pageNum"`
	PageSize        int    `json:"pageSize"`
}

type childrenRequest struct {
	KnowledgeBaseID string  `json:"knowledgeBaseId" binding:"required"`
	ParentID        *string `json:"parentId"`
}

type nodeDetailRequest struct {
	KnowledgeBaseID string `json:"knowledgeBaseId" binding:"required"`
	NodeID          string `json:"nodeId" binding:"required"`
}

type folderRequest struct {
	KnowledgeBaseID string  `json:"knowledgeBaseId" binding:"required"`
	ParentID        *string `json:"parentId"`
	Name            string  `json:"name" binding:"required,min=1"`
	NodeID          string  `json:"nodeId"`
}

func parsePositiveID(raw, field string) (int64, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || id <= 0 {
		return 0, response.BadRequest(field + " 无效")
	}
	return id, nil
}

func (s *Service) assertKBOwner(ctx context.Context, userID, kbID int64) error {
	exists, err := s.client.KnowledgeBase.Query().
		Where(knowledgebase.IDEQ(kbID), knowledgebase.UserIDEQ(userID)).
		Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return response.NotFound("知识库不存在")
	}
	return nil
}

func (s *Service) loadNodes(ctx context.Context, userID, kbID int64) ([]*ent.KBNode, error) {
	return s.client.KBNode.Query().
		Where(kbnode.UserIDEQ(userID), kbnode.KnowledgeBaseIDEQ(kbID)).
		Order(ent.Asc(kbnode.FieldSortOrder), ent.Asc(kbnode.FieldID)).
		All(ctx)
}

func (s *Service) loadArticlesByNode(ctx context.Context, userID, kbID int64) (map[int64]*ent.KBArticle, error) {
	rows, err := s.client.KBArticle.Query().
		Where(kbarticle.UserIDEQ(userID), kbarticle.KnowledgeBaseIDEQ(kbID)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[int64]*ent.KBArticle, len(rows))
	for _, row := range rows {
		out[row.NodeID] = row
	}
	return out, nil
}

func buildTree(nodes []*ent.KBNode, articles map[int64]*ent.KBArticle, statuses map[int64]ArticleTreeStatus, parentID *int64) []TreeNodeDTO {
	out := make([]TreeNodeDTO, 0)
	for _, node := range nodes {
		sameParent := (parentID == nil && node.ParentID == nil) ||
			(parentID != nil && node.ParentID != nil && *node.ParentID == *parentID)
		if !sameParent {
			continue
		}
		dto := TreeNodeDTO{
			ID:        fmt.Sprintf("%d", node.ID),
			Type:      node.Type,
			Name:      node.Name,
			SortOrder: node.SortOrder,
			Children:  []TreeNodeDTO{},
		}
		if node.ParentID != nil {
			v := fmt.Sprintf("%d", *node.ParentID)
			dto.ParentID = &v
		}
		if article, ok := articles[node.ID]; ok {
			id := fmt.Sprintf("%d", article.ID)
			dto.ArticleID = &id
			if status, exists := statuses[article.ID]; exists {
				statusCopy := status
				dto.Status = &statusCopy
			}
		}
		id := node.ID
		dto.Children = buildTree(nodes, articles, statuses, &id)
		dto.HasChildren = len(dto.Children) > 0
		out = append(out, dto)
	}
	return out
}

func filterTree(nodes []TreeNodeDTO, keyword string) []TreeNodeDTO {
	kw := strings.ToLower(strings.TrimSpace(keyword))
	if kw == "" {
		return nodes
	}
	filtered := make([]TreeNodeDTO, 0)
	for _, node := range nodes {
		children := filterTree(node.Children, keyword)
		nameHit := strings.Contains(strings.ToLower(node.Name), kw)
		if nameHit || len(children) > 0 {
			node.Children = children
			node.HasChildren = len(children) > 0
			filtered = append(filtered, node)
		}
	}
	return filtered
}

func (s *Service) loadArticleTreeStatuses(ctx context.Context, articles map[int64]*ent.KBArticle) (map[int64]ArticleTreeStatus, error) {
	statuses := make(map[int64]ArticleTreeStatus, len(articles))
	if len(articles) == 0 {
		return statuses, nil
	}
	articleIDs := make([]int64, 0, len(articles))
	for _, article := range articles {
		articleIDs = append(articleIDs, article.ID)
		statuses[article.ID] = ArticleTreeStatus{
			HasMindmap:  (article.MindmapJSON != nil && strings.TrimSpace(*article.MindmapJSON) != "") || article.MindmapGeneratedAt != nil,
			ShareStatus: "none",
		}
	}
	shares, err := s.client.KBArticleShare.Query().Where(kbarticleshare.ArticleIDIn(articleIDs...)).All(ctx)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	for _, share := range shares {
		status := statuses[share.ArticleID]
		if share.Enabled && share.RevokedAt == nil {
			switch {
			case share.ExpiresAt != nil && !share.ExpiresAt.After(now):
				status.ShareStatus = "expired"
			case share.PasswordHash != nil && strings.TrimSpace(*share.PasswordHash) != "":
				status.ShareStatus = "password"
			default:
				status.ShareStatus = "public"
			}
		}
		statuses[share.ArticleID] = status
	}
	return statuses, nil
}

func (h *Handler) Tree(c *gin.Context) {
	var req treeRequest
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
	nodes, err := h.svc.loadNodes(c.Request.Context(), u.ID, kbID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	articles, err := h.svc.loadArticlesByNode(c.Request.Context(), u.ID, kbID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	statuses, err := h.svc.loadArticleTreeStatuses(c.Request.Context(), articles)
	if err != nil {
		response.Fail(c, err)
		return
	}
	roots := filterTree(buildTree(nodes, articles, statuses, nil), req.Keyword)
	folderCount := 0
	for _, n := range roots {
		if n.Type == "FOLDER" {
			folderCount++
		}
	}
	response.OK(c, gin.H{
		"knowledgeBaseId": fmt.Sprintf("%d", kbID),
		"pageNum":         defaultPositive(req.PageNum, 1),
		"pageSize":        defaultPageSize(req.PageSize),
		"totalFolders":    folderCount,
		"roots":           roots,
	})
}

func (h *Handler) Roots(c *gin.Context) {
	var req treeRequest
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
	nodes, err := h.svc.loadNodes(c.Request.Context(), u.ID, kbID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	articles, err := h.svc.loadArticlesByNode(c.Request.Context(), u.ID, kbID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	statuses, err := h.svc.loadArticleTreeStatuses(c.Request.Context(), articles)
	if err != nil {
		response.Fail(c, err)
		return
	}
	roots := filterTree(buildTree(nodes, articles, statuses, nil), req.Keyword)
	folderCount := 0
	for i := range roots {
		if roots[i].Type == "FOLDER" {
			folderCount++
		}
		roots[i].Children = []TreeNodeDTO{}
	}
	pageNum, pageSize := defaultPositive(req.PageNum, 1), defaultPageSize(req.PageSize)
	start := (pageNum - 1) * pageSize
	if start > len(roots) {
		start = len(roots)
	}
	end := start + pageSize
	if end > len(roots) {
		end = len(roots)
	}
	response.OK(c, gin.H{
		"knowledgeBaseId": fmt.Sprintf("%d", kbID),
		"pageNum":         pageNum,
		"pageSize":        pageSize,
		"totalFolders":    folderCount,
		"roots":           roots[start:end],
	})
}

func defaultPositive(value, fallback int) int {
	if value <= 0 {
		return fallback
	}
	return value
}

func defaultPageSize(value int) int {
	value = defaultPositive(value, 20)
	if value > 100 {
		return 100
	}
	return value
}

func (h *Handler) Children(c *gin.Context) {
	var req childrenRequest
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
	nodes, err := h.svc.loadNodes(c.Request.Context(), u.ID, kbID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	articles, err := h.svc.loadArticlesByNode(c.Request.Context(), u.ID, kbID)
	if err != nil {
		response.Fail(c, err)
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
	statuses, err := h.svc.loadArticleTreeStatuses(c.Request.Context(), articles)
	if err != nil {
		response.Fail(c, err)
		return
	}
	children := buildTree(nodes, articles, statuses, parentID)
	for i := range children {
		children[i].Children = []TreeNodeDTO{}
	}
	var parentStr any
	if parentID == nil {
		parentStr = nil
	} else {
		parentStr = fmt.Sprintf("%d", *parentID)
	}
	response.OK(c, gin.H{
		"knowledgeBaseId": fmt.Sprintf("%d", kbID),
		"parentId":        parentStr,
		"nodes":           children,
	})
}

func (h *Handler) CreateFolder(c *gin.Context) {
	var req folderRequest
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
	builder := h.svc.client.KBNode.Create().
		SetUserID(u.ID).
		SetKnowledgeBaseID(kbID).
		SetType("FOLDER").
		SetName(strings.TrimSpace(req.Name)).
		SetSortOrder(sortOrder)
	if parentID != nil {
		builder.SetParentID(*parentID)
	}
	node, err := builder.Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"nodeId": fmt.Sprintf("%d", node.ID)})
}

func (h *Handler) UpdateFolder(c *gin.Context) {
	var req folderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	nodeID, err := parsePositiveID(req.NodeID, "nodeId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	n, err := h.svc.client.KBNode.Update().
		Where(kbnode.IDEQ(nodeID), kbnode.UserIDEQ(u.ID), kbnode.TypeEQ("FOLDER")).
		SetName(strings.TrimSpace(req.Name)).
		Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	if n == 0 {
		response.Fail(c, response.NotFound("文件夹不存在"))
		return
	}
	response.OK(c, gin.H{"nodeId": fmt.Sprintf("%d", nodeID)})
}

func (h *Handler) DeleteFolder(c *gin.Context) {
	var req struct {
		NodeID string `json:"nodeId" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	nodeID, err := parsePositiveID(req.NodeID, "nodeId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	node, err := h.svc.client.KBNode.Query().Where(kbnode.IDEQ(nodeID), kbnode.UserIDEQ(u.ID)).Only(c.Request.Context())
	if ent.IsNotFound(err) {
		response.Fail(c, response.NotFound("文件夹不存在"))
		return
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	if node.Type != "FOLDER" {
		response.Fail(c, response.BadRequest("只能删除文件夹"))
		return
	}
	n, err := h.svc.client.KBNode.Delete().
		Where(kbnode.IDEQ(nodeID), kbnode.UserIDEQ(u.ID), kbnode.TypeEQ("FOLDER")).
		Exec(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	if n == 0 {
		response.Fail(c, response.NotFound("文件夹不存在"))
		return
	}
	response.OK(c, gin.H{"nodeId": fmt.Sprintf("%d", nodeID)})
}

func (h *Handler) DetailNode(c *gin.Context) {
	var req nodeDetailRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parsePositiveID(req.KnowledgeBaseID, "knowledgeBaseId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	nodeID, err := parsePositiveID(req.NodeID, "nodeId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	node, err := h.svc.client.KBNode.Query().
		Where(kbnode.IDEQ(nodeID), kbnode.UserIDEQ(u.ID), kbnode.KnowledgeBaseIDEQ(kbID)).
		Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			response.Fail(c, response.NotFound("节点不存在"))
			return
		}
		response.Fail(c, err)
		return
	}
	nodes, err := h.svc.loadNodes(c.Request.Context(), u.ID, kbID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	path, err := buildKBNodePath(nodes, node.ID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	dto := gin.H{
		"knowledgeBaseId": fmt.Sprintf("%d", node.KnowledgeBaseID),
		"nodeId":          fmt.Sprintf("%d", node.ID),
		"type":            node.Type,
		"name":            node.Name,
		"path":            path,
		"articleId":       nil,
	}
	if node.ParentID != nil {
		dto["parentId"] = fmt.Sprintf("%d", *node.ParentID)
	} else {
		dto["parentId"] = nil
	}
	articles, err := h.svc.loadArticlesByNode(c.Request.Context(), u.ID, kbID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if article, exists := articles[node.ID]; exists {
		dto["articleId"] = fmt.Sprintf("%d", article.ID)
	}
	response.OK(c, dto)
}

type moveNodeRequest struct {
	KnowledgeBaseID string  `json:"knowledgeBaseId" binding:"required"`
	NodeID          string  `json:"nodeId" binding:"required"`
	TargetParentID  *string `json:"targetParentId"`
	TargetIndex     *int    `json:"targetIndex"`
}

func isDescendantNode(nodes []*ent.KBNode, ancestorID, nodeID int64) bool {
	parentByID := make(map[int64]*int64, len(nodes))
	for _, n := range nodes {
		parentByID[n.ID] = n.ParentID
	}
	visited := make(map[int64]struct{})
	current := nodeID
	for {
		if current == ancestorID {
			return true
		}
		if _, ok := visited[current]; ok {
			return false
		}
		visited[current] = struct{}{}
		parent, ok := parentByID[current]
		if !ok || parent == nil {
			return false
		}
		current = *parent
	}
}

func moveNodeIDIntoSiblingOrder(siblingIDs []int64, movingNodeID int64, targetIndex *int) []int64 {
	without := make([]int64, 0, len(siblingIDs))
	for _, id := range siblingIDs {
		if id != movingNodeID {
			without = append(without, id)
		}
	}
	idx := len(without)
	if targetIndex != nil {
		idx = *targetIndex
		if idx < 0 {
			idx = 0
		}
		if idx > len(without) {
			idx = len(without)
		}
	}
	out := make([]int64, 0, len(without)+1)
	out = append(out, without[:idx]...)
	out = append(out, movingNodeID)
	out = append(out, without[idx:]...)
	return out
}

func sortNodesByOrder(nodes []*ent.KBNode) []*ent.KBNode {
	sorted := append([]*ent.KBNode(nil), nodes...)
	for i := 0; i < len(sorted); i++ {
		for j := i + 1; j < len(sorted); j++ {
			a, b := sorted[i], sorted[j]
			if a.SortOrder > b.SortOrder || (a.SortOrder == b.SortOrder && a.ID > b.ID) {
				sorted[i], sorted[j] = sorted[j], sorted[i]
			}
		}
	}
	return sorted
}

func (h *Handler) MoveNode(c *gin.Context) {
	var req moveNodeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parsePositiveID(req.KnowledgeBaseID, "knowledgeBaseId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	nodeID, err := parsePositiveID(req.NodeID, "nodeId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	ctx := c.Request.Context()
	if err := h.svc.assertKBOwner(ctx, u.ID, kbID); err != nil {
		response.Fail(c, err)
		return
	}

	allNodes, err := h.svc.loadNodes(ctx, u.ID, kbID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	var moving *ent.KBNode
	for _, n := range allNodes {
		if n.ID == nodeID {
			moving = n
			break
		}
	}
	if moving == nil {
		response.Fail(c, response.NotFound("节点不存在"))
		return
	}

	var targetParentID *int64
	if req.TargetParentID != nil && strings.TrimSpace(*req.TargetParentID) != "" {
		id, err := parsePositiveID(*req.TargetParentID, "targetParentId")
		if err != nil {
			response.Fail(c, err)
			return
		}
		if id == nodeID || isDescendantNode(allNodes, nodeID, id) {
			response.Fail(c, response.BadRequest("不能把节点移动到自身或子文件夹中"))
			return
		}
		parent, err := h.svc.client.KBNode.Query().
			Where(
				kbnode.IDEQ(id),
				kbnode.UserIDEQ(u.ID),
				kbnode.KnowledgeBaseIDEQ(kbID),
				kbnode.TypeEQ("FOLDER"),
			).
			Only(ctx)
		if err != nil {
			if ent.IsNotFound(err) {
				response.Fail(c, response.BadRequest("目标文件夹不存在"))
				return
			}
			response.Fail(c, err)
			return
		}
		targetParentID = &parent.ID
	}

	sourceParentID := moving.ParentID
	sameParent := (sourceParentID == nil && targetParentID == nil) ||
		(sourceParentID != nil && targetParentID != nil && *sourceParentID == *targetParentID)

	filterSiblings := func(parentID *int64) []*ent.KBNode {
		out := make([]*ent.KBNode, 0)
		for _, n := range allNodes {
			same := (parentID == nil && n.ParentID == nil) ||
				(parentID != nil && n.ParentID != nil && *n.ParentID == *parentID)
			if same {
				out = append(out, n)
			}
		}
		return sortNodesByOrder(out)
	}

	sourceSiblings := filterSiblings(sourceParentID)
	targetSiblings := filterSiblings(targetParentID)
	sourceIDs := make([]int64, 0, len(sourceSiblings))
	for _, n := range sourceSiblings {
		sourceIDs = append(sourceIDs, n.ID)
	}
	targetIDs := make([]int64, 0, len(targetSiblings))
	for _, n := range targetSiblings {
		targetIDs = append(targetIDs, n.ID)
	}

	targetOrder := moveNodeIDIntoSiblingOrder(targetIDs, nodeID, req.TargetIndex)
	sourceOrder := sourceIDs
	if !sameParent {
		filtered := make([]int64, 0, len(sourceIDs))
		for _, id := range sourceIDs {
			if id != nodeID {
				filtered = append(filtered, id)
			}
		}
		sourceOrder = filtered
	} else {
		sourceOrder = targetOrder
	}

	now := time.Now().UTC()
	if !sameParent {
		for i, id := range sourceOrder {
			if _, err := h.svc.client.KBNode.Update().
				Where(kbnode.IDEQ(id), kbnode.UserIDEQ(u.ID)).
				SetSortOrder(i + 1).
				SetUpdatedAt(now).
				Save(ctx); err != nil {
				response.Fail(c, err)
				return
			}
		}
	}
	for i, id := range targetOrder {
		upd := h.svc.client.KBNode.Update().
			Where(kbnode.IDEQ(id), kbnode.UserIDEQ(u.ID)).
			SetSortOrder(i + 1).
			SetUpdatedAt(now)
		if id == nodeID {
			if targetParentID == nil {
				upd.ClearParentID()
			} else {
				upd.SetParentID(*targetParentID)
			}
		}
		if _, err := upd.Save(ctx); err != nil {
			response.Fail(c, err)
			return
		}
	}

	var parentOut any
	if targetParentID == nil {
		parentOut = nil
	} else {
		parentOut = fmt.Sprintf("%d", *targetParentID)
	}
	ordered := make([]string, 0, len(targetOrder))
	for _, id := range targetOrder {
		ordered = append(ordered, fmt.Sprintf("%d", id))
	}
	response.OK(c, gin.H{
		"knowledgeBaseId": fmt.Sprintf("%d", kbID),
		"nodeId":          req.NodeID,
		"parentId":        parentOut,
		"orderedNodeIds":  ordered,
	})
}
