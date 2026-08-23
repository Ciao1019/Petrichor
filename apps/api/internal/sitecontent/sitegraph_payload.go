// sitegraph_payload.go 移植 src/server/site-graph/public-graph.ts + store.ts 的
// loadPublicGraphPayload 与 payload.ts 纯函数：前台点群公开载荷。
package sitecontent

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

// RootKey 根节点业务键（对应 SITE_GRAPH_ROOT_KEY）。
const RootKey = "root"

// Attribute 节点/关系的结构化属性。
type Attribute struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// PayloadNode 前台点群渲染载荷中的节点。
type PayloadNode struct {
	ID           string      `json:"id"`
	Label        string      `json:"label"`
	Kind         string      `json:"kind"`
	Route        *string     `json:"route"`
	Summary      string      `json:"summary"`
	Attributes   []Attribute `json:"attributes"`
	Aliases      []string    `json:"aliases"`
	ParentID     *string     `json:"parentId"`
	TopSectionID *string     `json:"topSectionId"`
	Weight       int32       `json:"weight"`
}

// PayloadLink 前台点群渲染载荷中的连线。
type PayloadLink struct {
	Source   string `json:"source"`
	Target   string `json:"target"`
	Kind     string `json:"kind"`
	Relation string `json:"relation"`
}

// PayloadStats 载荷统计。
type PayloadStats struct {
	NodeCount    int `json:"nodeCount"`
	LinkCount    int `json:"linkCount"`
	ArticleCount int `json:"articleCount"`
	ConceptCount int `json:"conceptCount"`
}

// SiteGraphPayload 前台星图完整载荷。
type SiteGraphPayload struct {
	Nodes       []PayloadNode `json:"nodes"`
	Links       []PayloadLink `json:"links"`
	Stats       PayloadStats  `json:"stats"`
	GeneratedAt *string       `json:"generatedAt"`
}

type graphNodeRecord struct {
	ID             int64
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
	Status         string
	UpdatedAt      time.Time
}

const graphNodeColumns = `id, node_key, parent_id, kind, name, summary, route, article_id,
	attributes_json, aliases_json, weight, status, updated_at`

func scanGraphNode(scanner interface{ Scan(dest ...any) error }) (*graphNodeRecord, error) {
	var n graphNodeRecord
	if err := scanner.Scan(&n.ID, &n.NodeKey, &n.ParentID, &n.Kind, &n.Name, &n.Summary,
		&n.Route, &n.ArticleID, &n.AttributesJSON, &n.AliasesJSON, &n.Weight, &n.Status,
		&n.UpdatedAt); err != nil {
		return nil, err
	}
	return &n, nil
}

type graphEdgeRecord struct {
	ID         int64
	FromNodeID int64
	ToNodeID   int64
	Relation   string
	Kind       string
	Status     string
}

// publicSiteArticleRow 公开文章可见性判定的行数据。
type publicSiteArticleRow struct {
	articleID int64
	title     string
	href      string
}

func isInternalSitePath(value string) bool {
	trimmed := strings.TrimSpace(value)
	if !strings.HasPrefix(trimmed, "/") || strings.HasPrefix(trimmed, "//") {
		return false
	}
	return strings.TrimSpace(trimmed) != "" && !strings.ContainsAny(trimmed, " \t")
}

// resolvePublicArticleHref 配置了内部链接时直跳站内页面，否则进文章详情页。
func resolvePublicArticleHref(shareCode string, internalURL *string) string {
	if internalURL != nil && isInternalSitePath(*internalURL) {
		return strings.TrimSpace(*internalURL)
	}
	return "/p/" + shareCode
}

// loadPublicSiteArticles 复刻 loadPublicSiteArticles 的可见性判定：
// 启用且未撤销、未过期、无密码、有 shareCode 的分享才允许进图谱。
func loadPublicSiteArticles(ctx context.Context) ([]publicSiteArticleRow, error) {
	rows, err := db.Pool().Query(ctx,
		`SELECT s.article_id, a.title, s.internal_url, s.share_code
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
	list := []publicSiteArticleRow{}
	for rows.Next() {
		var r publicSiteArticleRow
		var internalURL *string
		var shareCode string
		if serr := rows.Scan(&r.articleID, &r.title, &internalURL, &shareCode); serr != nil {
			return nil, serr
		}
		r.href = resolvePublicArticleHref(shareCode, internalURL)
		list = append(list, r)
	}
	return list, rows.Err()
}

func parseGraphAttributes(raw *string) []Attribute {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return []Attribute{}
	}
	var parsed []Attribute
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return []Attribute{}
	}
	out := make([]Attribute, 0, len(parsed))
	for _, item := range parsed {
		name := clampAttrText(item.Name, 20)
		value := clampAttrText(item.Value, 80)
		if name == "" || value == "" {
			continue
		}
		out = append(out, Attribute{Name: name, Value: value})
		if len(out) >= 8 {
			break
		}
	}
	return out
}

func parseGraphAliases(raw *string) []string {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return []string{}
	}
	var parsed []string
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return []string{}
	}
	seen := map[string]struct{}{}
	values := []string{}
	for _, item := range parsed {
		alias := clampAttrText(item, 40)
		if alias == "" {
			continue
		}
		key := strings.ToLower(alias)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		values = append(values, alias)
		if len(values) >= 6 {
			break
		}
	}
	return values
}

// clampAttrText 对应 normalize.ts 的 clampText：折叠空白并截断。
func clampAttrText(raw string, maxLength int) string {
	text := strings.Join(strings.Fields(raw), " ")
	runes := []rune(text)
	if len(runes) > maxLength {
		return strings.TrimSpace(string(runes[:maxLength]))
	}
	return text
}

// isEvidenceLink 结构连线只表达层级归属，不构成「这个概念还有公开依据」的证据。
func isEvidenceLink(link PayloadLink) bool { return link.Kind != "structure" }

// keepArticleReachableNodes 只保留能追溯到可见文章的概念/实体/标签：
// 从文章节点出发 BFS；root/section 恒保留，article 可见性由上游把关。
func keepArticleReachableNodes(nodes []PayloadNode, links []PayloadLink) []PayloadNode {
	nodeIDs := map[string]struct{}{}
	for _, node := range nodes {
		nodeIDs[node.ID] = struct{}{}
	}
	neighbors := map[string][]string{}
	for _, link := range links {
		if !isEvidenceLink(link) {
			continue
		}
		if _, ok := nodeIDs[link.Source]; !ok {
			continue
		}
		if _, ok := nodeIDs[link.Target]; !ok {
			continue
		}
		neighbors[link.Source] = append(neighbors[link.Source], link.Target)
		neighbors[link.Target] = append(neighbors[link.Target], link.Source)
	}

	reachable := map[string]struct{}{}
	queue := []string{}
	for _, node := range nodes {
		if node.Kind == "article" {
			reachable[node.ID] = struct{}{}
			queue = append(queue, node.ID)
		}
	}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		for _, neighbor := range neighbors[current] {
			if _, ok := reachable[neighbor]; ok {
				continue
			}
			reachable[neighbor] = struct{}{}
			queue = append(queue, neighbor)
		}
	}

	out := make([]PayloadNode, 0, len(nodes))
	for _, node := range nodes {
		switch node.Kind {
		case "root", "section", "article":
			out = append(out, node)
		default:
			if _, ok := reachable[node.ID]; ok {
				out = append(out, node)
			}
		}
	}
	return out
}

// assignTopSections 顶层分类 = 根的直接子节点；点群按它聚簇着色。
func assignTopSections(nodes []PayloadNode) {
	byID := map[string]PayloadNode{}
	for _, node := range nodes {
		byID[node.ID] = node
	}
	for i := range nodes {
		node := &nodes[i]
		if node.ID == RootKey {
			continue
		}
		current := node
		visited := map[string]struct{}{}
		topSection := ""
		for current != nil && current.ParentID != nil {
			if _, looped := visited[current.ID]; looped {
				break
			}
			visited[current.ID] = struct{}{}
			if *current.ParentID == RootKey {
				topSection = current.ID
				break
			}
			next, ok := byID[*current.ParentID]
			if !ok {
				break
			}
			current = &next
		}
		if topSection != "" {
			node.TopSectionID = &topSection
		} else {
			self := node.ID
			node.TopSectionID = &self
		}
	}
}

// dropEmptySections 摘掉节点后只剩空壳的分类没有展示价值（root 保留）。
func dropEmptySections(nodes []PayloadNode) []PayloadNode {
	childCount := map[string]int{}
	for _, node := range nodes {
		if node.ParentID == nil {
			continue
		}
		childCount[*node.ParentID]++
	}
	out := make([]PayloadNode, 0, len(nodes))
	for _, node := range nodes {
		if node.Kind == "section" && childCount[node.ID] <= 0 {
			continue
		}
		out = append(out, node)
	}
	return out
}

// LoadPublicGraphPayload 前台点群载荷（未缓存）：
// 只取 PUBLISHED 节点/关系，并以当前公开文章集为唯一事实来源重新过滤。
func LoadPublicGraphPayload(ctx context.Context) (*SiteGraphPayload, error) {
	pool := db.Pool()

	nodes := []*graphNodeRecord{}
	nodeRows, err := pool.Query(ctx,
		`SELECT `+graphNodeColumns+` FROM petrichor_site_graph_node
		 WHERE status = 'PUBLISHED' ORDER BY sort_order ASC, id ASC`)
	if err != nil {
		return nil, err
	}
	for nodeRows.Next() {
		n, serr := scanGraphNode(nodeRows)
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

	edges := []*graphEdgeRecord{}
	edgeRows, err := pool.Query(ctx,
		`SELECT id, from_node_id, to_node_id, relation, kind, status
		 FROM petrichor_site_graph_edge WHERE status = 'PUBLISHED'`)
	if err != nil {
		return nil, err
	}
	for edgeRows.Next() {
		var e graphEdgeRecord
		if serr := edgeRows.Scan(&e.ID, &e.FromNodeID, &e.ToNodeID, &e.Relation, &e.Kind, &e.Status); serr != nil {
			edgeRows.Close()
			return nil, serr
		}
		edges = append(edges, &e)
	}
	edgeRows.Close()
	if err := edgeRows.Err(); err != nil {
		return nil, err
	}

	publicArticles, err := loadPublicSiteArticles(ctx)
	if err != nil {
		return nil, err
	}
	liveArticles := map[int64]publicSiteArticleRow{}
	for _, article := range publicArticles {
		liveArticles[article.articleID] = article
	}

	// 同一业务键取 updatedAt 最新的一条；文章节点必须仍在当前公开文章集中。
	nodeByKey := map[string]*graphNodeRecord{}
	for _, n := range nodes {
		if n.Kind == "article" {
			if n.ArticleID == nil {
				continue
			}
			if _, live := liveArticles[*n.ArticleID]; !live {
				continue
			}
		}
		existing, ok := nodeByKey[n.NodeKey]
		if !ok || existing.UpdatedAt.Before(n.UpdatedAt) {
			nodeByKey[n.NodeKey] = n
		}
	}

	keptIDs := map[int64]struct{}{}
	keyByID := map[int64]string{}
	for _, n := range nodeByKey {
		keptIDs[n.ID] = struct{}{}
		keyByID[n.ID] = n.NodeKey
	}

	payloadNodes := []PayloadNode{}
	links := []PayloadLink{}

	for _, n := range nodeByKey {
		var parentKey *string
		if n.ParentID != nil {
			if key, ok := keyByID[*n.ParentID]; ok {
				parentKey = &key
			}
		}
		label := n.Name
		route := n.Route
		if n.ArticleID != nil {
			if live, ok := liveArticles[*n.ArticleID]; ok {
				// 以文章列表为唯一事实来源：标题和链接用最新值覆盖。
				label = live.title
				href := live.href
				route = &href
			}
		}
		summary := ""
		if n.Summary != nil {
			summary = *n.Summary
		}
		payloadNodes = append(payloadNodes, PayloadNode{
			ID:         n.NodeKey,
			Label:      label,
			Kind:       n.Kind,
			Route:      route,
			Summary:    summary,
			Attributes: parseGraphAttributes(n.AttributesJSON),
			Aliases:    parseGraphAliases(n.AliasesJSON),
			ParentID:   parentKey,
			Weight:     n.Weight,
		})
		if parentKey != nil {
			links = append(links, PayloadLink{Source: *parentKey, Target: n.NodeKey, Kind: "structure", Relation: "包含"})
		}
	}

	for _, e := range edges {
		if _, ok := keptIDs[e.FromNodeID]; !ok {
			continue
		}
		if _, ok := keptIDs[e.ToNodeID]; !ok {
			continue
		}
		source, sok := keyByID[e.FromNodeID]
		target, tok := keyByID[e.ToNodeID]
		if !sok || !tok || source == target {
			continue
		}
		links = append(links, PayloadLink{Source: source, Target: target, Kind: e.Kind, Relation: e.Relation})
	}

	// 文章下架后失去全部公开依据的概念/实体/标签一并摘掉，随后清掉空分类。
	visibleNodes := dropEmptySections(keepArticleReachableNodes(payloadNodes, links))
	assignTopSections(visibleNodes)

	visibleIDs := map[string]struct{}{}
	for _, node := range visibleNodes {
		visibleIDs[node.ID] = struct{}{}
	}
	visibleLinks := make([]PayloadLink, 0, len(links))
	for _, link := range links {
		if _, ok := visibleIDs[link.Source]; !ok {
			continue
		}
		if _, ok := visibleIDs[link.Target]; !ok {
			continue
		}
		visibleLinks = append(visibleLinks, link)
	}

	var generatedAt *string
	for _, n := range nodeByKey {
		stamp := httpx.FormatISO(n.UpdatedAt)
		if generatedAt == nil || stamp > *generatedAt {
			generatedAt = &stamp
		}
	}

	stats := PayloadStats{
		NodeCount: len(visibleNodes),
		LinkCount: len(visibleLinks),
	}
	for _, node := range visibleNodes {
		switch node.Kind {
		case "article":
			stats.ArticleCount++
		case "concept", "entity":
			stats.ConceptCount++
		}
	}

	return &SiteGraphPayload{
		Nodes:       visibleNodes,
		Links:       visibleLinks,
		Stats:       stats,
		GeneratedAt: generatedAt,
	}, nil
}

// LoadPublicSiteGraphResponse 星图载荷的 map 形态（缓存序列化友好）。
func LoadPublicSiteGraphResponse(ctx context.Context) (map[string]any, error) {
	payload, err := LoadPublicGraphPayload(ctx)
	if err != nil {
		return nil, err
	}
	var generatedAt any
	if payload.GeneratedAt != nil {
		generatedAt = *payload.GeneratedAt
	}
	nodes := payload.Nodes
	links := payload.Links
	if nodes == nil {
		nodes = []PayloadNode{}
	}
	if links == nil {
		links = []PayloadLink{}
	}
	return map[string]any{
		"nodes":       nodes,
		"links":       links,
		"stats":       payload.Stats,
		"generatedAt": generatedAt,
	}, nil
}
