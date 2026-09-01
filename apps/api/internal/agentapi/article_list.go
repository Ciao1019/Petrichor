// article_list.go 负责 Agent API 的文章列表、标签与目录路径查询。
package agentapi

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"petrichor/api/internal/kb"
)

// ===== list =====

type listNodeLite struct {
	id       int64
	parentID *int64
	name     string
}

// AgentListArticles POST /api/agent/article/list（scope doc:read）。
func AgentListArticles(c *gin.Context, actx *authContext) (any, error) {
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
	parentID, hasParentFilter, err := optID(raw, "parentId")
	if err != nil {
		return nil, err
	}
	parentScope := trimmedString(raw, "parentScope")
	if parentScope == "" {
		parentScope = "ANY"
	}
	if parentScope != "ANY" && parentScope != "DIRECT" {
		return nil, badReq("parentScope 非法")
	}
	requiredTags, err := parseTagsInput(raw)
	if err != nil {
		return nil, err
	}
	keyword := trimmedString(raw, "keyword")
	if len([]rune(keyword)) > 200 {
		return nil, badReq("keyword 长度不能超过 200")
	}
	limit := int64(50)
	if v, ok := raw["limit"].(float64); ok && v >= 1 && v <= 200 && float64(int64(v)) == v {
		limit = int64(v)
	}

	q := dbPool()
	ctx := c.Request.Context()
	if _, err := kb.AssertKnowledgeBaseOwnerForAgent(ctx, q, actx.UserID, kbID); err != nil {
		return nil, err
	}

	sqlText := `SELECT a.id, a.knowledge_base_id, a.title, a.created_at, a.updated_at,
		       n.id, n.parent_id, n.name, n.sort_order
		FROM petrichor_kb_article a
		INNER JOIN petrichor_kb_node n ON n.id = a.node_id
		WHERE a.user_id = $1 AND a.knowledge_base_id = $2`
	args := []any{actx.UserID, kbID}
	if keyword != "" {
		args = append(args, "%"+escapeLike(keyword)+"%")
		sqlText += ` AND a.title ILIKE $` + strconv.Itoa(len(args))
	}
	sqlText += ` ORDER BY a.updated_at DESC, a.id DESC`
	rows, err := q.Query(ctx, sqlText, args...)
	if err != nil {
		return nil, err
	}
	type articleListRow struct {
		articleID int64
		title     string
		createdAt time.Time
		updatedAt time.Time
		nodeID    int64
		parentID  *int64
		nodeName  string
		nodeOrder int32
	}
	var rowsData []articleListRow
	for rows.Next() {
		var row articleListRow
		if err := rows.Scan(&row.articleID, new(int64), &row.title, &row.createdAt, &row.updatedAt,
			&row.nodeID, &row.parentID, &row.nodeName, &row.nodeOrder); err != nil {
			rows.Close()
			return nil, err
		}
		rowsData = append(rowsData, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	articleIDs := make([]int64, 0, len(rowsData))
	for i := range rowsData {
		articleIDs = append(articleIDs, rowsData[i].articleID)
	}
	tagsByArticle, err := loadTagsByArticleIDs(ctx, q, articleIDs)
	if err != nil {
		return nil, err
	}
	nodeMap, err := loadListNodeMap(ctx, q, actx.UserID, kbID)
	if err != nil {
		return nil, err
	}

	requiredTagSet := map[string]struct{}{}
	for _, tag := range requiredTags {
		requiredTagSet[tag] = struct{}{}
	}
	filteredByTag := []articleListRow{}
	for i := range rowsData {
		row := &rowsData[i]
		if len(requiredTagSet) == 0 {
			filteredByTag = append(filteredByTag, *row)
			continue
		}
		tags := map[string]struct{}{}
		for _, tag := range tagsByArticle[row.articleID] {
			tags[tag] = struct{}{}
		}
		allMatched := true
		for tag := range requiredTagSet {
			if _, ok := tags[tag]; !ok {
				allMatched = false
				break
			}
		}
		if allMatched {
			filteredByTag = append(filteredByTag, *row)
		}
	}

	filteredByParent := []articleListRow{}
	for i := range filteredByTag {
		row := filteredByTag[i]
		if !hasParentFilter {
			filteredByParent = append(filteredByParent, row)
			continue
		}
		if parentScope == "DIRECT" {
			if sameParentLite(row.parentID, optionalIDPtr(parentID, hasParentFilter)) {
				filteredByParent = append(filteredByParent, row)
			}
			continue
		}
		if !hasParentFilter || isNodeUnderAncestor(nodeMap, row.nodeID, parentID) {
			filteredByParent = append(filteredByParent, row)
		}
	}

	totalAfterFilter := len(filteredByParent)
	if int64(totalAfterFilter) > limit {
		filteredByParent = filteredByParent[:limit]
	}
	items := make([]map[string]any, 0, len(filteredByParent))
	for i := range filteredByParent {
		row := &filteredByParent[i]
		items = append(items, map[string]any{
			"articleId":       idStr(row.articleID),
			"nodeId":          idStr(row.nodeID),
			"knowledgeBaseId": idStr(kbID),
			"parentId":        nullableIDStr(row.parentID),
			"title":           row.title,
			"tags":            tagsFor(tagsByArticle, row.articleID),
			"path":            buildArticlePathLite(nodeMap, row.nodeID),
			"sortOrder":       row.nodeOrder,
			"createdAt":       iso(row.createdAt),
			"updatedAt":       iso(row.updatedAt),
		})
	}
	return map[string]any{
		"knowledgeBaseId": idStr(kbID),
		"items":           items,
		"hasMore":         int64(totalAfterFilter) > limit,
	}, nil
}

func tagsFor(tagsByArticle map[int64][]string, articleID int64) []string {
	if tags, ok := tagsByArticle[articleID]; ok {
		return tags
	}
	return []string{}
}

func loadTagsByArticleIDs(ctx context.Context, q *pgxpool.Pool, articleIDs []int64) (map[int64][]string, error) {
	result := map[int64][]string{}
	if len(articleIDs) == 0 {
		return result, nil
	}
	rows, err := q.Query(ctx,
		`SELECT article_id, tag FROM petrichor_kb_article_tag
		 WHERE article_id = ANY($1) ORDER BY tag ASC`, articleIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var articleID int64
		var tag string
		if err := rows.Scan(&articleID, &tag); err != nil {
			return nil, err
		}
		result[articleID] = append(result[articleID], tag)
	}
	return result, rows.Err()
}

func loadListNodeMap(ctx context.Context, q *pgxpool.Pool, userID, knowledgeBaseID int64) (map[int64]listNodeLite, error) {
	rows, err := q.Query(ctx,
		`SELECT id, parent_id, name FROM petrichor_kb_node
		 WHERE user_id = $1 AND knowledge_base_id = $2`, userID, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[int64]listNodeLite{}
	for rows.Next() {
		var node listNodeLite
		if err := rows.Scan(&node.id, &node.parentID, &node.name); err != nil {
			return nil, err
		}
		result[node.id] = node
	}
	return result, rows.Err()
}

// isNodeUnderAncestor 对照 handlers.ts 同名函数。
func isNodeUnderAncestor(nodeMap map[int64]listNodeLite, nodeID, ancestorID int64) bool {
	current, ok := nodeMap[nodeID]
	depth := 0
	for ok && depth < 100 {
		if current.parentID != nil && *current.parentID == ancestorID {
			return true
		}
		if current.parentID == nil {
			return false
		}
		current, ok = nodeMap[*current.parentID]
		depth++
	}
	return false
}

// buildArticlePathLite 对照 share-logic.ts buildArticlePath（"/a/b" 形式）。
func buildArticlePathLite(nodeMap map[int64]listNodeLite, nodeID int64) string {
	if nodeID <= 0 {
		return "/"
	}
	names := []string{}
	visited := map[int64]struct{}{}
	current, ok := nodeMap[nodeID]
	depth := 0
	for ok && depth <= 100 {
		if _, seen := visited[current.id]; seen {
			return "/"
		}
		visited[current.id] = struct{}{}
		names = append([]string{current.name}, names...)
		if current.parentID == nil {
			break
		}
		current, ok = nodeMap[*current.parentID]
		depth++
	}
	if len(names) == 0 {
		return "/"
	}
	return "/" + strings.Join(names, "/")
}
