// kbbrowse.go 对照 handlers.ts：knowledge-base list/tree 与 folder/create。
package agentapi

import (
	"context"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/kb"
)

// listUserKnowledgeBases 对应 wiki-agent-logic.ts listUserKnowledgeBases。
func listUserKnowledgeBases(q querierLike, userID int64) ([]map[string]any, error) {
	rows, err := q.Query(context.Background(),
		`SELECT id, name, description FROM petrichor_kb_knowledge_base
		 WHERE user_id = $1 ORDER BY name ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id int64
		var name string
		var description *string
		if err := rows.Scan(&id, &name, &description); err != nil {
			return nil, err
		}
		items = append(items, map[string]any{
			"id":          idStr(id),
			"name":        name,
			"description": description,
		})
	}
	return items, rows.Err()
}

// AgentListKnowledgeBases POST /api/agent/knowledge-base/list（scope doc:read）。
func AgentListKnowledgeBases(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "doc:read"); err != nil {
		return nil, err
	}
	items, err := listUserKnowledgeBases(dbPool(), actx.UserID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"items": items}, nil
}

type agentTreeNode struct {
	id        string
	parentID  *string
	nodeType  string
	name      string
	articleID *string
	sortOrder int32
	children  []map[string]any
}

func (t *agentTreeNode) toMap() map[string]any {
	children := t.children
	if children == nil {
		children = []map[string]any{}
	}
	return map[string]any{
		"id":        t.id,
		"parentId":  t.parentID,
		"type":      t.nodeType,
		"name":      t.name,
		"articleId": t.articleID,
		"sortOrder": t.sortOrder,
		"children":  children,
	}
}

type kbNodeLite struct {
	id              int64
	knowledgeBaseID int64
	parentID        *int64
	nodeType        string
	name            string
	sortOrder       int32
}

// AgentKnowledgeBaseTree POST /api/agent/knowledge-base/tree（scope doc:read）。
func AgentKnowledgeBaseTree(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "doc:read"); err != nil {
		return nil, err
	}
	raw, err := readBodyMap(c)
	if err != nil {
		return nil, err
	}
	kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
	if err != nil {
		return nil, err
	}
	q := dbPool()
	ctx := context.Background()
	kbRow, err := kb.AssertKnowledgeBaseOwnerForAgent(q, actx.UserID, kbID)
	if err != nil {
		return nil, err
	}

	nodeRows, err := q.Query(ctx,
		`SELECT id, knowledge_base_id, parent_id, type, name, sort_order
		 FROM petrichor_kb_node
		 WHERE user_id = $1 AND knowledge_base_id = $2
		 ORDER BY sort_order ASC, id ASC`, actx.UserID, kbID)
	if err != nil {
		return nil, err
	}
	var nodes []kbNodeLite
	for nodeRows.Next() {
		var n kbNodeLite
		if err := nodeRows.Scan(&n.id, &n.knowledgeBaseID, &n.parentID, &n.nodeType, &n.name, &n.sortOrder); err != nil {
			nodeRows.Close()
			return nil, err
		}
		nodes = append(nodes, n)
	}
	nodeRows.Close()
	if err := nodeRows.Err(); err != nil {
		return nil, err
	}

	articleNodeIDs := make([]int64, 0, len(nodes))
	for _, node := range nodes {
		if node.nodeType == "ARTICLE" {
			articleNodeIDs = append(articleNodeIDs, node.id)
		}
	}
	articleByNodeID := map[int64]int64{}
	if len(articleNodeIDs) > 0 {
		articleRows, aerr := q.Query(ctx,
			`SELECT id, node_id FROM petrichor_kb_article
			 WHERE user_id = $1 AND knowledge_base_id = $2`, actx.UserID, kbID)
		if aerr != nil {
			return nil, aerr
		}
		for articleRows.Next() {
			var id, nodeID int64
			if err := articleRows.Scan(&id, &nodeID); err != nil {
				articleRows.Close()
				return nil, err
			}
			articleByNodeID[nodeID] = id
		}
		articleRows.Close()
		if err := articleRows.Err(); err != nil {
			return nil, err
		}
	}

	roots := buildAgentTreeNodes(nodes, articleByNodeID, nil)
	return map[string]any{
		"knowledgeBase": map[string]any{
			"id":          idStr(kbRow.ID),
			"name":        kbRow.Name,
			"description": kbRow.Description,
		},
		"roots": roots,
	}, nil
}

func buildAgentTreeNodes(nodes []kbNodeLite, articleByNodeID map[int64]int64, parentID *int64) []map[string]any {
	out := []map[string]any{}
	for i := range nodes {
		node := &nodes[i]
		nodeParent := node.parentID
		if (nodeParent == nil) != (parentID == nil) {
			continue
		}
		if nodeParent != nil && *nodeParent != *parentID {
			continue
		}
		item := &agentTreeNode{
			id:        idStr(node.id),
			nodeType:  node.nodeType,
			name:      node.name,
			sortOrder: node.sortOrder,
		}
		if nodeParent != nil {
			s := idStr(*nodeParent)
			item.parentID = &s
		}
		if articleID, ok := articleByNodeID[node.id]; ok {
			s := idStr(articleID)
			item.articleID = &s
		}
		item.children = buildAgentTreeNodes(nodes, articleByNodeID, &node.id)
		out = append(out, item.toMap())
	}
	return out
}

// AgentCreateFolder POST /api/agent/folder/create（scope article:write）。
func AgentCreateFolder(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "article:write"); err != nil {
		return nil, err
	}
	raw, err := readBodyMap(c)
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
	parentID, hasParent, err := optID(raw, "parentId")
	if err != nil {
		return nil, err
	}
	q := dbPool()
	ctx := context.Background()
	if _, err := kb.AssertKnowledgeBaseOwnerForAgent(q, actx.UserID, kbID); err != nil {
		return nil, err
	}
	if err := assertFolderParent(q, actx.UserID, kbID, parentID, hasParent); err != nil {
		return nil, err
	}
	sortOrder, err := nextSortOrder(q, actx.UserID, kbID, parentID, hasParent)
	if err != nil {
		return nil, err
	}
	var nodeID int64
	if err := q.QueryRow(ctx,
		`INSERT INTO petrichor_kb_node (user_id, knowledge_base_id, parent_id, type, name, sort_order)
		 VALUES ($1, $2, $3, 'FOLDER', $4, $5) RETURNING id`,
		actx.UserID, kbID, optionalIDArg(parentID, hasParent), name, sortOrder).Scan(&nodeID); err != nil {
		return nil, err
	}
	return map[string]any{
		"nodeId":          idStr(nodeID),
		"knowledgeBaseId": idStr(kbID),
		"parentId":        nullableIDStr(optionalIDPtr(parentID, hasParent)),
		"name":            name,
		"createdAt":       iso(time.Now()),
	}, nil
}

func optionalIDArg(id int64, valid bool) any {
	if !valid {
		return nil
	}
	return id
}

func optionalIDPtr(id int64, valid bool) *int64 {
	if !valid {
		return nil
	}
	return &id
}

// assertFolderParent 对照 handlers.ts：父节点必须是当前知识库下的 FOLDER。
func assertFolderParent(q querierLike, userID, knowledgeBaseID, parentID int64, hasParent bool) error {
	if !hasParent {
		return nil
	}
	row := q.QueryRow(context.Background(),
		`SELECT knowledge_base_id, type FROM petrichor_kb_node WHERE id = $1 AND user_id = $2 LIMIT 1`,
		parentID, userID)
	var nodeKbID int64
	var nodeType string
	err := row.Scan(&nodeKbID, &nodeType)
	if err != nil {
		if err == pgx.ErrNoRows {
			return badReq("父节点必须是当前知识库下的文件夹")
		}
		return err
	}
	if nodeKbID != knowledgeBaseID || nodeType != "FOLDER" {
		return badReq("父节点必须是当前知识库下的文件夹")
	}
	return nil
}

// nextSortOrder 取同级最大 sort_order + 1（对照 handlers.ts nextSortOrder）。
func nextSortOrder(q querierLike, userID, knowledgeBaseID, parentID int64, hasParent bool) (int32, error) {
	sqlText := `SELECT COALESCE(MAX(sort_order), 0) FROM petrichor_kb_node
		WHERE user_id = $1 AND knowledge_base_id = $2`
	args := []any{userID, knowledgeBaseID}
	if hasParent {
		sqlText += ` AND parent_id = $3`
		args = append(args, parentID)
	} else {
		sqlText += ` AND parent_id IS NULL`
	}
	var max int32
	if err := q.QueryRow(context.Background(), sqlText, args...).Scan(&max); err != nil {
		return 0, err
	}
	return max + 1, nil
}
