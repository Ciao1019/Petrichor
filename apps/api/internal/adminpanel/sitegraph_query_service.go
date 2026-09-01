package adminpanel

import (
	"context"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"petrichor/api/internal/db"
)

// ===== 子树 / 邻域 / 祖先（递归 CTE） =====

type subtreeRow struct {
	id    int64
	depth int32
}

// loadSubtreeNodeIds 子树查询：沿 parent_id 向下展开，深度上界同时是递归终止条件。
func loadSubtreeNodeIds(ctx context.Context, userID, rootNodeID int64, maxDepth int, statuses []string) ([]subtreeRow, error) {
	rows, err := db.Pool().Query(ctx, `
		with recursive subtree as (
			select n.id, n.parent_id, 0 as depth
			from petrichor_site_graph_node n
			where n.id = $1 and n.user_id = $2 and n.status = any($3)
			union all
			select child.id, child.parent_id, parent.depth + 1
			from petrichor_site_graph_node child
			join subtree parent on child.parent_id = parent.id
			where parent.depth < $4 and child.user_id = $2 and child.status = any($3)
		)
		select id, depth from subtree`,
		rootNodeID, userID, statuses, int32(maxDepth))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []subtreeRow{}
	for rows.Next() {
		var r subtreeRow
		if serr := rows.Scan(&r.id, &r.depth); serr != nil {
			return nil, serr
		}
		list = append(list, r)
	}
	return list, rows.Err()
}

// loadNeighborhoodNodeIds N 跳邻域查询：关系表上的无向展开（union 去重）。
func loadNeighborhoodNodeIds(ctx context.Context, userID, startNodeID int64, hops int, statuses []string) ([]int64, error) {
	rows, err := db.Pool().Query(ctx, `
		with recursive hood(node_id, hop) as (
			select $1::bigint, 0
			union
			select case when e.from_node_id = hood.node_id then e.to_node_id else e.from_node_id end,
			       hood.hop + 1
			from hood
			join petrichor_site_graph_edge e
			  on e.from_node_id = hood.node_id or e.to_node_id = hood.node_id
			where hood.hop < $2 and e.user_id = $3 and e.status = any($4)
		)
		select distinct node_id from hood`,
		startNodeID, int32(hops), userID, statuses)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if serr := rows.Scan(&id); serr != nil {
			return nil, serr
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

type ancestorRow struct {
	id      int64
	nodeKey string
	name    string
}

// loadAncestorPath 祖先链：从节点沿 parent_id 一路向上。
func loadAncestorPath(ctx context.Context, userID, nodeID int64) ([]ancestorRow, error) {
	rows, err := db.Pool().Query(ctx, `
		with recursive ancestors as (
			select n.id, n.parent_id, n.node_key, n.name, 0 as up
			from petrichor_site_graph_node n
			where n.id = $1 and n.user_id = $2
			union all
			select parent.id, parent.parent_id, parent.node_key, parent.name, child.up + 1
			from petrichor_site_graph_node parent
			join ancestors child on child.parent_id = parent.id
			where child.up < $3 and parent.user_id = $2
		)
		select id, node_key, name from ancestors order by up desc`,
		nodeID, userID, int32(LimitMaxDepth))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	path := []ancestorRow{}
	for rows.Next() {
		var a ancestorRow
		if serr := rows.Scan(&a.id, &a.nodeKey, &a.name); serr != nil {
			return nil, serr
		}
		path = append(path, a)
	}
	return path, rows.Err()
}

// LoadSiteGraphSubtree 子树查询结果附带祖先面包屑。
func LoadSiteGraphSubtree(ctx context.Context, userID, nodeID int64, depth *int) (map[string]any, error) {
	maxDepth := LimitMaxDepth
	if depth != nil {
		maxDepth = *depth
		if maxDepth < 0 {
			maxDepth = 0
		}
		if maxDepth > LimitMaxDepth {
			maxDepth = LimitMaxDepth
		}
	}

	subtreeRows, err := loadSubtreeNodeIds(ctx, userID, nodeID, maxDepth, []string{"DRAFT", "PUBLISHED"})
	if err != nil {
		return nil, err
	}
	ancestors, err := loadAncestorPath(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	graph, err := LoadAdminGraph(ctx, userID)
	if err != nil {
		return nil, err
	}

	depthByID := make(map[string]int, len(subtreeRows))
	for _, row := range subtreeRows {
		depthByID[strconv.FormatInt(row.id, 10)] = int(row.depth)
	}
	subtreeNodes := []SubtreeNode{}
	for _, node := range graph.Nodes {
		d, ok := depthByID[node.ID]
		if !ok {
			continue
		}
		subtreeNodes = append(subtreeNodes, SubtreeNode{AdminNode: node, SubtreeDepth: d})
	}
	sort.SliceStable(subtreeNodes, func(i, j int) bool {
		if subtreeNodes[i].SubtreeDepth != subtreeNodes[j].SubtreeDepth {
			return subtreeNodes[i].SubtreeDepth < subtreeNodes[j].SubtreeDepth
		}
		return subtreeNodes[i].SortOrder < subtreeNodes[j].SortOrder
	})

	nodeIDSet := map[string]struct{}{}
	for _, node := range subtreeNodes {
		nodeIDSet[node.ID] = struct{}{}
	}
	edges := []AdminEdge{}
	for _, edge := range graph.Edges {
		_, fromOK := nodeIDSet[edge.FromNodeID]
		_, toOK := nodeIDSet[edge.ToNodeID]
		if fromOK || toOK {
			edges = append(edges, edge)
		}
	}

	ancestorList := make([]map[string]any, 0, len(ancestors))
	for _, item := range ancestors {
		ancestorList = append(ancestorList, map[string]any{
			"id":      strconv.FormatInt(item.id, 10),
			"nodeKey": item.nodeKey,
			"name":    item.name,
		})
	}

	return map[string]any{"ancestors": ancestorList, "nodes": subtreeNodes, "edges": edges}, nil
}

// LoadSiteGraphNeighborhood N 跳邻域视图。
func LoadSiteGraphNeighborhood(ctx context.Context, userID, nodeID int64, hops *int) (map[string]any, error) {
	hopCount := 1
	if hops != nil {
		hopCount = *hops
		if hopCount < 1 {
			hopCount = 1
		}
		if hopCount > 3 {
			hopCount = 3
		}
	}

	ids, err := loadNeighborhoodNodeIds(ctx, userID, nodeID, hopCount, []string{"DRAFT", "PUBLISHED"})
	if err != nil {
		return nil, err
	}
	graph, err := LoadAdminGraph(ctx, userID)
	if err != nil {
		return nil, err
	}

	idSet := map[string]struct{}{}
	for _, id := range ids {
		idSet[strconv.FormatInt(id, 10)] = struct{}{}
	}
	nodes := []AdminNode{}
	for _, node := range graph.Nodes {
		if _, ok := idSet[node.ID]; ok {
			nodes = append(nodes, node)
		}
	}
	edges := []AdminEdge{}
	for _, edge := range graph.Edges {
		_, fromOK := idSet[edge.FromNodeID]
		_, toOK := idSet[edge.ToNodeID]
		if fromOK && toOK {
			edges = append(edges, edge)
		}
	}
	return map[string]any{"nodes": nodes, "edges": edges}, nil
}

// urlQueryEscape 复刻 encodeURIComponent。
func urlQueryEscape(v string) string {
	return strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(
		strings.ReplaceAll(url.QueryEscape(v), "+", "%20"), "%21", "!"), "%28", "("), "%29", ")")
}
