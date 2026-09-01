// node_handlers.go 提供知识库目录树节点端点。
package kb

import (
	httpx "petrichor/api/internal/httpx"
	"strconv"

	"github.com/gin-gonic/gin"
)

// ===== 端点 =====

// TreeNodes 全量目录树（含状态徽标与关键字过滤）。
func TreeNodes(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		input, err := parseNodeTreeInput(raw)
		if err != nil {
			return nil, err
		}
		q := pool()
		if _, err := assertKnowledgeBaseOwner(c.Request.Context(), q, user.ID, input.KnowledgeBaseID); err != nil {
			return nil, err
		}
		graph, err := loadKnowledgeBaseGraph(c.Request.Context(), q, user.ID, input.KnowledgeBaseID)
		if err != nil {
			return nil, err
		}
		idx := indexGraph(graph)
		roots := filterTreeByKeyword(buildTree(graph, idx, nil, true), input.Keyword)

		totalFolders := 0
		for _, node := range roots {
			if node.Type == "FOLDER" {
				totalFolders++
			}
		}
		return map[string]any{
			"knowledgeBaseId": strconv.FormatInt(input.KnowledgeBaseID, 10),
			"pageNum":         pageNumOr(input.PageNum, 1),
			"pageSize":        pageNumOr(input.PageSize, 20),
			"totalFolders":    totalFolders,
			"roots":           nodesToMaps(roots),
		}, nil
	})
}

// RootNodes 根层级分页列表（children 一律为空）。
func RootNodes(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		input, err := parseNodeTreeInput(raw)
		if err != nil {
			return nil, err
		}
		q := pool()
		if _, err := assertKnowledgeBaseOwner(c.Request.Context(), q, user.ID, input.KnowledgeBaseID); err != nil {
			return nil, err
		}
		graph, err := loadKnowledgeBaseGraph(c.Request.Context(), q, user.ID, input.KnowledgeBaseID)
		if err != nil {
			return nil, err
		}
		idx := indexGraph(graph)
		filtered := filterTreeByKeyword(buildTree(graph, idx, nil, true), input.Keyword)
		roots := shallowTreeNodes(filtered)
		p := httpx.ResolvePagination(input.PaginationInput)
		start := p.Offset
		if start > int64(len(roots)) {
			start = int64(len(roots))
		}
		end := start + p.Limit
		if end > int64(len(roots)) {
			end = int64(len(roots))
		}
		page := roots[start:end]

		totalFolders := 0
		for _, node := range roots {
			if node.Type == "FOLDER" {
				totalFolders++
			}
		}
		return map[string]any{
			"knowledgeBaseId": strconv.FormatInt(input.KnowledgeBaseID, 10),
			"pageNum":         pageNumOr(input.PageNum, 1),
			"pageSize":        pageNumOr(input.PageSize, 20),
			"totalFolders":    totalFolders,
			"roots":           nodesToMaps(page),
		}, nil
	})
}

// ChildNodes 指定父节点的直接子级（children 为空数组）。
func ChildNodes(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		parentID := parseOptionalID(raw, "parentId")
		q := pool()
		if _, err := assertKnowledgeBaseOwner(c.Request.Context(), q, user.ID, kbID); err != nil {
			return nil, err
		}
		if _, err := assertFolderParent(c.Request.Context(), q, user.ID, kbID, parentID); err != nil {
			return nil, err
		}
		graph, err := loadKnowledgeBaseGraph(c.Request.Context(), q, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		idx := indexGraph(graph)
		flat := shallowTreeNodes(buildTree(graph, idx, parentID, true))

		var parentOut any
		if parentID != nil {
			parentOut = ptrString(strconv.FormatInt(*parentID, 10))
		}
		nodes := make([]map[string]any, 0, len(flat))
		for _, node := range flat {
			nodes = append(nodes, node.toMap())
		}
		return map[string]any{
			"knowledgeBaseId": strconv.FormatInt(kbID, 10),
			"parentId":        parentOut,
			"nodes":           nodes,
		}, nil
	})
}

// DetailNode 单节点详情（含路径，不带状态徽标）。
func DetailNode(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		nodeID, err := reqID(raw["nodeId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		q := pool()
		if _, err := assertKnowledgeBaseOwner(c.Request.Context(), q, user.ID, kbID); err != nil {
			return nil, err
		}
		node, err := assertNodeOwner(c.Request.Context(), q, user.ID, nodeID)
		if err != nil {
			return nil, err
		}
		if node.KnowledgeBaseID != kbID {
			return nil, notFoundErr("节点不存在")
		}
		graph, err := loadKnowledgeBaseGraph(c.Request.Context(), q, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		idx := indexGraph(graph)
		var articleID any
		if article, ok := idx.articleByNodeID[node.ID]; ok {
			articleID = strconv.FormatInt(article.ID, 10)
		}
		return map[string]any{
			"knowledgeBaseId": strconv.FormatInt(kbID, 10),
			"nodeId":          strconv.FormatInt(node.ID, 10),
			"parentId":        nullableIDString(node.ParentID),
			"type":            node.Type,
			"name":            node.Name,
			"path":            buildPath(idx.nodeByID, node.ID),
			"articleId":       articleID,
		}, nil
	})
}

// MoveNode 移动节点并重排同级顺序（对应 moveNode + node-move-logic）。
func MoveNode(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		nodeID, err := reqID(raw["nodeId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		targetParentID := parseOptionalID(raw, "targetParentId")

		var targetIndexPtr *int
		if v, ok := raw["targetIndex"].(float64); ok {
			n := int(v)
			if float64(n) != v || n < 0 {
				return nil, badReq("targetIndex 非法")
			}
			targetIndexPtr = &n
		}

		q := pool()
		if _, err := assertKnowledgeBaseOwner(c.Request.Context(), q, user.ID, kbID); err != nil {
			return nil, err
		}
		node, err := assertNodeOwner(c.Request.Context(), q, user.ID, nodeID)
		if err != nil {
			return nil, err
		}
		if node.KnowledgeBaseID != kbID {
			return nil, notFoundErr("节点不存在")
		}
		if _, err := assertFolderParent(c.Request.Context(), q, user.ID, kbID, targetParentID); err != nil {
			return nil, err
		}

		allNodes, err := queryNodes(c.Request.Context(), q,
			`SELECT `+nodeColumns+` FROM petrichor_kb_node
			 WHERE user_id = $1 AND knowledge_base_id = $2`, user.ID, kbID)
		if err != nil {
			return nil, err
		}

		if isDescendantNode(allNodes, node.ID, targetParentID) {
			return nil, badReq("不能把文件夹移动到自身或子文件夹中")
		}

		sourceParentID := node.ParentID
		sourceSiblings := siblingsOf(allNodes, sourceParentID)
		targetSiblings := siblingsOf(allNodes, targetParentID)

		targetSiblingIDs := nodeIDs(targetSiblings)
		targetOrder := moveNodeIDIntoSiblingOrder(targetSiblingIDs, node.ID, targetIndexPtr)

		var sourceOrder []int64
		if sameParent(sourceParentID, targetParentID) {
			sourceOrder = targetOrder
		} else {
			for _, id := range nodeIDs(sourceSiblings) {
				if id != node.ID {
					sourceOrder = append(sourceOrder, id)
				}
			}
		}

		ctx := c
		if !sameParent(sourceParentID, targetParentID) {
			for index, id := range sourceOrder {
				if _, err := q.Exec(ctx,
					`UPDATE petrichor_kb_node SET sort_order = $1, updated_at = now() WHERE id = $2 AND user_id = $3`,
					int32(index+1), id, user.ID); err != nil {
					return nil, err
				}
			}
		}
		for index, id := range targetOrder {
			if id == node.ID {
				if _, err := q.Exec(ctx,
					`UPDATE petrichor_kb_node SET parent_id = $1, sort_order = $2, updated_at = now()
					 WHERE id = $3 AND user_id = $4`,
					targetParentID, int32(index+1), id, user.ID); err != nil {
					return nil, err
				}
				continue
			}
			if _, err := q.Exec(ctx,
				`UPDATE petrichor_kb_node SET sort_order = $1, updated_at = now() WHERE id = $2 AND user_id = $3`,
				int32(index+1), id, user.ID); err != nil {
				return nil, err
			}
		}

		if !sameParent(sourceParentID, targetParentID) {
			invalidatePublicArticleListCache()
			invalidatePublicArticleDetailCache("")
		}

		ordered := make([]string, 0, len(targetOrder))
		for _, id := range targetOrder {
			ordered = append(ordered, strconv.FormatInt(id, 10))
		}
		return map[string]any{
			"knowledgeBaseId": strconv.FormatInt(kbID, 10),
			"nodeId":          strconv.FormatInt(node.ID, 10),
			"parentId":        nullableIDString(targetParentID),
			"orderedNodeIds":  ordered,
		}, nil
	})
}

// CreateFolder 新建文件夹。
func CreateFolder(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		name := trimmedString(raw, "name")
		if name == "" || len([]rune(name)) > 200 {
			return nil, badReq("文件夹名称必须在 1 到 200 个字符之间")
		}
		parentID := parseOptionalID(raw, "parentId")
		q := pool()
		if _, err := assertKnowledgeBaseOwner(c.Request.Context(), q, user.ID, kbID); err != nil {
			return nil, err
		}
		if _, err := assertFolderParent(c.Request.Context(), q, user.ID, kbID, parentID); err != nil {
			return nil, err
		}
		sortOrder, err := nextSortOrder(c.Request.Context(), q, user.ID, kbID, parentID)
		if err != nil {
			return nil, err
		}
		var nodeID int64
		if err := q.QueryRow(c.Request.Context(),
			`INSERT INTO petrichor_kb_node (user_id, knowledge_base_id, parent_id, type, name, sort_order)
			 VALUES ($1, $2, $3, 'FOLDER', $4, $5) RETURNING id`,
			user.ID, kbID, parentID, name, sortOrder).Scan(&nodeID); err != nil {
			return nil, err
		}
		return map[string]any{"nodeId": strconv.FormatInt(nodeID, 10)}, nil
	})
}

// UpdateFolder 重命名文件夹。
func UpdateFolder(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		nodeID, err := reqID(raw["nodeId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		name := trimmedString(raw, "name")
		if name == "" || len([]rune(name)) > 200 {
			return nil, badReq("文件夹名称必须在 1 到 200 个字符之间")
		}
		q := pool()
		node, err := assertNodeOwner(c.Request.Context(), q, user.ID, nodeID)
		if err != nil {
			return nil, err
		}
		if node.Type != "FOLDER" {
			return nil, badReq("只能重命名文件夹")
		}
		if _, err := q.Exec(c.Request.Context(),
			`UPDATE petrichor_kb_node SET name = $1, updated_at = now() WHERE id = $2 AND user_id = $3`,
			name, nodeID, user.ID); err != nil {
			return nil, err
		}
		return map[string]any{"nodeId": strconv.FormatInt(nodeID, 10)}, nil
	})
}

// DeleteFolder 级联删除子树、文章、标签与 Wiki 派生数据。
func DeleteFolder(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		nodeID, err := reqID(raw["nodeId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		q := pool()
		node, err := assertNodeOwner(c.Request.Context(), q, user.ID, nodeID)
		if err != nil {
			return nil, err
		}
		if node.Type != "FOLDER" {
			return nil, badReq("只能删除文件夹")
		}
		allNodes, err := queryNodes(c.Request.Context(), q,
			`SELECT `+nodeColumns+` FROM petrichor_kb_node
			 WHERE user_id = $1 AND knowledge_base_id = $2`, user.ID, node.KnowledgeBaseID)
		if err != nil {
			return nil, err
		}

		idSet := map[int64]struct{}{node.ID: {}}
		changed := true
		for changed {
			changed = false
			for i := range allNodes {
				item := &allNodes[i]
				if item.ParentID != nil {
					if _, has := idSet[*item.ParentID]; has {
						if _, hasSelf := idSet[item.ID]; !hasSelf {
							idSet[item.ID] = struct{}{}
							changed = true
						}
					}
				}
			}
		}
		nodeIDsList := setToSortedSlice(idSet)

		articleRows, err := queryArticles(c.Request.Context(), q,
			`SELECT `+articleColumns+` FROM petrichor_kb_article
			 WHERE user_id = $1 AND node_id = ANY($2)`, user.ID, nodeIDsList)
		if err != nil {
			return nil, err
		}
		articleIDs := make([]int64, 0, len(articleRows))
		for i := range articleRows {
			articleIDs = append(articleIDs, articleRows[i].ID)
		}
		imageObjectKeys := collectArticleS4ObjectKeys(articleRows, user.ID)

		ctx := c.Request.Context()
		if len(articleIDs) > 0 {
			if _, err := deleteArticleWikiPages(ctx, q, user.ID, articleRows, true); err != nil {
				return nil, err
			}
			if _, err := q.Exec(ctx,
				`DELETE FROM petrichor_kb_article_tag WHERE article_id = ANY($1)`, articleIDs); err != nil {
				return nil, err
			}
		}
		if _, err := q.Exec(ctx,
			`DELETE FROM petrichor_kb_article WHERE user_id = $1 AND node_id = ANY($2)`, user.ID, nodeIDsList); err != nil {
			return nil, err
		}
		if _, err := q.Exec(ctx,
			`DELETE FROM petrichor_kb_node WHERE user_id = $1 AND id = ANY($2)`, user.ID, nodeIDsList); err != nil {
			return nil, err
		}
		ScheduleUnreferencedS4Cleanup(user.ID, imageObjectKeys, "deleteFolder")

		if len(articleIDs) > 0 {
			invalidatePublicArticleListCache()
			invalidatePublicArticleDetailCache("")
		}
		return map[string]any{"nodeId": strconv.FormatInt(nodeID, 10)}, nil
	})
}
