// node.go 对照 handlers.ts 的节点树接口（roots/children/tree/detail/move/folder CRUD）。
package kb

import (
	"context"
	"sort"
	"strconv"
	"time"

	httpx "petrichor/api/internal/httpx"
)

// kbGraph 对应 loadKnowledgeBaseGraph 的返回。
type kbGraph struct {
	nodes     []NodeRow
	articles  []ArticleRow
	shares    []ShareRow
	wikiPages []WikiPageRow
}

// loadKnowledgeBaseGraph 一次性拉取节点/文章/分享/Wiki 源页面。
func loadKnowledgeBaseGraph(ctx context.Context, q execQuerier, userID, knowledgeBaseID int64) (*kbGraph, error) {
	g := &kbGraph{}

	nodeRows, err := q.Query(ctx,
		`SELECT `+nodeColumns+` FROM petrichor_kb_node
		 WHERE user_id = $1 AND knowledge_base_id = $2 ORDER BY sort_order ASC, id ASC`,
		userID, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	for nodeRows.Next() {
		var r NodeRow
		if err := nodeRows.Scan(&r.ID, &r.UserID, &r.KnowledgeBaseID, &r.ParentID, &r.Type, &r.Name,
			&r.SortOrder, &r.CreatedAt, &r.UpdatedAt); err != nil {
			nodeRows.Close()
			return nil, err
		}
		g.nodes = append(g.nodes, r)
	}
	nodeRows.Close()
	if err := nodeRows.Err(); err != nil {
		return nil, err
	}

	articleNodeIDs := make([]int64, 0, len(g.nodes))
	for i := range g.nodes {
		if g.nodes[i].Type == "ARTICLE" {
			articleNodeIDs = append(articleNodeIDs, g.nodes[i].ID)
		}
	}
	if len(articleNodeIDs) > 0 {
		rows, err := q.Query(ctx,
			`SELECT `+articleColumns+` FROM petrichor_kb_article
			 WHERE user_id = $1 AND node_id = ANY($2)`, userID, articleNodeIDs)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			r, err := scanArticleRows(rows)
			if err != nil {
				rows.Close()
				return nil, err
			}
			g.articles = append(g.articles, *r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}

	if len(g.articles) > 0 {
		articleIDs := make([]int64, 0, len(g.articles))
		for i := range g.articles {
			articleIDs = append(articleIDs, g.articles[i].ID)
		}
		shareRows, err := q.Query(ctx,
			`SELECT `+shareColumns+` FROM petrichor_kb_article_share
			 WHERE user_id = $1 AND article_id = ANY($2)`, userID, articleIDs)
		if err != nil {
			return nil, err
		}
		for shareRows.Next() {
			r, err := scanShareRows(shareRows)
			if err != nil {
				shareRows.Close()
				return nil, err
			}
			g.shares = append(g.shares, *r)
		}
		shareRows.Close()
		if err := shareRows.Err(); err != nil {
			return nil, err
		}

		pageKeys := make([]string, 0, len(articleIDs))
		for _, id := range articleIDs {
			pageKeys = append(pageKeys, buildArticleWikiSourcePageKey(id))
		}
		pageRows, err := q.Query(ctx,
			`SELECT `+wikiPageColumns+` FROM petrichor_kb_wiki_page
			 WHERE user_id = $1 AND knowledge_base_id = $2 AND page_key = ANY($3)`,
			userID, knowledgeBaseID, pageKeys)
		if err != nil {
			return nil, err
		}
		for pageRows.Next() {
			r, err := scanWikiPageRows(pageRows)
			if err != nil {
				pageRows.Close()
				return nil, err
			}
			g.wikiPages = append(g.wikiPages, *r)
		}
		pageRows.Close()
		if err := pageRows.Err(); err != nil {
			return nil, err
		}
	}
	return g, nil
}

// treeNodeResponse 对应 TreeNodeResponse。
type treeNodeResponse struct {
	ID          string
	ParentID    *string
	Type        string
	Name        string
	ArticleID   *string
	SortOrder   int32
	HasChildren bool
	Children    []*treeNodeResponse
	Status      map[string]any `json:",omitempty"`
}

func (t *treeNodeResponse) toMap() map[string]any {
	m := map[string]any{
		"id":          t.ID,
		"parentId":    t.ParentID,
		"type":        t.Type,
		"name":        t.Name,
		"articleId":   t.ArticleID,
		"sortOrder":   t.SortOrder,
		"hasChildren": t.HasChildren,
		"children":    childrenToMaps(t.Children),
	}
	if t.Status != nil {
		m["status"] = t.Status
	}
	return m
}

func childrenToMaps(nodes []*treeNodeResponse) []map[string]any {
	out := make([]map[string]any, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, n.toMap())
	}
	return out
}

// shallowTreeNodes 只移除已展开的 children 数据，保留 hasChildren 提示。
// roots/children 接口依赖该提示让前端继续按需加载下一层。
func shallowTreeNodes(nodes []*treeNodeResponse) []*treeNodeResponse {
	out := make([]*treeNodeResponse, 0, len(nodes))
	for _, node := range nodes {
		clone := *node
		clone.Children = nil
		out = append(out, &clone)
	}
	return out
}

// buildArticleWikiSourcePageKey 对应 tree-status-logic.ts 同名函数。
func buildArticleWikiSourcePageKey(articleID int64) string {
	return "source-" + strconv.FormatInt(articleID, 10)
}

// resolveArticleTreeStatus 对应 tree-status-logic.ts：文章树的分享/导图/Wiki 状态徽标。
func resolveArticleTreeStatus(article *ArticleRow, share *ShareRow, wikiPage *WikiPageRow, now time.Time) map[string]any {
	shareStatus := "none"
	listed := share != nil && share.Enabled && share.RevokedAt == nil
	if listed {
		shareStatus = "public"
		if share.ExpiresAt != nil && !share.ExpiresAt.After(now) {
			shareStatus = "expired"
		} else if derefStr(share.PasswordHash) != "" {
			shareStatus = "password"
		}
	}

	wikiStatus := "none"
	if wikiPage != nil && wikiPage.ArchivedAt == nil {
		wikiStatus = "ready"
		if storedHash := readFrontmatterSourceHash(wikiPage.FrontmatterJson); storedHash != "" {
			if storedHash != sha256Hex(article.Title+"\n"+article.ContentMd) {
				wikiStatus = "stale"
			}
		}
	}

	hasMindmap := derefStr(article.MindmapJson) != "" || article.MindmapGeneratedAt != nil
	return map[string]any{
		"hasMindmap":  hasMindmap,
		"shareStatus": shareStatus,
		"wikiStatus":  wikiStatus,
	}
}

// readFrontmatterSourceHash 从 frontmatter JSON 中取 sourceHash 字段。
func readFrontmatterSourceHash(frontmatterJson *string) string {
	obj := parseJSONObject(frontmatterJson)
	if obj == nil {
		return ""
	}
	return stringsTrimmed(obj["sourceHash"])
}

func stringsTrimmed(v any) string {
	if s, ok := v.(string); ok {
		return trimSpace(s)
	}
	return ""
}

// graphIndex 对应 indexGraph 的产物。
type graphIndex struct {
	articleByNodeID map[int64]*ArticleRow
	nodeByID        map[int64]*NodeRow
	statusByNodeID  map[int64]map[string]any
	shareByArticle  map[int64]*ShareRow
	wikiPageByKey   map[string]*WikiPageRow
}

func indexGraph(g *kbGraph) *graphIndex {
	idx := &graphIndex{
		articleByNodeID: map[int64]*ArticleRow{},
		nodeByID:        map[int64]*NodeRow{},
		statusByNodeID:  map[int64]map[string]any{},
		shareByArticle:  map[int64]*ShareRow{},
		wikiPageByKey:   map[string]*WikiPageRow{},
	}
	now := time.Now()
	for i := range g.shares {
		idx.shareByArticle[g.shares[i].ArticleID] = &g.shares[i]
	}
	for i := range g.wikiPages {
		idx.wikiPageByKey[g.wikiPages[i].PageKey] = &g.wikiPages[i]
	}
	for i := range g.nodes {
		idx.nodeByID[g.nodes[i].ID] = &g.nodes[i]
	}
	for i := range g.articles {
		a := &g.articles[i]
		idx.articleByNodeID[a.NodeID] = a
		var share *ShareRow
		var page *WikiPageRow
		if s, ok := idx.shareByArticle[a.ID]; ok {
			share = s
		}
		if p, ok := idx.wikiPageByKey[buildArticleWikiSourcePageKey(a.ID)]; ok {
			page = p
		}
		idx.statusByNodeID[a.NodeID] = resolveArticleTreeStatus(a, share, page, now)
	}
	return idx
}

// buildTree 递归构建节点树；withStatus 控制是否附带文章状态徽标（detail 路径不带）。
func buildTree(g *kbGraph, idx *graphIndex, parentID *int64, withStatus bool) []*treeNodeResponse {
	var out []*treeNodeResponse
	for i := range g.nodes {
		node := &g.nodes[i]
		nodeParent := node.ParentID
		if (nodeParent == nil) != (parentID == nil) {
			continue
		}
		if nodeParent != nil && *nodeParent != *parentID {
			continue
		}
		children := buildTree(g, idx, &node.ID, withStatus)
		item := &treeNodeResponse{
			ID:          strconv.FormatInt(node.ID, 10),
			Type:        node.Type,
			Name:        node.Name,
			SortOrder:   node.SortOrder,
			HasChildren: len(children) > 0,
			Children:    children,
		}
		if node.ParentID != nil {
			s := strconv.FormatInt(*node.ParentID, 10)
			item.ParentID = &s
		}
		if article, ok := idx.articleByNodeID[node.ID]; ok {
			s := strconv.FormatInt(article.ID, 10)
			item.ArticleID = &s
		}
		if withStatus && node.Type == "ARTICLE" {
			if status, ok := idx.statusByNodeID[node.ID]; ok {
				item.Status = status
			}
		}
		out = append(out, item)
	}
	return out
}

// filterTreeByKeyword 关键字过滤：保留命中节点与其祖先链。
func filterTreeByKeyword(nodes []*treeNodeResponse, keyword string) []*treeNodeResponse {
	needle := trimSpace(lower(keyword))
	if needle == "" {
		return nodes
	}
	var out []*treeNodeResponse
	for _, node := range nodes {
		children := filterTreeByKeyword(node.Children, keyword)
		matched := stringsContains(lower(node.Name), needle)
		if !matched && len(children) == 0 {
			continue
		}
		clone := *node
		clone.Children = children
		clone.HasChildren = len(children) > 0
		out = append(out, &clone)
	}
	return out
}

// paginateTreeNodes 按顶层节点分页；总数同时包含根文件夹与根文章。
func paginateTreeNodes(nodes []*treeNodeResponse, input httpx.PaginationInput) ([]*treeNodeResponse, int) {
	p := httpx.ResolvePagination(input)
	start := p.Offset
	if start > int64(len(nodes)) {
		start = int64(len(nodes))
	}
	end := start + p.Limit
	if end > int64(len(nodes)) {
		end = int64(len(nodes))
	}
	return nodes[start:end], len(nodes)
}

// buildPath 从节点向上拼接「 / 」分隔路径。
func buildPath(nodeByID map[int64]*NodeRow, nodeID int64) string {
	var names []string
	visited := map[int64]struct{}{}
	current, ok := nodeByID[nodeID]
	for ok {
		if _, seen := visited[current.ID]; seen {
			break
		}
		visited[current.ID] = struct{}{}
		names = append([]string{current.Name}, names...)
		if current.ParentID == nil {
			break
		}
		current, ok = nodeByID[*current.ParentID]
	}
	result := ""
	for i, name := range names {
		if i > 0 {
			result += " / "
		}
		result += name
	}
	return result
}

// ===== 输入解析 =====

type nodeTreeInput struct {
	httpx.PaginationInput
	KnowledgeBaseID int64
	Keyword         string
	OrderByColumn   *string
}

func parseNodeTreeInput(raw map[string]any) (*nodeTreeInput, error) {
	kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
	if err != nil {
		return nil, err
	}
	input := &nodeTreeInput{KnowledgeBaseID: kbID}
	if v, ok := raw["keyword"]; ok && v != nil {
		input.Keyword = trimSpace(toStr(v))
		if len([]rune(input.Keyword)) > 200 {
			return nil, badReq("keyword 长度不能超过 200")
		}
	}
	if v, ok := raw["pageNum"].(float64); ok && v > 0 {
		pn := int64(v)
		input.PageNum = &pn
	}
	if v, ok := raw["pageSize"].(float64); ok && v > 0 {
		ps := int64(v)
		input.PageSize = &ps
	}
	if v, ok := raw["isAsc"].(string); ok {
		input.IsAsc = &v
	}
	return input, nil
}

func parseOptionalID(raw map[string]any, key string) *int64 {
	v, ok := raw[key]
	if !ok || v == nil {
		return nil
	}
	switch value := v.(type) {
	case string:
		s := trimSpace(value)
		if s == "" {
			return nil
		}
		if n, err := strconv.ParseInt(s, 10, 64); err == nil && n > 0 {
			return &n
		}
	case float64:
		n := int64(value)
		if value > 0 && float64(n) == value {
			return &n
		}
	}
	return nil
}

// ===== 树工具 =====

func queryNodes(ctx context.Context, q execQuerier, sql string, args ...any) ([]NodeRow, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []NodeRow
	for rows.Next() {
		var r NodeRow
		if err := rows.Scan(&r.ID, &r.UserID, &r.KnowledgeBaseID, &r.ParentID, &r.Type, &r.Name,
			&r.SortOrder, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func queryArticles(ctx context.Context, q execQuerier, sql string, args ...any) ([]ArticleRow, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ArticleRow
	for rows.Next() {
		r, err := scanArticleRows(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// isDescendantNode 对应 isDescendantKnowledgeBaseNode。
func isDescendantNode(allNodes []NodeRow, ancestorID int64, nodeID *int64) bool {
	if nodeID == nil {
		return false
	}
	parentByNode := map[int64]*int64{}
	for i := range allNodes {
		parentByNode[allNodes[i].ID] = allNodes[i].ParentID
	}
	visited := map[int64]struct{}{}
	var current *int64 = nodeID
	for current != nil {
		if _, seen := visited[*current]; seen {
			return false
		}
		visited[*current] = struct{}{}
		if *current == ancestorID {
			return true
		}
		parent, ok := parentByNode[*current]
		if !ok {
			return false
		}
		current = parent
	}
	return false
}

func sameParent(a, b *int64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func siblingsOf(allNodes []NodeRow, parentID *int64) []NodeRow {
	var out []NodeRow
	for i := range allNodes {
		nodeParent := allNodes[i].ParentID
		if nodeParent == nil && parentID == nil {
			out = append(out, allNodes[i])
			continue
		}
		if nodeParent != nil && parentID != nil && *nodeParent == *parentID {
			out = append(out, allNodes[i])
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].SortOrder != out[j].SortOrder {
			return out[i].SortOrder < out[j].SortOrder
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func nodeIDs(nodes []NodeRow) []int64 {
	out := make([]int64, 0, len(nodes))
	for i := range nodes {
		out = append(out, nodes[i].ID)
	}
	return out
}

// moveNodeIDIntoSiblingOrder 对应 moveNodeIdIntoSiblingOrder。
func moveNodeIDIntoSiblingOrder(siblingIDs []int64, movingNodeID int64, targetIndex *int) []int64 {
	withoutMoving := make([]int64, 0, len(siblingIDs))
	for _, id := range siblingIDs {
		if id != movingNodeID {
			withoutMoving = append(withoutMoving, id)
		}
	}
	safeIndex := len(withoutMoving)
	if targetIndex != nil {
		safeIndex = *targetIndex
		if safeIndex < 0 {
			safeIndex = 0
		}
		if safeIndex > len(withoutMoving) {
			safeIndex = len(withoutMoving)
		}
	}
	out := make([]int64, 0, len(withoutMoving)+1)
	out = append(out, withoutMoving[:safeIndex]...)
	out = append(out, movingNodeID)
	out = append(out, withoutMoving[safeIndex:]...)
	return out
}

func setToSortedSlice(set map[int64]struct{}) []int64 {
	out := make([]int64, 0, len(set))
	for id := range set {
		out = append(out, id)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func nodesToMaps(nodes []*treeNodeResponse) []map[string]any {
	out := make([]map[string]any, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, n.toMap())
	}
	return out
}

func pageNumOr(v *int64, def int64) int64 {
	if v == nil {
		return def
	}
	return *v
}

func nullableIDString(id *int64) any {
	if id == nil {
		return nil
	}
	return strconv.FormatInt(*id, 10)
}

func ptrString(s string) *string { return &s }
