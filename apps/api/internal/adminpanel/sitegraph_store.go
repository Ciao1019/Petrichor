// sitegraph_store.go 实现星图存储和查询：
// 邻接表 + 关系表的落库、发布流转、运行记录与递归 CTE 图查询。
package adminpanel

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

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
