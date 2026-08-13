package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticletag"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbnode"
	"github.com/Ciao1019/Petrichor/apps/api/ent/knowledgebase"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

type agentTreeNode struct {
	ID        string          `json:"id"`
	ParentID  *string         `json:"parentId"`
	Type      string          `json:"type"`
	Name      string          `json:"name"`
	ArticleID *string         `json:"articleId"`
	SortOrder int             `json:"sortOrder"`
	Children  []agentTreeNode `json:"children"`
}

// agentID 同时接受 JSON 字符串和数字，保持旧版 zod idSchema 的输入兼容性。
type agentID string

func (id *agentID) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		*id = ""
		return nil
	}
	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		*id = agentID(strings.TrimSpace(text))
		return nil
	}
	var number json.Number
	if err := json.Unmarshal(data, &number); err != nil {
		return fmt.Errorf("ID 必须是字符串或数字")
	}
	*id = agentID(strings.TrimSpace(number.String()))
	return nil
}

func buildAgentTree(nodes []*ent.KBNode, articleByNode map[int64]*ent.KBArticle, parentID *int64) []agentTreeNode {
	return buildAgentTreeSafe(nodes, articleByNode, parentID, map[int64]bool{})
}

func buildAgentTreeSafe(nodes []*ent.KBNode, articleByNode map[int64]*ent.KBArticle, parentID *int64, ancestors map[int64]bool) []agentTreeNode {
	out := make([]agentTreeNode, 0)
	for _, node := range nodes {
		if !sameOptionalID(node.ParentID, parentID) || ancestors[node.ID] {
			continue
		}
		item := agentTreeNode{
			ID: fmt.Sprintf("%d", node.ID), ParentID: formatOptionalID(node.ParentID),
			Type: node.Type, Name: node.Name, SortOrder: node.SortOrder, Children: []agentTreeNode{},
		}
		if article := articleByNode[node.ID]; article != nil {
			value := fmt.Sprintf("%d", article.ID)
			item.ArticleID = &value
		}
		id := node.ID
		nextAncestors := make(map[int64]bool, len(ancestors)+1)
		for ancestorID := range ancestors {
			nextAncestors[ancestorID] = true
		}
		nextAncestors[node.ID] = true
		item.Children = buildAgentTreeSafe(nodes, articleByNode, &id, nextAncestors)
		out = append(out, item)
	}
	return out
}

func (h *Handler) listAgentKnowledgeBases(ctx context.Context, userID int64) ([]gin.H, error) {
	rows, err := h.client.KnowledgeBase.Query().Where(
		knowledgebase.UserIDEQ(userID),
	).Order(ent.Asc(knowledgebase.FieldName)).All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		items = append(items, gin.H{"id": fmt.Sprintf("%d", row.ID), "name": row.Name, "description": row.Description})
	}
	return items, nil
}

func parseOptionalAgentIDJSON(raw json.RawMessage, field string) (*int64, bool, error) {
	if len(raw) == 0 {
		return nil, false, nil
	}
	text := strings.TrimSpace(string(raw))
	if text == "null" || text == `""` {
		return nil, true, nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, true, response.BadRequest(field + " 无效")
	}
	id, err := parseAgentID(fmt.Sprint(value), field)
	if err != nil {
		return nil, true, err
	}
	return &id, true, nil
}

func normalizeAgentTags(raw []string) ([]string, error) {
	if len(raw) > 50 {
		return nil, response.BadRequest("标签数量不能超过 50")
	}
	seen := make(map[string]bool, len(raw))
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		tag := strings.TrimSpace(item)
		if tag == "" {
			return nil, response.BadRequest("标签不能为空")
		}
		if utf8.RuneCountInString(tag) > 40 {
			return nil, response.BadRequest("标签长度不能超过 40")
		}
		if !seen[tag] {
			seen[tag] = true
			out = append(out, tag)
		}
	}
	return out, nil
}

func (h *Handler) loadAgentTagsByArticle(ctx context.Context, articleIDs []int64) (map[int64][]string, error) {
	out := make(map[int64][]string, len(articleIDs))
	for _, articleID := range articleIDs {
		out[articleID] = []string{}
	}
	if len(articleIDs) == 0 {
		return out, nil
	}
	rows, err := h.client.KBArticleTag.Query().Where(
		kbarticletag.ArticleIDIn(articleIDs...),
	).Order(ent.Asc(kbarticletag.FieldTag)).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		out[row.ArticleID] = append(out[row.ArticleID], row.Tag)
	}
	return out, nil
}

func hasAllAgentTags(available, required []string) bool {
	if len(required) == 0 {
		return true
	}
	set := make(map[string]bool, len(available))
	for _, tag := range available {
		set[tag] = true
	}
	for _, tag := range required {
		if !set[tag] {
			return false
		}
	}
	return true
}

func sameOptionalID(left, right *int64) bool {
	return (left == nil && right == nil) || (left != nil && right != nil && *left == *right)
}

func formatOptionalID(id *int64) *string {
	if id == nil {
		return nil
	}
	value := fmt.Sprintf("%d", *id)
	return &value
}

func agentShareResponse(share *ent.KBArticleShare) gin.H {
	isRepost := share.IsRepost && share.OriginalURL != nil && strings.TrimSpace(*share.OriginalURL) != "" &&
		share.OriginalAuthorName != nil && strings.TrimSpace(*share.OriginalAuthorName) != ""
	result := gin.H{
		"articleId":          fmt.Sprintf("%d", share.ArticleID),
		"shareCode":          share.ShareCode,
		"shareUrl":           "/p/" + share.ShareCode,
		"enabled":            share.Enabled,
		"hasPassword":        share.PasswordHash != nil && strings.TrimSpace(*share.PasswordHash) != "",
		"expiresAt":          formatOptionalTime(share.ExpiresAt),
		"updatedAt":          formatTime(share.UpdatedAt),
		"isRepost":           isRepost,
		"originalUrl":        nil,
		"originalAuthorName": nil,
	}
	if isRepost {
		result["originalUrl"] = strings.TrimSpace(*share.OriginalURL)
		result["originalAuthorName"] = strings.TrimSpace(*share.OriginalAuthorName)
	}
	return result
}

func agentNodeUnderAncestor(nodes map[int64]*ent.KBNode, nodeID, ancestorID int64) bool {
	current := nodes[nodeID]
	visited := make(map[int64]bool)
	for current != nil && !visited[current.ID] {
		visited[current.ID] = true
		if current.ParentID == nil {
			return false
		}
		if *current.ParentID == ancestorID {
			return true
		}
		current = nodes[*current.ParentID]
	}
	return false
}

func buildAgentNodePath(nodes map[int64]*ent.KBNode, nodeID int64) string {
	names := make([]string, 0)
	visited := make(map[int64]bool)
	current := nodes[nodeID]
	for current != nil && !visited[current.ID] {
		visited[current.ID] = true
		names = append(names, current.Name)
		if current.ParentID == nil {
			break
		}
		current = nodes[*current.ParentID]
	}
	for left, right := 0, len(names)-1; left < right; left, right = left+1, right-1 {
		names[left], names[right] = names[right], names[left]
	}
	return "/" + strings.Join(names, "/")
}

func (h *Handler) assertAgentFolderParent(ctx context.Context, userID, knowledgeBaseID int64, parentID *int64) error {
	if parentID == nil {
		return nil
	}
	parent, err := h.client.KBNode.Query().Where(
		kbnode.IDEQ(*parentID), kbnode.UserIDEQ(userID),
	).Only(ctx)
	if err != nil || parent.KnowledgeBaseID != knowledgeBaseID || parent.Type != "FOLDER" {
		if err != nil && !ent.IsNotFound(err) {
			return err
		}
		return response.BadRequest("父节点必须是当前知识库下的文件夹")
	}
	return nil
}

func (h *Handler) nextAgentSortOrder(ctx context.Context, userID, knowledgeBaseID int64, parentID *int64) (int, error) {
	rows, err := h.client.KBNode.Query().Where(
		kbnode.UserIDEQ(userID), kbnode.KnowledgeBaseIDEQ(knowledgeBaseID),
	).All(ctx)
	if err != nil {
		return 0, err
	}
	maxOrder := 0
	for _, row := range rows {
		if sameOptionalID(row.ParentID, parentID) && row.SortOrder > maxOrder {
			maxOrder = row.SortOrder
		}
	}
	return maxOrder + 1, nil
}

func sortedAgentSiblingIDs(nodes []*ent.KBNode, parentID *int64, excluding *int64) []int64 {
	filtered := make([]*ent.KBNode, 0)
	for _, node := range nodes {
		if sameOptionalID(node.ParentID, parentID) && (excluding == nil || node.ID != *excluding) {
			filtered = append(filtered, node)
		}
	}
	sort.Slice(filtered, func(i, j int) bool {
		return filtered[i].SortOrder < filtered[j].SortOrder ||
			(filtered[i].SortOrder == filtered[j].SortOrder && filtered[i].ID < filtered[j].ID)
	})
	ids := make([]int64, 0, len(filtered))
	for _, node := range filtered {
		ids = append(ids, node.ID)
	}
	return ids
}
