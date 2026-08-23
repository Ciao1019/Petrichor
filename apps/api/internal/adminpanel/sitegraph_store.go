// sitegraph_store.go 移植 src/server/site-graph/store.ts 与 graph-query.ts：
// 邻接表 + 关系表的落库、发布流转、运行记录与递归 CTE 图查询。
package adminpanel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

type nodeRecord struct {
	ID             int64
	UserID         int64
	NodeKey        string
	ParentID       *int64
	Kind           string
	Name           string
	Summary        *string
	Route          *string
	ArticleID      *int64
	AttributesJSON *string
	AliasesJSON    *string
	Weight         int32
	SortOrder      int32
	Status         string
	Source         string
	Confidence     int32
	Locked         bool
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

const nodeColumns = `id, user_id, node_key, parent_id, kind, name, summary, route, article_id,
	attributes_json, aliases_json, weight, sort_order, status, source, confidence, locked,
	created_at, updated_at`

func scanNodeRow(scanner interface{ Scan(dest ...any) error }) (*nodeRecord, error) {
	var n nodeRecord
	err := scanner.Scan(&n.ID, &n.UserID, &n.NodeKey, &n.ParentID, &n.Kind, &n.Name, &n.Summary,
		&n.Route, &n.ArticleID, &n.AttributesJSON, &n.AliasesJSON, &n.Weight, &n.SortOrder,
		&n.Status, &n.Source, &n.Confidence, &n.Locked, &n.CreatedAt, &n.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &n, nil
}

type edgeRecord struct {
	ID             int64
	UserID         int64
	FromNodeID     int64
	ToNodeID       int64
	Relation       string
	Kind           string
	AttributesJSON *string
	Weight         int32
	Directed       bool
	Status         string
	Source         string
	Confidence     int32
	Locked         bool
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

const edgeColumns = `id, user_id, from_node_id, to_node_id, relation, kind, attributes_json,
	weight, directed, status, source, confidence, locked, created_at, updated_at`

func scanEdgeRow(scanner interface{ Scan(dest ...any) error }) (*edgeRecord, error) {
	var e edgeRecord
	err := scanner.Scan(&e.ID, &e.UserID, &e.FromNodeID, &e.ToNodeID, &e.Relation, &e.Kind,
		&e.AttributesJSON, &e.Weight, &e.Directed, &e.Status, &e.Source, &e.Confidence,
		&e.Locked, &e.CreatedAt, &e.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &e, nil
}

func parseAttributesFromJSON(raw *string) []Attribute {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return []Attribute{}
	}
	var parsed any
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return []Attribute{}
	}
	return normalizeAttributes(parsed)
}

func parseAliasesFromJSON(raw *string) []string {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return []string{}
	}
	var parsed any
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return []string{}
	}
	return normalizeAliases(parsed)
}

func marshalAttributes(items []Attribute) string {
	raw, err := json.Marshal(items)
	if err != nil {
		return "[]"
	}
	return string(raw)
}

func marshalStrings(items []string) string {
	raw, err := json.Marshal(items)
	if err != nil {
		return "[]"
	}
	return string(raw)
}

func int64PtrToString(v *int64) *string {
	if v == nil {
		return nil
	}
	s := strconv.FormatInt(*v, 10)
	return &s
}

// ===== 公开文章输入 =====

type publicArticleRow struct {
	articleID   int64
	title       string
	excerpt     string
	internalURL *string
	shareCode   string
	updatedAt   time.Time
}

// loadPublicSiteArticles 复刻 loadPublicSiteArticles 的可见性判定：
// 启用且未撤销、未过期、无密码、有 shareCode 的分享才允许进图谱。
func loadPublicSiteArticles(ctx context.Context) ([]publicArticleRow, error) {
	rows, err := db.Pool().Query(ctx,
		`SELECT s.article_id, a.title, COALESCE(a.public_excerpt, ''), COALESCE(a.ai_summary, ''),
		        s.internal_url, s.share_code, a.updated_at
		 FROM petrichor_kb_article_share s
		 JOIN petrichor_kb_article a ON a.id = s.article_id
		 WHERE s.enabled = true AND s.revoked_at IS NULL
		   AND (s.expires_at IS NULL OR s.expires_at > now())
		   AND COALESCE(TRIM(s.password_hash), '') = ''
		   AND COALESCE(TRIM(s.share_code), '') <> ''
		 ORDER BY CASE WHEN s.pin_order IS NULL THEN 1 ELSE 0 END, s.pin_order DESC NULLS LAST,
		          a.updated_at DESC, s.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []publicArticleRow{}
	for rows.Next() {
		var r publicArticleRow
		var aiSummary string
		if serr := rows.Scan(&r.articleID, &r.title, &r.excerpt, &aiSummary, &r.internalURL,
			&r.shareCode, &r.updatedAt); serr != nil {
			return nil, serr
		}
		r.excerpt = strings.TrimSpace(r.excerpt)
		if summary := strings.TrimSpace(aiSummary); summary != "" {
			r.excerpt = truncateRunes(summary, 120)
		}
		if r.excerpt == "" {
			r.excerpt = "暂无摘要"
		}
		list = append(list, r)
	}
	return list, rows.Err()
}

func truncateRunes(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	cut := strings.TrimRight(string(runes[:max]), " \t\n\r")
	return cut + "..."
}

func isInternalSitePath(value string) bool {
	trimmed := strings.TrimSpace(value)
	if !strings.HasPrefix(trimmed, "/") || strings.HasPrefix(trimmed, "//") || len(trimmed) < 2 {
		return false
	}
	for _, ch := range trimmed {
		if ch == ' ' || ch == '\t' {
			return false
		}
	}
	return true
}

// LoadPublicArticleInputs 抽取 Agent 的输入源。
func LoadPublicArticleInputs(ctx context.Context) ([]ArticleInput, error) {
	publicArticles, err := loadPublicSiteArticles(ctx)
	if err != nil {
		return nil, err
	}
	if len(publicArticles) == 0 {
		return []ArticleInput{}, nil
	}

	ids := make([]int64, 0, len(publicArticles))
	seen := map[int64]struct{}{}
	for _, article := range publicArticles {
		if article.articleID <= 0 {
			continue
		}
		if _, dup := seen[article.articleID]; dup {
			continue
		}
		seen[article.articleID] = struct{}{}
		ids = append(ids, article.articleID)
	}
	if len(ids) == 0 {
		return []ArticleInput{}, nil
	}

	detailRows, err := db.Pool().Query(ctx,
		`SELECT a.id, a.content_md, kb.name
		 FROM petrichor_kb_article a
		 JOIN petrichor_kb_knowledge_base kb ON kb.id = a.knowledge_base_id
		 WHERE a.id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	type articleDetail struct {
		contentMd string
		kbName    string
	}
	detailByID := map[int64]*articleDetail{}
	for detailRows.Next() {
		var id int64
		var d articleDetail
		if serr := detailRows.Scan(&id, &d.contentMd, &d.kbName); serr != nil {
			detailRows.Close()
			return nil, serr
		}
		detailByID[id] = &d
	}
	detailRows.Close()
	if err := detailRows.Err(); err != nil {
		return nil, err
	}

	tagsByArticle, err := loadTagsByArticleIDs(ctx, ids)
	if err != nil {
		return nil, err
	}

	inputs := make([]ArticleInput, 0, len(publicArticles))
	for _, article := range publicArticles {
		detail := detailByID[article.articleID]
		if detail == nil {
			continue
		}
		route := "/p/" + article.shareCode
		if article.internalURL != nil && isInternalSitePath(*article.internalURL) {
			route = *article.internalURL
		}
		inputs = append(inputs, ArticleInput{
			ArticleID:         strconv.FormatInt(article.articleID, 10),
			Title:             article.title,
			Route:             route,
			Excerpt:           article.excerpt,
			Tags:              tagsByArticle[article.articleID],
			ContentMd:         detail.contentMd,
			UpdatedAt:         httpx.FormatISO(article.updatedAt),
			KnowledgeBaseName: detail.kbName,
		})
	}
	return inputs, nil
}

// LoadPublicArticleIDSet 当前公开文章 ID 集合，供校验器拦截私有文章。
func LoadPublicArticleIDSet(ctx context.Context) (map[string]struct{}, error) {
	articles, err := loadPublicSiteArticles(ctx)
	if err != nil {
		return nil, err
	}
	set := make(map[string]struct{}, len(articles))
	for _, article := range articles {
		set[strconv.FormatInt(article.articleID, 10)] = struct{}{}
	}
	return set, nil
}

func loadTagsByArticleIDs(ctx context.Context, ids []int64) (map[int64][]string, error) {
	result := map[int64][]string{}
	if len(ids) == 0 {
		return result, nil
	}
	rows, err := db.Pool().Query(ctx,
		`SELECT article_id, tag FROM petrichor_kb_article_tag
		 WHERE article_id = ANY($1) ORDER BY tag ASC`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var tag string
		if serr := rows.Scan(&id, &tag); serr != nil {
			return nil, serr
		}
		result[id] = append(result[id], tag)
	}
	return result, rows.Err()
}

// ===== 草稿落库 =====

type persistDraftResult struct {
	nodeCount     int
	edgeCount     int
	lockedSkipped int
	prunedNodes   int
	prunedEdges   int
}

// PersistDraft 把草稿写入邻接表与关系表：
// locked 数据不被覆盖；已存在节点保留原状态；新节点一律 DRAFT；
// 本次草稿未覆盖的非人工 Agent 数据会被清理。
func PersistDraft(ctx context.Context, userID int64, draft Draft) (persistDraftResult, error) {
	pool := db.Pool()
	now := time.Now()

	existingNodes := []*nodeRecord{}
	nodeRows, err := pool.Query(ctx,
		`SELECT `+nodeColumns+` FROM petrichor_site_graph_node WHERE user_id = $1`, userID)
	if err != nil {
		return persistDraftResult{}, err
	}
	for nodeRows.Next() {
		n, serr := scanNodeRow(nodeRows)
		if serr != nil {
			nodeRows.Close()
			return persistDraftResult{}, serr
		}
		existingNodes = append(existingNodes, n)
	}
	nodeRows.Close()
	if err := nodeRows.Err(); err != nil {
		return persistDraftResult{}, err
	}

	existingByKey := make(map[string]*nodeRecord, len(existingNodes))
	for _, n := range existingNodes {
		existingByKey[n.NodeKey] = n
	}

	result := persistDraftResult{lockedSkipped: 0}
	idByKey := make(map[string]int64, len(draft.Nodes))

	// 第一轮：写入节点本身，parent 先留空
	for index := range draft.Nodes {
		node := draft.Nodes[index]
		existing := existingByKey[node.NodeKey]
		if existing != nil && existing.Locked {
			result.lockedSkipped++
			idByKey[node.NodeKey] = existing.ID
			continue
		}

		status := "DRAFT"
		if existing != nil && existing.Status != "ARCHIVED" {
			// 曾因文章下架被归档的节点要放回草稿，否则永远发布不出去
			status = existing.Status
		}
		var articleID any
		if node.ArticleID != nil {
			if id, perr := strconv.ParseInt(*node.ArticleID, 10, 64); perr == nil {
				articleID = id
			}
		}
		var summaryArg any
		if node.Summary != "" {
			summaryArg = node.Summary
		}

		if existing != nil {
			_, uerr := pool.Exec(ctx,
				`UPDATE petrichor_site_graph_node SET node_key=$1, kind=$2, name=$3, summary=$4, route=$5,
				 article_id=$6, attributes_json=$7, aliases_json=$8, weight=$9, sort_order=$10,
				 source=$11, confidence=$12, status=$13, updated_at=$14 WHERE id=$15`,
				node.NodeKey, node.Kind, node.Name, summaryArg, node.Route, articleID,
				marshalAttributes(node.Attributes), marshalStrings(node.Aliases),
				int32(node.Weight), int32(index), node.Source, int32(node.Confidence),
				status, now, existing.ID)
			if uerr != nil {
				return persistDraftResult{}, uerr
			}
			idByKey[node.NodeKey] = existing.ID
			continue
		}

		var createdID int64
		err := pool.QueryRow(ctx,
			`INSERT INTO petrichor_site_graph_node
			 (user_id, node_key, kind, name, summary, route, article_id, attributes_json, aliases_json,
			  weight, sort_order, status, source, confidence, locked, created_at, updated_at)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'DRAFT',$12,$13,false,$14,$14) RETURNING id`,
			userID, node.NodeKey, node.Kind, node.Name, summaryArg, node.Route, articleID,
			marshalAttributes(node.Attributes), marshalStrings(node.Aliases),
			int32(node.Weight), int32(index), node.Source, int32(node.Confidence), now).Scan(&createdID)
		if err != nil {
			return persistDraftResult{}, err
		}
		idByKey[node.NodeKey] = createdID
	}

	// 第二轮：回填 parent_id
	for i := range draft.Nodes {
		node := draft.Nodes[i]
		id, ok := idByKey[node.NodeKey]
		if !ok {
			continue
		}
		if existing := existingByKey[node.NodeKey]; existing != nil && existing.Locked {
			continue
		}
		var parentID any
		if node.ParentKey != nil {
			if pid, pok := idByKey[*node.ParentKey]; pok {
				parentID = pid
			}
		}
		if _, uerr := pool.Exec(ctx,
			`UPDATE petrichor_site_graph_node SET parent_id=$1, updated_at=$2 WHERE id=$3`,
			parentID, now, id); uerr != nil {
			return persistDraftResult{}, uerr
		}
	}

	// 清理本次草稿中不再出现的 Agent/系统节点（人工节点与锁定节点保留）
	draftKeys := make(map[string]struct{}, len(draft.Nodes))
	for i := range draft.Nodes {
		draftKeys[draft.Nodes[i].NodeKey] = struct{}{}
	}
	prunableNodes := []int64{}
	for _, n := range existingNodes {
		if n.Source == "MANUAL" || n.Locked {
			continue
		}
		if _, inDraft := draftKeys[n.NodeKey]; inDraft {
			continue
		}
		prunableNodes = append(prunableNodes, n.ID)
	}
	if len(prunableNodes) > 0 {
		if _, derr := pool.Exec(ctx,
			`DELETE FROM petrichor_site_graph_node WHERE id = ANY($1)`, prunableNodes); derr != nil {
			return persistDraftResult{}, derr
		}
	}

	existingEdges := []*edgeRecord{}
	edgeRows, err := pool.Query(ctx,
		`SELECT `+edgeColumns+` FROM petrichor_site_graph_edge WHERE user_id = $1`, userID)
	if err != nil {
		return persistDraftResult{}, err
	}
	for edgeRows.Next() {
		e, serr := scanEdgeRow(edgeRows)
		if serr != nil {
			edgeRows.Close()
			return persistDraftResult{}, serr
		}
		existingEdges = append(existingEdges, e)
	}
	edgeRows.Close()
	if err := edgeRows.Err(); err != nil {
		return persistDraftResult{}, err
	}

	existingEdgeMap := make(map[string]*edgeRecord, len(existingEdges))
	for _, e := range existingEdges {
		key := fmt.Sprintf("%d|%d|%s", e.FromNodeID, e.ToNodeID, e.Relation)
		existingEdgeMap[key] = e
	}

	keptEdgeIDs := make(map[int64]struct{})
	for i := range draft.Edges {
		edge := draft.Edges[i]
		fromID, fromOK := idByKey[edge.FromKey]
		toID, toOK := idByKey[edge.ToKey]
		if !fromOK || !toOK || fromID == toID {
			continue
		}
		triple := fmt.Sprintf("%d|%d|%s", fromID, toID, edge.Relation)
		existing := existingEdgeMap[triple]
		if existing != nil && existing.Locked {
			result.lockedSkipped++
			keptEdgeIDs[existing.ID] = struct{}{}
			continue
		}

		if existing != nil {
			_, uerr := pool.Exec(ctx,
				`UPDATE petrichor_site_graph_edge SET user_id=$1, from_node_id=$2, to_node_id=$3, relation=$4,
				 kind=$5, attributes_json=$6, weight=$7, directed=$8, source=$9, confidence=$10, updated_at=$11
				 WHERE id=$12`,
				userID, fromID, toID, edge.Relation, edge.Kind, marshalAttributes(edge.Attributes),
				int32(edge.Weight), edge.Directed, edge.Source, int32(edge.Confidence), now, existing.ID)
			if uerr != nil {
				return persistDraftResult{}, uerr
			}
			keptEdgeIDs[existing.ID] = struct{}{}
			continue
		}

		var createdID int64
		err := pool.QueryRow(ctx,
			`INSERT INTO petrichor_site_graph_edge
			 (user_id, from_node_id, to_node_id, relation, kind, attributes_json, weight, directed,
			  status, source, confidence, locked, created_at, updated_at)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9,$10,false,$11,$11) RETURNING id`,
			userID, fromID, toID, edge.Relation, edge.Kind, marshalAttributes(edge.Attributes),
			int32(edge.Weight), edge.Directed, edge.Source, int32(edge.Confidence), now).Scan(&createdID)
		if err != nil {
			return persistDraftResult{}, err
		}
		keptEdgeIDs[createdID] = struct{}{}
	}

	prunableEdges := []int64{}
	for _, e := range existingEdges {
		if e.Source == "MANUAL" || e.Locked {
			continue
		}
		if _, kept := keptEdgeIDs[e.ID]; kept {
			continue
		}
		prunableEdges = append(prunableEdges, e.ID)
	}
	if len(prunableEdges) > 0 {
		if _, derr := pool.Exec(ctx,
			`DELETE FROM petrichor_site_graph_edge WHERE id = ANY($1)`, prunableEdges); derr != nil {
			return persistDraftResult{}, derr
		}
	}

	var nodeCount, edgeCount int32
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM petrichor_site_graph_node WHERE user_id = $1`, userID).Scan(&nodeCount); err != nil {
		return persistDraftResult{}, err
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM petrichor_site_graph_edge WHERE user_id = $1`, userID).Scan(&edgeCount); err != nil {
		return persistDraftResult{}, err
	}

	result.nodeCount = int(nodeCount)
	result.edgeCount = int(edgeCount)
	result.prunedNodes = len(prunableNodes)
	result.prunedEdges = len(prunableEdges)
	return result, nil
}

// LoadStoredDraft 把库里的图还原成草稿形态（默认排除 ARCHIVED）供重新校验。
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
func CreateRun(ctx context.Context, userID int64, mode string) (*runRecord, error) {
	return scanRunRow(db.Pool().QueryRow(ctx,
		`INSERT INTO petrichor_site_graph_run (user_id, mode, status, created_at, updated_at)
		 VALUES ($1,$2,'RUNNING',now(),now()) RETURNING `+runColumns, userID, mode))
}

type runRecord struct {
	ID             int64
	UserID         int64
	Status         string
	Mode           string
	ModelName      *string
	ArticleCount   int32
	NodeCount      int32
	EdgeCount      int32
	ValidationJSON *string
	WarningsJSON   *string
	ErrorMessage   *string
	StartedAt      time.Time
	FinishedAt     *time.Time
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

const runColumns = `id, user_id, status, mode, model_name, article_count, node_count, edge_count,
	validation_json, warnings_json, error_message, started_at, finished_at, created_at, updated_at`

func scanRunRow(scanner interface{ Scan(dest ...any) error }) (*runRecord, error) {
	var r runRecord
	err := scanner.Scan(&r.ID, &r.UserID, &r.Status, &r.Mode, &r.ModelName, &r.ArticleCount,
		&r.NodeCount, &r.EdgeCount, &r.ValidationJSON, &r.WarningsJSON, &r.ErrorMessage,
		&r.StartedAt, &r.FinishedAt, &r.CreatedAt, &r.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// FinishRun 收尾一次运行记录。
func FinishRun(ctx context.Context, runID, userID int64, status string, modelName *string,
	articleCount, nodeCount, edgeCount int, validation *ValidationReport,
	warnings []string, errorMessage *string) error {
	now := time.Now()
	var validationArg any
	if validation != nil {
		raw, err := json.Marshal(validation)
		if err != nil {
			return err
		}
		validationArg = string(raw)
	}
	warningsRaw := warnings
	if warningsRaw == nil {
		warningsRaw = []string{}
	}
	warningsJSON, err := json.Marshal(warningsRaw)
	if err != nil {
		return err
	}
	_, err = db.Pool().Exec(ctx,
		`UPDATE petrichor_site_graph_run SET status=$1, model_name=$2, article_count=$3, node_count=$4,
		 edge_count=$5, validation_json=$6, warnings_json=$7, error_message=$8, finished_at=$9, updated_at=$9
		 WHERE id=$10 AND user_id=$11`,
		status, modelName, int32(articleCount), int32(nodeCount), int32(edgeCount), validationArg,
		string(warningsJSON), errorMessage, now, runID, userID)
	return err
}

func toRunSummary(r *runRecord) RunSummary {
	validation := json.RawMessage("null")
	if r.ValidationJSON != nil && strings.TrimSpace(*r.ValidationJSON) != "" {
		validation = json.RawMessage(*r.ValidationJSON)
	}
	warnings := []string{}
	if r.WarningsJSON != nil && strings.TrimSpace(*r.WarningsJSON) != "" {
		var parsed any
		if err := json.Unmarshal([]byte(*r.WarningsJSON), &parsed); err == nil {
			if arr, ok := parsed.([]any); ok {
				for _, item := range arr {
					warnings = append(warnings, toStringValue(item))
				}
			}
		}
	}
	var finishedAt *string
	if r.FinishedAt != nil {
		s := httpx.FormatISO(*r.FinishedAt)
		finishedAt = &s
	}
	return RunSummary{
		ID:           strconv.FormatInt(r.ID, 10),
		Status:       r.Status,
		Mode:         r.Mode,
		ModelName:    r.ModelName,
		ArticleCount: r.ArticleCount,
		NodeCount:    r.NodeCount,
		EdgeCount:    r.EdgeCount,
		Validation:   validation,
		Warnings:     warnings,
		ErrorMessage: r.ErrorMessage,
		StartedAt:    httpx.FormatISO(r.StartedAt),
		FinishedAt:   finishedAt,
	}
}

// ListRuns 最近 N 次运行记录。
func ListRuns(ctx context.Context, userID int64, limit int32) ([]RunSummary, error) {
	rows, err := db.Pool().Query(ctx,
		`SELECT `+runColumns+` FROM petrichor_site_graph_run WHERE user_id = $1
		 ORDER BY started_at DESC, id DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []RunSummary{}
	for rows.Next() {
		r, serr := scanRunRow(rows)
		if serr != nil {
			return nil, serr
		}
		list = append(list, toRunSummary(r))
	}
	return list, rows.Err()
}

// FailStaleRuns 把处于 RUNNING 且超时的历史记录标记失败。
func FailStaleRuns(ctx context.Context, userID int64) error {
	threshold := time.Now().Add(-time.Duration(StaleRunTimeoutMs) * time.Millisecond)
	rows, err := db.Pool().Query(ctx,
		`SELECT id, started_at FROM petrichor_site_graph_run
		 WHERE user_id=$1 AND status='RUNNING'`, userID)
	if err != nil {
		return err
	}
	staleIDs := []int64{}
	for rows.Next() {
		var id int64
		var startedAt time.Time
		if serr := rows.Scan(&id, &startedAt); serr != nil {
			rows.Close()
			return serr
		}
		if startedAt.Before(threshold) {
			staleIDs = append(staleIDs, id)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(staleIDs) == 0 {
		return nil
	}
	msg := "生成超时，已自动标记失败"
	_, err = db.Pool().Exec(ctx,
		`UPDATE petrichor_site_graph_run SET status='FAILED', error_message=$1, finished_at=now(), updated_at=now()
		 WHERE user_id=$2 AND id = ANY($3)`, msg, userID, staleIDs)
	return err
}

// ===== 实体对齐 =====

// LoadEntityRegistryEntries 把库里已有的概念/实体读成注册表条目。
func LoadEntityRegistryEntries(ctx context.Context, userID int64) ([]EntityRegistryEntry, error) {
	rows, err := db.Pool().Query(ctx,
		`SELECT node_key, name, kind, aliases_json, weight FROM petrichor_site_graph_node
		 WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []EntityRegistryEntry{}
	for rows.Next() {
		var row EntityRegistryEntry
		var aliasesJSON *string
		if serr := rows.Scan(&row.CanonicalKey, &row.Name, &row.Kind, &aliasesJSON, &row.Weight); serr != nil {
			return nil, serr
		}
		if !isAlignableKind(row.Kind) {
			continue
		}
		row.Aliases = parseAliasesFromJSON(aliasesJSON)
		entries = append(entries, row)
	}
	return entries, rows.Err()
}

// SaveMergeCandidates 写入本次运行发现的合并候选；已存在的对子保持原状态。
func SaveMergeCandidates(ctx context.Context, userID int64, candidates []*MergeCandidate) (int, error) {
	if len(candidates) == 0 {
		return 0, nil
	}
	pool := db.Pool()
	rows, err := pool.Query(ctx,
		`SELECT source_key, target_key FROM petrichor_site_graph_merge_candidate WHERE user_id = $1`, userID)
	if err != nil {
		return 0, err
	}
	existingPairs := map[string]struct{}{}
	for rows.Next() {
		var sourceKey, targetKey string
		if serr := rows.Scan(&sourceKey, &targetKey); serr != nil {
			rows.Close()
			return 0, serr
		}
		existingPairs[sourceKey+"|"+targetKey] = struct{}{}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	inserted := 0
	batch := &pgx.Batch{}
	for _, candidate := range candidates {
		pair := candidate.SourceKey + "|" + candidate.TargetKey
		if _, exists := existingPairs[pair]; exists {
			continue
		}
		existingPairs[pair] = struct{}{}
		inserted++
		detail := candidate.Detail
		batch.Queue(
			`INSERT INTO petrichor_site_graph_merge_candidate
			 (user_id, source_key, target_key, reason, score, detail, status, created_at, updated_at)
			 VALUES ($1,$2,$3,$4,$5,$6,'PENDING',now(),now())`,
			userID, candidate.SourceKey, candidate.TargetKey, candidate.Reason, int32(candidate.Score), detail)
	}
	if inserted > 0 {
		if err := pool.SendBatch(ctx, batch).Close(); err != nil {
			return 0, err
		}
	}
	return inserted, nil
}

// PruneStaleMergeCandidates 清理两端节点任一不存在的 PENDING 候选。
func PruneStaleMergeCandidates(ctx context.Context, userID int64) error {
	rows, err := db.Pool().Query(ctx,
		`SELECT id, source_key, target_key FROM petrichor_site_graph_merge_candidate
		 WHERE user_id=$1 AND status='PENDING'`, userID)
	if err != nil {
		return err
	}
	type candidateRow struct {
		id        int64
		sourceKey string
		targetKey string
	}
	candidates := []candidateRow{}
	for rows.Next() {
		var c candidateRow
		if serr := rows.Scan(&c.id, &c.sourceKey, &c.targetKey); serr != nil {
			rows.Close()
			return serr
		}
		candidates = append(candidates, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(candidates) == 0 {
		return nil
	}

	keyRows, err := db.Pool().Query(ctx,
		`SELECT node_key FROM petrichor_site_graph_node WHERE user_id = $1`, userID)
	if err != nil {
		return err
	}
	keys := map[string]struct{}{}
	for keyRows.Next() {
		var key string
		if serr := keyRows.Scan(&key); serr != nil {
			keyRows.Close()
			return serr
		}
		keys[key] = struct{}{}
	}
	keyRows.Close()
	if err := keyRows.Err(); err != nil {
		return err
	}

	staleIDs := []int64{}
	for _, c := range candidates {
		_, sourceOK := keys[c.sourceKey]
		_, targetOK := keys[c.targetKey]
		if sourceOK && targetOK {
			continue
		}
		staleIDs = append(staleIDs, c.id)
	}
	if len(staleIDs) == 0 {
		return nil
	}
	_, err = db.Pool().Exec(ctx,
		`DELETE FROM petrichor_site_graph_merge_candidate WHERE id = ANY($1)`, staleIDs)
	return err
}

// ListMergeCandidates 待确认合并候选列表。
func ListMergeCandidates(ctx context.Context, userID int64, limit int32) ([]MergeCandidateView, error) {
	pool := db.Pool()
	rows, err := pool.Query(ctx,
		`SELECT id, source_key, target_key, reason, score, detail, status, created_at
		 FROM petrichor_site_graph_merge_candidate
		 WHERE user_id=$1 AND status='PENDING'
		 ORDER BY score DESC, id DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	list := []MergeCandidateView{}
	for rows.Next() {
		var item MergeCandidateView
		var createdAt time.Time
		if serr := rows.Scan(&item.ID, &item.SourceKey, &item.TargetKey, &item.Reason,
			&item.Score, &item.Detail, &item.Status, &createdAt); serr != nil {
			rows.Close()
			return nil, serr
		}
		item.CreatedAt = httpx.FormatISO(createdAt)
		list = append(list, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	nodeRows, err := pool.Query(ctx,
		`SELECT id, node_key, name FROM petrichor_site_graph_node WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	type nodeLite struct {
		id      int64
		nodeKey string
		name    string
	}
	byKey := map[string]*nodeLite{}
	for nodeRows.Next() {
		n := &nodeLite{}
		if serr := nodeRows.Scan(&n.id, &n.nodeKey, &n.name); serr != nil {
			nodeRows.Close()
			return nil, serr
		}
		byKey[n.nodeKey] = n
	}
	nodeRows.Close()
	if err := nodeRows.Err(); err != nil {
		return nil, err
	}

	result := make([]MergeCandidateView, 0, len(list))
	for _, view := range list {
		if source := byKey[view.SourceKey]; source != nil {
			view.SourceName = source.name
			idStr := strconv.FormatInt(source.id, 10)
			view.SourceNodeID = &idStr
		} else {
			view.SourceName = "（已删除）"
		}
		if target := byKey[view.TargetKey]; target != nil {
			view.TargetName = target.name
			idStr := strconv.FormatInt(target.id, 10)
			view.TargetNodeID = &idStr
		} else {
			view.TargetName = "（已删除）"
		}
		result = append(result, view)
	}
	return result, nil
}

// IgnoreMergeCandidate 忽略合并候选。
func IgnoreMergeCandidate(ctx context.Context, userID, id int64) (map[string]any, error) {
	var updatedID int64
	err := db.Pool().QueryRow(ctx,
		`UPDATE petrichor_site_graph_merge_candidate SET status='IGNORED', updated_at=now()
		 WHERE id=$1 AND user_id=$2 RETURNING id`, id, userID).Scan(&updatedID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound("合并候选不存在")
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": strconv.FormatInt(updatedID, 10)}, nil
}

// MergeNodes 把 source 节点并入 target：别名/属性/权重归并，关系与子节点改挂，最后删 source。
func MergeNodes(ctx context.Context, userID, sourceNodeID, targetNodeID int64) (*MergeNodesResult, error) {
	if sourceNodeID == targetNodeID {
		return nil, httpx.BadRequest("不能把节点合并到它自己")
	}
	source, err := assertNodeOwned(ctx, userID, sourceNodeID)
	if err != nil {
		return nil, err
	}
	target, err := assertNodeOwned(ctx, userID, targetNodeID)
	if err != nil {
		return nil, err
	}

	looped, err := isDescendantOf(ctx, userID, targetNodeID, sourceNodeID)
	if err != nil {
		return nil, err
	}
	if looped {
		return nil, httpx.BadRequest("目标节点是来源节点的子孙，合并会破坏层级")
	}

	pool := db.Pool()
	sourceAttributes := parseAttributesFromJSON(source.AttributesJSON)
	targetAttributes := parseAttributesFromJSON(target.AttributesJSON)
	targetAttributeNames := map[string]string{}
	for _, item := range targetAttributes {
		targetAttributeNames[strings.ToLower(item.Name)] = item.Value
	}
	attributeConflicts := 0
	mergedAttributes := append([]Attribute{}, targetAttributes...)
	for _, attribute := range sourceAttributes {
		existingValue, exists := targetAttributeNames[strings.ToLower(attribute.Name)]
		if !exists {
			mergedAttributes = append(mergedAttributes, attribute)
			targetAttributeNames[strings.ToLower(attribute.Name)] = attribute.Value
			continue
		}
		if existingValue != attribute.Value {
			attributeConflicts++
		}
	}

	aliasRaw := make([]any, 0)
	for _, a := range parseAliasesFromJSON(target.AliasesJSON) {
		aliasRaw = append(aliasRaw, a)
	}
	for _, a := range parseAliasesFromJSON(source.AliasesJSON) {
		aliasRaw = append(aliasRaw, a)
	}
	aliasRaw = append(aliasRaw, source.Name)
	mergedAliases := normalizeAliases(aliasRaw)

	var summaryArg, routeArg any
	summary := ""
	if target.Summary != nil {
		summary = strings.TrimSpace(*target.Summary)
	}
	if summary != "" {
		summaryArg = summary
	} else if source.Summary != nil {
		summaryArg = *source.Summary
	}
	if target.Route != nil {
		routeArg = *target.Route
	} else if source.Route != nil {
		routeArg = *source.Route
	}

	confidence := target.Confidence
	if source.Confidence > confidence {
		confidence = source.Confidence
	}
	if _, err := pool.Exec(ctx,
		`UPDATE petrichor_site_graph_node SET attributes_json=$1, aliases_json=$2, weight=$3,
		 confidence=$4, summary=$5, route=$6, updated_at=now() WHERE id=$7`,
		marshalAttributes(normalizeAttributes(attributesToAny(mergedAttributes))),
		marshalStrings(mergedAliases),
		int32(ClampWeight(float64(target.Weight+source.Weight))), confidence,
		summaryArg, routeArg, target.ID); err != nil {
		return nil, err
	}

	// 关系改挂：撞到自环或已有同名三元组的直接删掉，避免违反唯一约束
	edges := []*edgeRecord{}
	edgeRows, err := pool.Query(ctx,
		`SELECT `+edgeColumns+` FROM petrichor_site_graph_edge WHERE user_id = $1`, userID)
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

	existingTriples := map[string]struct{}{}
	for _, e := range edges {
		if e.FromNodeID != source.ID && e.ToNodeID != source.ID {
			existingTriples[fmt.Sprintf("%d|%d|%s", e.FromNodeID, e.ToNodeID, e.Relation)] = struct{}{}
		}
	}

	movedEdges := 0
	droppedEdges := 0
	for _, e := range edges {
		if e.FromNodeID != source.ID && e.ToNodeID != source.ID {
			continue
		}
		nextFrom := e.FromNodeID
		if nextFrom == source.ID {
			nextFrom = target.ID
		}
		nextTo := e.ToNodeID
		if nextTo == source.ID {
			nextTo = target.ID
		}
		triple := fmt.Sprintf("%d|%d|%s", nextFrom, nextTo, e.Relation)

		if nextFrom == nextTo {
			if _, derr := pool.Exec(ctx, `DELETE FROM petrichor_site_graph_edge WHERE id=$1`, e.ID); derr != nil {
				return nil, derr
			}
			droppedEdges++
			continue
		}
		if _, dup := existingTriples[triple]; dup {
			if _, derr := pool.Exec(ctx, `DELETE FROM petrichor_site_graph_edge WHERE id=$1`, e.ID); derr != nil {
				return nil, derr
			}
			droppedEdges++
			continue
		}
		existingTriples[triple] = struct{}{}
		if _, uerr := pool.Exec(ctx,
			`UPDATE petrichor_site_graph_edge SET from_node_id=$1, to_node_id=$2, updated_at=now() WHERE id=$3`,
			nextFrom, nextTo, e.ID); uerr != nil {
			return nil, uerr
		}
		movedEdges++
	}

	var movedChildren int32
	if err := pool.QueryRow(ctx,
		`WITH moved AS (
			UPDATE petrichor_site_graph_node SET parent_id=$1, updated_at=now()
			WHERE user_id=$2 AND parent_id=$3 RETURNING id
		) SELECT count(*) FROM moved`, target.ID, userID, source.ID).Scan(&movedChildren); err != nil {
		return nil, err
	}

	if _, err := pool.Exec(ctx, `DELETE FROM petrichor_site_graph_node WHERE id=$1`, source.ID); err != nil {
		return nil, err
	}

	// 涉及来源键的候选都已了结
	if _, err := pool.Exec(ctx,
		`UPDATE petrichor_site_graph_merge_candidate SET status='MERGED', updated_at=now()
		 WHERE user_id=$1 AND source_key=$2`, userID, source.NodeKey); err != nil {
		return nil, err
	}

	return &MergeNodesResult{
		TargetKey:          target.NodeKey,
		AbsorbedAliases:    len(mergedAliases),
		MovedEdges:         movedEdges,
		DroppedEdges:       droppedEdges,
		MovedChildren:      int(movedChildren),
		AttributeConflicts: attributeConflicts,
	}, nil
}

// ListNodeOptions 后台节点下拉框用的精简列表。
func ListNodeOptions(ctx context.Context, userID int64) ([]map[string]any, error) {
	rows, err := db.Pool().Query(ctx,
		`SELECT id, node_key, name, kind FROM petrichor_site_graph_node WHERE user_id = $1
		 ORDER BY kind ASC, name ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []map[string]any{}
	for rows.Next() {
		var id int64
		var nodeKey, name, kind string
		if serr := rows.Scan(&id, &nodeKey, &name, &kind); serr != nil {
			return nil, serr
		}
		list = append(list, map[string]any{
			"id":      strconv.FormatInt(id, 10),
			"nodeKey": nodeKey,
			"name":    name,
			"kind":    kind,
		})
	}
	return list, rows.Err()
}
