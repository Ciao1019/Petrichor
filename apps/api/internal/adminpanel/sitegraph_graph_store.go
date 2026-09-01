package adminpanel

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

func LoadStoredDraft(ctx context.Context, userID int64, includeArchived bool) (Draft, error) {
	liveStatuses := []string{"DRAFT", "PUBLISHED"}
	if includeArchived {
		liveStatuses = []string{"DRAFT", "PUBLISHED", "ARCHIVED"}
	}

	nodes := []*nodeRecord{}
	nodeRows, err := db.Pool().Query(ctx,
		`SELECT `+nodeColumns+` FROM petrichor_site_graph_node
		 WHERE user_id = $1 AND status = ANY($2)`, userID, liveStatuses)
	if err != nil {
		return Draft{}, err
	}
	for nodeRows.Next() {
		n, serr := scanNodeRow(nodeRows)
		if serr != nil {
			nodeRows.Close()
			return Draft{}, serr
		}
		nodes = append(nodes, n)
	}
	nodeRows.Close()
	if err := nodeRows.Err(); err != nil {
		return Draft{}, err
	}

	edges := []*edgeRecord{}
	edgeRows, err := db.Pool().Query(ctx,
		`SELECT `+edgeColumns+` FROM petrichor_site_graph_edge WHERE user_id = $1`, userID)
	if err != nil {
		return Draft{}, err
	}
	for edgeRows.Next() {
		e, serr := scanEdgeRow(edgeRows)
		if serr != nil {
			edgeRows.Close()
			return Draft{}, serr
		}
		edges = append(edges, e)
	}
	edgeRows.Close()
	if err := edgeRows.Err(); err != nil {
		return Draft{}, err
	}

	keyByID := make(map[int64]string, len(nodes))
	for _, n := range nodes {
		keyByID[n.ID] = n.NodeKey
	}

	draftNodes := make([]DraftNode, 0, len(nodes))
	for _, n := range nodes {
		var parentKey *string
		if n.ParentID != nil {
			if key, ok := keyByID[*n.ParentID]; ok {
				parentKey = &key
			}
		}
		var articleID *string
		if n.ArticleID != nil {
			s := strconv.FormatInt(*n.ArticleID, 10)
			articleID = &s
		}
		summary := ""
		if n.Summary != nil {
			summary = *n.Summary
		}
		draftNodes = append(draftNodes, DraftNode{
			NodeKey:    n.NodeKey,
			ParentKey:  parentKey,
			Kind:       n.Kind,
			Name:       n.Name,
			Summary:    summary,
			Route:      n.Route,
			ArticleID:  articleID,
			Attributes: parseAttributesFromJSON(n.AttributesJSON),
			Aliases:    parseAliasesFromJSON(n.AliasesJSON),
			Weight:     int(n.Weight),
			Confidence: int(n.Confidence),
			Source:     n.Source,
		})
	}

	draftEdges := make([]DraftEdge, 0, len(edges))
	for _, e := range edges {
		fromKey, fromOK := keyByID[e.FromNodeID]
		toKey, toOK := keyByID[e.ToNodeID]
		if !fromOK || !toOK {
			continue
		}
		draftEdges = append(draftEdges, DraftEdge{
			FromKey:    fromKey,
			ToKey:      toKey,
			Relation:   e.Relation,
			Kind:       e.Kind,
			Attributes: parseAttributesFromJSON(e.AttributesJSON),
			Weight:     int(e.Weight),
			Directed:   e.Directed,
			Confidence: int(e.Confidence),
			Source:     e.Source,
		})
	}

	return Draft{Nodes: draftNodes, Edges: draftEdges}, nil
}

// ===== 后台图视图 =====

// computeDepths 按邻接表逐层计算深度，避免依赖数据库方言。
func computeDepths(nodes []*nodeRecord) map[int64]int {
	byID := make(map[int64]*nodeRecord, len(nodes))
	for _, n := range nodes {
		byID[n.ID] = n
	}
	depthByID := make(map[int64]int, len(nodes))

	for _, start := range nodes {
		if _, done := depthByID[start.ID]; done {
			continue
		}
		var chain []int64
		visiting := map[int64]struct{}{}
		current := start
		baseDepth := -1

		for current != nil {
			if cached, ok := depthByID[current.ID]; ok {
				baseDepth = cached
				break
			}
			if _, looped := visiting[current.ID]; looped {
				baseDepth = -1
				break
			}
			visiting[current.ID] = struct{}{}
			chain = append(chain, current.ID)
			if current.ParentID == nil {
				current = nil
				continue
			}
			current = byID[*current.ParentID]
		}

		depth := baseDepth + 1
		for j := len(chain) - 1; j >= 0; j-- {
			depthByID[chain[j]] = depth
			depth++
		}
	}
	return depthByID
}

func toAdminNode(n *nodeRecord, keyByID map[int64]string, depthByID map[int64]int,
	childCountByID map[int64]int, degreeByID map[int64]int) AdminNode {
	var parentKey *string
	if n.ParentID != nil {
		if key, ok := keyByID[*n.ParentID]; ok {
			parentKey = &key
		}
	}
	var articleID *string
	if n.ArticleID != nil {
		s := strconv.FormatInt(*n.ArticleID, 10)
		articleID = &s
	}
	summary := ""
	if n.Summary != nil {
		summary = *n.Summary
	}
	return AdminNode{
		ID:         strconv.FormatInt(n.ID, 10),
		NodeKey:    n.NodeKey,
		ParentID:   int64PtrToString(n.ParentID),
		ParentKey:  parentKey,
		Kind:       n.Kind,
		Name:       n.Name,
		Summary:    summary,
		Route:      n.Route,
		ArticleID:  articleID,
		Attributes: parseAttributesFromJSON(n.AttributesJSON),
		Aliases:    parseAliasesFromJSON(n.AliasesJSON),
		Weight:     n.Weight,
		SortOrder:  n.SortOrder,
		Status:     n.Status,
		Source:     n.Source,
		Confidence: n.Confidence,
		Locked:     n.Locked,
		Depth:      depthByID[n.ID],
		ChildCount: childCountByID[n.ID],
		Degree:     degreeByID[n.ID],
		UpdatedAt:  httpx.FormatISO(n.UpdatedAt),
	}
}

func toAdminEdge(e *edgeRecord, nodeByID map[int64]*nodeRecord) AdminEdge {
	from := nodeByID[e.FromNodeID]
	to := nodeByID[e.ToNodeID]
	fromKey, fromName := "", "（已删除）"
	toKey, toName := "", "（已删除）"
	if from != nil {
		fromKey = from.NodeKey
		fromName = from.Name
	}
	if to != nil {
		toKey = to.NodeKey
		toName = to.Name
	}
	return AdminEdge{
		ID:           strconv.FormatInt(e.ID, 10),
		FromNodeID:   strconv.FormatInt(e.FromNodeID, 10),
		FromNodeKey:  fromKey,
		FromNodeName: fromName,
		ToNodeID:     strconv.FormatInt(e.ToNodeID, 10),
		ToNodeKey:    toKey,
		ToNodeName:   toName,
		Relation:     e.Relation,
		Kind:         e.Kind,
		Attributes:   parseAttributesFromJSON(e.AttributesJSON),
		Weight:       e.Weight,
		Directed:     e.Directed,
		Status:       e.Status,
		Source:       e.Source,
		Confidence:   e.Confidence,
		Locked:       e.Locked,
		UpdatedAt:    httpx.FormatISO(e.UpdatedAt),
	}
}

type adminGraph struct {
	Nodes []AdminNode
	Edges []AdminEdge
}

// LoadAdminGraph 全量后台视图：含深度/子节点数/度数等派生字段。
func LoadAdminGraph(ctx context.Context, userID int64) (*adminGraph, error) {
	pool := db.Pool()
	nodes := []*nodeRecord{}
	nodeRows, err := pool.Query(ctx,
		`SELECT `+nodeColumns+` FROM petrichor_site_graph_node WHERE user_id = $1
		 ORDER BY sort_order ASC, id ASC`, userID)
	if err != nil {
		return nil, err
	}
	for nodeRows.Next() {
		n, serr := scanNodeRow(nodeRows)
		if serr != nil {
			nodeRows.Close()
			return nil, serr
		}
		nodes = append(nodes, n)
	}
	nodeRows.Close()
	if err := nodeRows.Err(); err != nil {
		return nil, err
	}

	edges := []*edgeRecord{}
	edgeRows, err := pool.Query(ctx,
		`SELECT `+edgeColumns+` FROM petrichor_site_graph_edge WHERE user_id = $1
		 ORDER BY updated_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	for edgeRows.Next() {
		e, serr := scanEdgeRow(edgeRows)
		if serr != nil {
			edgeRows.Close()
			return nil, serr
		}
		edges = append(edges, e)
	}
	edgeRows.Close()
	if err := edgeRows.Err(); err != nil {
		return nil, err
	}

	keyByID := make(map[int64]string, len(nodes))
	nodeByID := make(map[int64]*nodeRecord, len(nodes))
	for _, n := range nodes {
		keyByID[n.ID] = n.NodeKey
		nodeByID[n.ID] = n
	}
	depthByID := computeDepths(nodes)

	childCountByID := map[int64]int{}
	for _, n := range nodes {
		if n.ParentID == nil {
			continue
		}
		childCountByID[*n.ParentID]++
	}
	degreeByID := map[int64]int{}
	for _, e := range edges {
		degreeByID[e.FromNodeID]++
		degreeByID[e.ToNodeID]++
	}

	graph := &adminGraph{
		Nodes: make([]AdminNode, 0, len(nodes)),
		Edges: make([]AdminEdge, 0, len(edges)),
	}
	for _, n := range nodes {
		graph.Nodes = append(graph.Nodes, toAdminNode(n, keyByID, depthByID, childCountByID, degreeByID))
	}
	for _, e := range edges {
		graph.Edges = append(graph.Edges, toAdminEdge(e, nodeByID))
	}
	return graph, nil
}

// ===== 发布流转 =====

// ArchiveStaleArticleNodes 归档「文章已不再公开」的文章节点。
func ArchiveStaleArticleNodes(ctx context.Context, userID int64) (int, error) {
	publicArticleIds, err := LoadPublicArticleIDSet(ctx)
	if err != nil {
		return 0, err
	}
	rows, err := db.Pool().Query(ctx,
		`SELECT id, article_id, status FROM petrichor_site_graph_node
		 WHERE user_id = $1 AND kind = $2`, userID, NodeKindArticle)
	if err != nil {
		return 0, err
	}
	type articleNode struct {
		id        int64
		articleID *int64
		status    string
	}
	articleNodes := []articleNode{}
	for rows.Next() {
		var an articleNode
		if serr := rows.Scan(&an.id, &an.articleID, &an.status); serr != nil {
			rows.Close()
			return 0, serr
		}
		articleNodes = append(articleNodes, an)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	staleIDs := []int64{}
	for _, an := range articleNodes {
		if an.status == "ARCHIVED" {
			continue
		}
		if an.articleID != nil {
			if _, public := publicArticleIds[strconv.FormatInt(*an.articleID, 10)]; public {
				continue
			}
		}
		staleIDs = append(staleIDs, an.id)
	}
	if len(staleIDs) == 0 {
		return 0, nil
	}
	if _, uerr := db.Pool().Exec(ctx,
		`UPDATE petrichor_site_graph_node SET status='ARCHIVED', updated_at=$1
		 WHERE user_id=$2 AND id = ANY($3)`, time.Now(), userID, staleIDs); uerr != nil {
		return 0, uerr
	}
	return len(staleIDs), nil
}

// PublishGraph 发布：全部草稿置为 PUBLISHED。
func PublishGraph(ctx context.Context, userID int64) (map[string]any, error) {
	now := time.Now()
	var publishedNodes, publishedEdges int32
	if err := db.Pool().QueryRow(ctx,
		`WITH moved AS (
			UPDATE petrichor_site_graph_node SET status='PUBLISHED', updated_at=$1
			WHERE user_id=$2 AND status='DRAFT' RETURNING id
		) SELECT count(*) FROM moved`, now, userID).Scan(&publishedNodes); err != nil {
		return nil, err
	}
	if err := db.Pool().QueryRow(ctx,
		`WITH moved AS (
			UPDATE petrichor_site_graph_edge SET status='PUBLISHED', updated_at=$1
			WHERE user_id=$2 AND status='DRAFT' RETURNING id
		) SELECT count(*) FROM moved`, now, userID).Scan(&publishedEdges); err != nil {
		return nil, err
	}
	return map[string]any{"publishedNodes": publishedNodes, "publishedEdges": publishedEdges}, nil
}

// UnpublishGraph 下线：已发布内容退回草稿。
func UnpublishGraph(ctx context.Context, userID int64) (map[string]any, error) {
	now := time.Now()
	var unpublishedNodes, unpublishedEdges int32
	if err := db.Pool().QueryRow(ctx,
		`WITH moved AS (
			UPDATE petrichor_site_graph_node SET status='DRAFT', updated_at=$1
			WHERE user_id=$2 AND status='PUBLISHED' RETURNING id
		) SELECT count(*) FROM moved`, now, userID).Scan(&unpublishedNodes); err != nil {
		return nil, err
	}
	if err := db.Pool().QueryRow(ctx,
		`WITH moved AS (
			UPDATE petrichor_site_graph_edge SET status='DRAFT', updated_at=$1
			WHERE user_id=$2 AND status='PUBLISHED' RETURNING id
		) SELECT count(*) FROM moved`, now, userID).Scan(&unpublishedEdges); err != nil {
		return nil, err
	}
	return map[string]any{"unpublishedNodes": unpublishedNodes, "unpublishedEdges": unpublishedEdges}, nil
}

// ClearGraph 清空整个图谱（保留运行历史）。
func ClearGraph(ctx context.Context, userID int64) (map[string]any, error) {
	pool := db.Pool()
	if _, err := pool.Exec(ctx, `DELETE FROM petrichor_site_graph_edge WHERE user_id=$1`, userID); err != nil {
		return nil, err
	}
	if _, err := pool.Exec(ctx, `DELETE FROM petrichor_site_graph_node WHERE user_id=$1`, userID); err != nil {
		return nil, err
	}
	if _, err := pool.Exec(ctx, `DELETE FROM petrichor_site_graph_merge_candidate WHERE user_id=$1`, userID); err != nil {
		return nil, err
	}
	return map[string]any{"cleared": true}, nil
}

// ===== 节点/关系维护 =====

func assertNodeOwned(ctx context.Context, userID, id int64) (*nodeRecord, error) {
	n, err := scanNodeRow(db.Pool().QueryRow(ctx,
		`SELECT `+nodeColumns+` FROM petrichor_site_graph_node WHERE id=$1 AND user_id=$2 LIMIT 1`,
		id, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound("图谱节点不存在")
	}
	return n, err
}

func assertEdgeOwned(ctx context.Context, userID, id int64) (*edgeRecord, error) {
	e, err := scanEdgeRow(db.Pool().QueryRow(ctx,
		`SELECT `+edgeColumns+` FROM petrichor_site_graph_edge WHERE id=$1 AND user_id=$2 LIMIT 1`,
		id, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound("图谱关系不存在")
	}
	return e, err
}

// isDescendantOf 判断 candidateId 是否是 nodeId 自身或其子孙（用于阻止成环）。
func isDescendantOf(ctx context.Context, userID, candidateID, nodeID int64) (bool, error) {
	if candidateID == nodeID {
		return true, nil
	}
	rows, err := db.Pool().Query(ctx,
		`SELECT id, parent_id FROM petrichor_site_graph_node WHERE user_id = $1`, userID)
	if err != nil {
		return false, err
	}
	type idParent struct {
		id       int64
		parentID *int64
	}
	byID := map[int64]*idParent{}
	for rows.Next() {
		item := &idParent{}
		if serr := rows.Scan(&item.id, &item.parentID); serr != nil {
			rows.Close()
			return false, serr
		}
		byID[item.id] = item
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return false, err
	}

	current := byID[candidateID]
	visited := map[int64]struct{}{}
	for current != nil {
		if _, looped := visited[current.id]; looped {
			return false, nil
		}
		visited[current.id] = struct{}{}
		if current.parentID != nil && *current.parentID == nodeID {
			return true, nil
		}
		if current.parentID == nil {
			current = nil
			continue
		}
		current = byID[*current.parentID]
	}
	return false, nil
}

// SaveNodeInput 后台保存节点入参（已校验归一化）。
type SaveNodeInput struct {
	ID         *int64
	NodeKey    string
	ParentID   *int64
	Kind       string
	Name       string
	Summary    *string
	Route      *string
	Attributes []Attribute
	Aliases    []string
	Weight     int
	Status     string
	Confidence int
	Locked     bool
}

// SaveNode 新建或更新节点；AGENT 来源被人工编辑后转为 MANUAL。
func SaveNode(ctx context.Context, userID int64, input SaveNodeInput) (*nodeRecord, error) {
	pool := db.Pool()
	now := time.Now()

	if input.ParentID != nil {
		if _, err := assertNodeOwned(ctx, userID, *input.ParentID); err != nil {
			return nil, err
		}
		if input.ID != nil {
			looped, err := isDescendantOf(ctx, userID, *input.ParentID, *input.ID)
			if err != nil {
				return nil, err
			}
			if looped {
				return nil, httpx.BadRequest("父节点不能是自己或自己的子孙节点")
			}
		}
	}

	// 节点键有唯一约束，先给出可读错误而不是让数据库抛 23505
	var conflictID int64
	err := pool.QueryRow(ctx,
		`SELECT id FROM petrichor_site_graph_node WHERE user_id=$1 AND node_key=$2 LIMIT 1`,
		userID, input.NodeKey).Scan(&conflictID)
	notFound := errors.Is(err, pgx.ErrNoRows)
	if err != nil && !notFound {
		return nil, err
	}
	if !notFound && (input.ID == nil || conflictID != *input.ID) {
		return nil, httpx.BadRequest(fmt.Sprintf("节点键「%s」已被占用，请改用其他节点键", input.NodeKey))
	}

	var summaryArg, routeArg any
	if input.Summary != nil && strings.TrimSpace(*input.Summary) != "" {
		summaryArg = strings.TrimSpace(*input.Summary)
	}
	if input.Route != nil && strings.TrimSpace(*input.Route) != "" {
		routeArg = strings.TrimSpace(*input.Route)
	}

	if input.ID != nil {
		current, err := assertNodeOwned(ctx, userID, *input.ID)
		if err != nil {
			return nil, err
		}
		source := current.Source
		if source == "AGENT" {
			source = "MANUAL"
		}
		updated, err := scanNodeRow(pool.QueryRow(ctx,
			`UPDATE petrichor_site_graph_node SET node_key=$1, parent_id=$2, kind=$3, name=$4, summary=$5,
			 route=$6, attributes_json=$7, aliases_json=$8, weight=$9, status=$10, confidence=$11,
			 locked=$12, source=$13, updated_at=$14 WHERE id=$15 RETURNING `+nodeColumns,
			input.NodeKey, input.ParentID, input.Kind, input.Name, summaryArg, routeArg,
			marshalAttributes(input.Attributes), marshalStrings(input.Aliases), int32(input.Weight),
			input.Status, int32(input.Confidence), input.Locked, source, now, *input.ID))
		return updated, err
	}

	created, err := scanNodeRow(pool.QueryRow(ctx,
		`INSERT INTO petrichor_site_graph_node
		 (user_id, node_key, parent_id, kind, name, summary, route, attributes_json, aliases_json,
		  weight, sort_order, status, source, confidence, locked, created_at, updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,'MANUAL',$12,$13,$14,$14) RETURNING `+nodeColumns,
		userID, input.NodeKey, input.ParentID, input.Kind, input.Name, summaryArg, routeArg,
		marshalAttributes(input.Attributes), marshalStrings(input.Aliases), int32(input.Weight),
		input.Status, int32(input.Confidence), input.Locked, now))
	return created, err
}

// DeleteNode 删除节点。关系由外键级联删除；子节点的 parent_id 由外键置空。
func DeleteNode(ctx context.Context, userID, id int64) (map[string]any, error) {
	if _, err := assertNodeOwned(ctx, userID, id); err != nil {
		return nil, err
	}
	if _, err := db.Pool().Exec(ctx,
		`DELETE FROM petrichor_site_graph_node WHERE id=$1 AND user_id=$2`, id, userID); err != nil {
		return nil, err
	}
	return map[string]any{"id": strconv.FormatInt(id, 10)}, nil
}

// SaveEdgeInput 后台保存关系入参（已校验归一化）。
type SaveEdgeInput struct {
	ID         *int64
	FromNodeID int64
	ToNodeID   int64
	Relation   string
	Kind       string
	Attributes []Attribute
	Weight     int
	Directed   bool
	Status     string
	Confidence int
	Locked     bool
}

// SaveEdge 新建或更新关系；(起点, 终点, 关系名) 三元组唯一。
func SaveEdge(ctx context.Context, userID int64, input SaveEdgeInput) (*edgeRecord, error) {
	if input.FromNodeID == input.ToNodeID {
		return nil, httpx.BadRequest("关系的两端不能是同一个节点")
	}
	pool := db.Pool()
	if _, err := assertNodeOwned(ctx, userID, input.FromNodeID); err != nil {
		return nil, err
	}
	if _, err := assertNodeOwned(ctx, userID, input.ToNodeID); err != nil {
		return nil, err
	}

	var conflictID int64
	err := pool.QueryRow(ctx,
		`SELECT id FROM petrichor_site_graph_edge
		 WHERE user_id=$1 AND from_node_id=$2 AND to_node_id=$3 AND relation=$4 LIMIT 1`,
		userID, input.FromNodeID, input.ToNodeID, input.Relation).Scan(&conflictID)
	notFound := errors.Is(err, pgx.ErrNoRows)
	if err != nil && !notFound {
		return nil, err
	}
	if !notFound && (input.ID == nil || conflictID != *input.ID) {
		return nil, httpx.BadRequest("这两个节点之间已存在同名关系")
	}

	now := time.Now()
	if input.ID != nil {
		current, err := assertEdgeOwned(ctx, userID, *input.ID)
		if err != nil {
			return nil, err
		}
		source := current.Source
		if source == "AGENT" {
			source = "MANUAL"
		}
		return scanEdgeRow(pool.QueryRow(ctx,
			`UPDATE petrichor_site_graph_edge SET user_id=$1, from_node_id=$2, to_node_id=$3, relation=$4,
			 kind=$5, attributes_json=$6, weight=$7, directed=$8, status=$9, confidence=$10, locked=$11,
			 source=$12, updated_at=$13 WHERE id=$14 RETURNING `+edgeColumns,
			userID, input.FromNodeID, input.ToNodeID, input.Relation, input.Kind,
			marshalAttributes(input.Attributes), int32(input.Weight), input.Directed, input.Status,
			int32(input.Confidence), input.Locked, source, now, *input.ID))
	}

	return scanEdgeRow(pool.QueryRow(ctx,
		`INSERT INTO petrichor_site_graph_edge
		 (user_id, from_node_id, to_node_id, relation, kind, attributes_json, weight, directed,
		  status, source, confidence, locked, created_at, updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'MANUAL',$10,$11,$12,$12) RETURNING `+edgeColumns,
		userID, input.FromNodeID, input.ToNodeID, input.Relation, input.Kind,
		marshalAttributes(input.Attributes), int32(input.Weight), input.Directed, input.Status,
		int32(input.Confidence), input.Locked, now))
}

// DeleteEdge 删除关系。
func DeleteEdge(ctx context.Context, userID, id int64) (map[string]any, error) {
	if _, err := assertEdgeOwned(ctx, userID, id); err != nil {
		return nil, err
	}
	if _, err := db.Pool().Exec(ctx,
		`DELETE FROM petrichor_site_graph_edge WHERE id=$1 AND user_id=$2`, id, userID); err != nil {
		return nil, err
	}
	return map[string]any{"id": strconv.FormatInt(id, 10)}, nil
}

// ===== 运行记录 =====

// CreateRun 创建一次抽取运行记录。
