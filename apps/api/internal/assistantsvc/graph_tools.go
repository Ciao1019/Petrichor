package assistantsvc

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"petrichor/api/internal/adminpanel"
	rt "petrichor/api/internal/assistantsvc/runtime"
	"petrichor/api/internal/sitecontent"
)

const (
	graphDefaultMaxHops = 2
	graphDefaultLimit   = 5
	graphMaxPaths       = 12
	graphMaxNodes       = 60
)

var (
	graphQuerySeparator = regexp.MustCompile(`[\s,，。、；;：:？?！!（）()「」【】/|]+`)
	graphArticleID      = regexp.MustCompile(`^article-(\d+)$`)
)

const (
	graphSearchSchema = `{"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":200},"maxHops":{"type":"integer","minimum":1,"maximum":3},"limit":{"type":"integer","minimum":1,"maximum":10}},"required":["query"]}`
	graphExpandSchema = `{"type":"object","properties":{"entity":{"type":"string","minLength":1,"maxLength":120},"maxHops":{"type":"integer","minimum":1,"maximum":3},"limit":{"type":"integer","minimum":1,"maximum":20}},"required":["entity"]}`
	graphEntitySchema = `{"type":"object","properties":{"entity":{"type":"string","minLength":1,"maxLength":120}},"required":["entity"]}`
)

type graphRetrievalNode struct {
	ID    string  `json:"id"`
	Label string  `json:"label"`
	Kind  string  `json:"kind"`
	Hop   int     `json:"hop"`
	Route *string `json:"route"`
}

type graphRetrievalMatch struct {
	ID         string                  `json:"id"`
	Label      string                  `json:"label"`
	Kind       string                  `json:"kind"`
	Summary    string                  `json:"summary"`
	Route      *string                 `json:"route"`
	Attributes []sitecontent.Attribute `json:"attributes"`
	MatchedBy  string                  `json:"matchedBy,omitempty"`
}

type graphRetrievalLink struct {
	Source   string `json:"source"`
	Target   string `json:"target"`
	Relation string `json:"relation"`
	Kind     string `json:"kind"`
}

type graphRetrievalPathNode struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Kind  string `json:"kind"`
}

type graphRetrievalArticle struct {
	ArticleID   *string  `json:"articleId"`
	Title       string   `json:"title"`
	Href        *string  `json:"href"`
	ViaConcepts []string `json:"viaConcepts,omitempty"`
}

type graphRetrievalPath struct {
	Nodes     []graphRetrievalPathNode `json:"nodes"`
	Relations []string                 `json:"relations"`
	Article   *graphRetrievalArticle   `json:"article,omitempty"`
}

type graphRetrievalResult struct {
	Query        string                  `json:"query"`
	Matched      []graphRetrievalMatch   `json:"matched"`
	Nodes        []graphRetrievalNode    `json:"nodes"`
	Links        []graphRetrievalLink    `json:"links"`
	Paths        []graphRetrievalPath    `json:"paths"`
	Articles     []graphRetrievalArticle `json:"articles"`
	EmptyMessage string                  `json:"emptyMessage,omitempty"`
}

type graphScoredNode struct {
	Node      sitecontent.PayloadNode
	Score     int
	MatchedBy string
}

type graphNeighbor struct {
	ID       string
	Relation string
	Kind     string
}

type graphPredecessor struct {
	From     string
	Relation string
}

func registerGraphTools(registry interface {
	Register(tool *rt.AgentToolDefinition)
}) {
	registry.Register(&rt.AgentToolDefinition{
		ID: "graph.search", Name: "search_knowledge_graph", Namespace: rt.NamespaceGraph,
		Description: "在公开知识图谱中按问题匹配概念/实体并沿关系边扩散，返回关系链与关联文章；私有知识库正文请用 knowledge.search。",
		InputSchema: schemaJSON(graphSearchSchema), RiskLevel: rt.RiskLow, Tags: []string{"retrieval"},
		Execute: func(ctx *rt.ToolExecutionContext, input any) (any, error) {
			params, _ := input.(map[string]any)
			return executeGraphQuery(ctx, stringValue(params["query"]), intValue(params["maxHops"]), intValue(params["limit"]), graphDefaultMaxHops)
		},
		Normalize: graphNormalizer("search"),
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "graph.expand", Name: "expand_knowledge_graph", Namespace: rt.NamespaceGraph,
		Description: "从已知实体或概念出发沿关系边扩散，查找邻接实体、关系链与关联公开文章。",
		InputSchema: schemaJSON(graphExpandSchema), RiskLevel: rt.RiskLow, Tags: []string{"retrieval"},
		Execute: func(ctx *rt.ToolExecutionContext, input any) (any, error) {
			params, _ := input.(map[string]any)
			return executeGraphQuery(ctx, stringValue(params["entity"]), intValue(params["maxHops"]), intValue(params["limit"]), 2)
		},
		Normalize: graphNormalizer("expand"),
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "graph.get_entity", Name: "get_graph_entity", Namespace: rt.NamespaceGraph,
		Description: "读取一个公开图谱实体的类型、摘要、属性与站内路径；需要关系边时使用 graph.get_relations。",
		InputSchema: schemaJSON(graphEntitySchema), RiskLevel: rt.RiskLow, Tags: []string{"retrieval"},
		Execute: func(ctx *rt.ToolExecutionContext, input any) (any, error) {
			params, _ := input.(map[string]any)
			entity := strings.TrimSpace(stringValue(params["entity"]))
			result, err := executeGraphQuery(ctx, entity, 1, 3, 1)
			if err != nil {
				return nil, err
			}
			return map[string]any{"entity": entity, "matched": result.Matched, "emptyMessage": result.EmptyMessage}, nil
		},
		Normalize: normalizeGraphEntity,
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "graph.get_relations", Name: "get_graph_relations", Namespace: rt.NamespaceGraph,
		Description: "读取一个公开图谱实体的可见关系边，列出关系名、方向及对端实体。",
		InputSchema: schemaJSON(graphEntitySchema), RiskLevel: rt.RiskLow, Tags: []string{"retrieval"},
		Execute: func(ctx *rt.ToolExecutionContext, input any) (any, error) {
			params, _ := input.(map[string]any)
			entity := strings.TrimSpace(stringValue(params["entity"]))
			result, err := executeGraphQuery(ctx, entity, 1, 5, 1)
			if err != nil {
				return nil, err
			}
			return map[string]any{"entity": entity, "links": result.Links, "nodes": result.Nodes}, nil
		},
		Normalize: normalizeGraphRelations,
	})
}

func executeGraphQuery(ctx *rt.ToolExecutionContext, query string, maxHops, limit, defaultHops int) (graphRetrievalResult, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return graphRetrievalResult{}, rt.ValidationError("query/entity 不能为空")
	}
	payload, err := sitecontent.LoadPublicGraphPayload(toolContext(ctx))
	if err != nil {
		return graphRetrievalResult{}, err
	}
	if maxHops <= 0 {
		maxHops = defaultHops
	}
	if limit <= 0 {
		limit = graphDefaultLimit
	}
	return retrieveFromGraph(payload, query, maxHops, limit), nil
}

func buildGraphQueryTerms(query string) []string {
	raw := strings.TrimSpace(query)
	terms := []string{raw}
	for _, part := range graphQuerySeparator.Split(raw, -1) {
		part = strings.TrimSpace(part)
		if len([]rune(part)) >= 2 && part != raw {
			terms = append(terms, part)
		}
	}
	return terms
}

func scoreGraphNode(node sitecontent.PayloadNode, normalizedQuery, rawQuery string) (int, string) {
	label := adminpanel.NormalizeEntityName(node.Label)
	if normalizedQuery == "" {
		return 0, ""
	}
	if label == normalizedQuery {
		return 100, "name"
	}
	for _, alias := range node.Aliases {
		if adminpanel.NormalizeEntityName(alias) == normalizedQuery {
			return 95, "alias"
		}
	}
	if label != "" && (strings.Contains(label, normalizedQuery) || strings.Contains(normalizedQuery, label)) {
		shorter, longer := len([]rune(label)), len([]rune(normalizedQuery))
		if shorter > longer {
			shorter, longer = longer, shorter
		}
		if longer > 0 {
			return int(60*float64(shorter)/float64(longer)+0.5) + 20, "name"
		}
	}
	for _, alias := range node.Aliases {
		normalizedAlias := adminpanel.NormalizeEntityName(alias)
		if normalizedAlias != "" && (strings.Contains(normalizedAlias, normalizedQuery) || strings.Contains(normalizedQuery, normalizedAlias)) {
			return 55, "alias"
		}
	}
	for _, attribute := range node.Attributes {
		if strings.Contains(adminpanel.NormalizeEntityName(attribute.Value), normalizedQuery) {
			return 40, "attribute"
		}
	}
	if rawQuery != "" && strings.Contains(node.Summary, rawQuery) {
		return 30, "summary"
	}
	return 0, ""
}

func pickGraphMatches(payload *sitecontent.SiteGraphPayload, query string, limit int) []graphScoredNode {
	best := map[string]graphScoredNode{}
	for _, term := range buildGraphQueryTerms(query) {
		normalized := adminpanel.NormalizeEntityName(term)
		if normalized == "" {
			continue
		}
		for _, node := range payload.Nodes {
			if node.Kind == "root" || node.Kind == "section" {
				continue
			}
			score, matchedBy := scoreGraphNode(node, normalized, term)
			if score <= 0 {
				continue
			}
			previous, exists := best[node.ID]
			if !exists || score > previous.Score {
				best[node.ID] = graphScoredNode{Node: node, Score: score, MatchedBy: matchedBy}
			}
		}
	}
	matches := make([]graphScoredNode, 0, len(best))
	for _, match := range best {
		matches = append(matches, match)
	}
	sort.Slice(matches, func(i, j int) bool {
		if matches[i].Score != matches[j].Score {
			return matches[i].Score > matches[j].Score
		}
		if matches[i].Node.Weight != matches[j].Node.Weight {
			return matches[i].Node.Weight > matches[j].Node.Weight
		}
		return matches[i].Node.ID < matches[j].Node.ID
	})
	if limit < len(matches) {
		matches = matches[:limit]
	}
	return matches
}

func expandGraphNeighborhood(payload *sitecontent.SiteGraphPayload, entryIDs []string, maxHops int) (map[string]sitecontent.PayloadNode, map[string]int, map[string]graphPredecessor, []graphRetrievalLink) {
	nodeByID := make(map[string]sitecontent.PayloadNode, len(payload.Nodes))
	for _, node := range payload.Nodes {
		nodeByID[node.ID] = node
	}
	neighbors := map[string][]graphNeighbor{}
	for _, link := range payload.Links {
		if link.Kind == "structure" {
			continue
		}
		if _, ok := nodeByID[link.Source]; !ok {
			continue
		}
		if _, ok := nodeByID[link.Target]; !ok {
			continue
		}
		neighbors[link.Source] = append(neighbors[link.Source], graphNeighbor{ID: link.Target, Relation: link.Relation, Kind: link.Kind})
		neighbors[link.Target] = append(neighbors[link.Target], graphNeighbor{ID: link.Source, Relation: link.Relation, Kind: link.Kind})
	}
	for id := range neighbors {
		sort.Slice(neighbors[id], func(i, j int) bool {
			if neighbors[id][i].ID != neighbors[id][j].ID {
				return neighbors[id][i].ID < neighbors[id][j].ID
			}
			return neighbors[id][i].Relation < neighbors[id][j].Relation
		})
	}

	hopByID := map[string]int{}
	prevByID := map[string]graphPredecessor{}
	usedLinks := []graphRetrievalLink{}
	seenLinks := map[string]bool{}
	queue := []string{}
	for _, id := range entryIDs {
		if _, exists := nodeByID[id]; !exists {
			continue
		}
		if _, exists := hopByID[id]; exists {
			continue
		}
		hopByID[id] = 0
		queue = append(queue, id)
	}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		hop := hopByID[current]
		if hop >= maxHops {
			continue
		}
		for _, edge := range neighbors[current] {
			ends := []string{current, edge.ID}
			sort.Strings(ends)
			key := strings.Join(ends, "|") + "|" + edge.Relation
			if !seenLinks[key] {
				seenLinks[key] = true
				usedLinks = append(usedLinks, graphRetrievalLink{Source: current, Target: edge.ID, Relation: edge.Relation, Kind: edge.Kind})
			}
			if _, seen := hopByID[edge.ID]; seen || len(hopByID) >= graphMaxNodes {
				continue
			}
			hopByID[edge.ID] = hop + 1
			prevByID[edge.ID] = graphPredecessor{From: current, Relation: edge.Relation}
			queue = append(queue, edge.ID)
		}
	}
	return nodeByID, hopByID, prevByID, usedLinks
}

func extractGraphArticleID(nodeID string) *string {
	match := graphArticleID.FindStringSubmatch(nodeID)
	if len(match) != 2 {
		return nil
	}
	value := match[1]
	return &value
}

func traceGraphPath(targetID string, nodeByID map[string]sitecontent.PayloadNode, prevByID map[string]graphPredecessor) *graphRetrievalPath {
	nodes := []graphRetrievalPathNode{}
	relations := []string{}
	seen := map[string]bool{}
	for cursor := targetID; cursor != "" && !seen[cursor]; {
		seen[cursor] = true
		node, exists := nodeByID[cursor]
		if !exists {
			return nil
		}
		nodes = append([]graphRetrievalPathNode{{ID: node.ID, Label: node.Label, Kind: node.Kind}}, nodes...)
		previous, exists := prevByID[cursor]
		if !exists {
			break
		}
		relations = append([]string{previous.Relation}, relations...)
		cursor = previous.From
	}
	if len(nodes) < 2 {
		return nil
	}
	path := &graphRetrievalPath{Nodes: nodes, Relations: relations}
	tail := nodeByID[targetID]
	if tail.Kind == "article" {
		path.Article = &graphRetrievalArticle{ArticleID: extractGraphArticleID(tail.ID), Title: tail.Label, Href: tail.Route}
	}
	return path
}

func retrieveFromGraph(payload *sitecontent.SiteGraphPayload, query string, maxHops, limit int) graphRetrievalResult {
	query = strings.TrimSpace(query)
	if maxHops < 1 {
		maxHops = graphDefaultMaxHops
	}
	if maxHops > 3 {
		maxHops = 3
	}
	if limit < 1 {
		limit = graphDefaultLimit
	}
	if limit > 10 {
		limit = 10
	}
	matches := pickGraphMatches(payload, query, limit)
	if len(matches) == 0 {
		return graphRetrievalResult{
			Query: query, Matched: []graphRetrievalMatch{}, Nodes: []graphRetrievalNode{}, Links: []graphRetrievalLink{},
			Paths: []graphRetrievalPath{}, Articles: []graphRetrievalArticle{},
			EmptyMessage: "星图里没有匹配的概念或实体，请改用 search_public_articles 做全文检索",
		}
	}
	entryIDs := make([]string, 0, len(matches))
	for _, match := range matches {
		entryIDs = append(entryIDs, match.Node.ID)
	}
	nodeByID, hopByID, prevByID, links := expandGraphNeighborhood(payload, entryIDs, maxHops)

	nodes := make([]graphRetrievalNode, 0, len(hopByID))
	for id, hop := range hopByID {
		node := nodeByID[id]
		nodes = append(nodes, graphRetrievalNode{ID: id, Label: node.Label, Kind: node.Kind, Hop: hop, Route: node.Route})
	}
	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].Hop != nodes[j].Hop {
			return nodes[i].Hop < nodes[j].Hop
		}
		return nodes[i].ID < nodes[j].ID
	})

	matched := make([]graphRetrievalMatch, 0, len(matches))
	for _, match := range matches {
		matched = append(matched, graphRetrievalMatch{
			ID: match.Node.ID, Label: match.Node.Label, Kind: match.Node.Kind,
			Summary: truncateRunes(match.Node.Summary, 100), Route: match.Node.Route,
			Attributes: match.Node.Attributes, MatchedBy: match.MatchedBy,
		})
	}

	targets := make([]graphRetrievalNode, 0, len(nodes))
	for _, node := range nodes {
		if node.Kind == "article" && node.Hop > 0 {
			targets = append(targets, node)
		}
	}
	for _, node := range nodes {
		if node.Kind != "article" && node.Hop > 0 {
			targets = append(targets, node)
		}
	}
	paths := []graphRetrievalPath{}
	for _, target := range targets {
		if path := traceGraphPath(target.ID, nodeByID, prevByID); path != nil {
			paths = append(paths, *path)
			if len(paths) >= graphMaxPaths {
				break
			}
		}
	}

	articleOrder := []string{}
	articlesByKey := map[string]graphRetrievalArticle{}
	addArticle := func(article graphRetrievalArticle) {
		key := article.Title
		if article.ArticleID != nil {
			key = *article.ArticleID
		}
		if existing, ok := articlesByKey[key]; ok {
			seen := map[string]bool{}
			for _, concept := range existing.ViaConcepts {
				seen[concept] = true
			}
			for _, concept := range article.ViaConcepts {
				if !seen[concept] {
					existing.ViaConcepts = append(existing.ViaConcepts, concept)
					seen[concept] = true
				}
			}
			articlesByKey[key] = existing
			return
		}
		articleOrder = append(articleOrder, key)
		articlesByKey[key] = article
	}
	for _, node := range nodes {
		if node.Kind == "article" && node.Hop == 0 {
			addArticle(graphRetrievalArticle{ArticleID: extractGraphArticleID(node.ID), Title: node.Label, Href: node.Route, ViaConcepts: []string{}})
		}
	}
	for _, path := range paths {
		if path.Article == nil {
			continue
		}
		article := *path.Article
		article.ViaConcepts = make([]string, 0, len(path.Nodes)-1)
		for _, node := range path.Nodes[:len(path.Nodes)-1] {
			article.ViaConcepts = append(article.ViaConcepts, node.Label)
		}
		addArticle(article)
	}
	articles := make([]graphRetrievalArticle, 0, len(articleOrder))
	for _, key := range articleOrder {
		articles = append(articles, articlesByKey[key])
	}
	return graphRetrievalResult{Query: query, Matched: matched, Nodes: nodes, Links: links, Paths: paths, Articles: articles}
}

func decodeGraphResult(output any) graphRetrievalResult {
	if result, ok := output.(graphRetrievalResult); ok {
		return result
	}
	raw, _ := json.Marshal(output)
	var result graphRetrievalResult
	_ = json.Unmarshal(raw, &result)
	return result
}

func graphNormalizer(kind string) rt.ToolNormalizer {
	return func(output any, _ any) rt.ToolNormalizerResult {
		result := decodeGraphResult(output)
		if len(result.Matched) == 0 {
			return rt.ToolNormalizerResult{
				Summary: "知识图谱中未命中相关实体", Data: mustJSON(map[string]any{"matched": []any{}, "articles": []any{}}),
				SuggestedActions: []string{"knowledge.search"}, Progress: boolPtr(false),
			}
		}
		paths := make([]map[string]any, 0, len(result.Paths))
		for i, path := range result.Paths {
			if i >= 8 {
				break
			}
			labels := make([]string, 0, len(path.Nodes))
			for _, node := range path.Nodes {
				labels = append(labels, node.Label)
			}
			paths = append(paths, map[string]any{"nodes": labels, "relations": path.Relations})
		}
		articles := make([]map[string]any, 0, len(result.Articles))
		for _, article := range result.Articles {
			articles = append(articles, map[string]any{"articleId": article.ArticleID, "title": article.Title, "viaConcepts": article.ViaConcepts})
		}
		matched := make([]map[string]any, 0, len(result.Matched))
		evidence := make([]rt.EvidenceInput, 0, minInt(len(result.Matched), 5))
		for i, item := range result.Matched {
			matched = append(matched, map[string]any{"id": item.ID, "label": item.Label, "kind": item.Kind})
			if i >= 5 {
				continue
			}
			content := item.Summary
			if content == "" {
				content = fmt.Sprintf("%s（%s）", item.Label, item.Kind)
			}
			metadata := map[string]any{"kind": item.Kind, "graphOp": kind}
			if item.Route != nil {
				metadata["route"] = *item.Route
			}
			evidence = append(evidence, rt.EvidenceInput{
				Source: rt.EvidenceGraph, Title: item.Label, Content: content, SourceID: item.ID,
				Relevance: floatPtr(0.6), Confidence: floatPtr(0.7), Metadata: metadata,
			})
		}
		actions := []string{"knowledge.search"}
		if len(result.Articles) > 0 {
			actions = []string{"knowledge.read"}
		}
		return rt.ToolNormalizerResult{
			Summary:          fmt.Sprintf("图谱命中 %d 个实体，关联 %d 篇文章", len(result.Matched), len(result.Articles)),
			Data:             mustJSON(map[string]any{"matched": matched, "paths": paths, "articles": articles}),
			SuggestedActions: actions, Evidence: evidence, Progress: boolPtr(true),
		}
	}
}

func normalizeGraphEntity(output any, _ any) rt.ToolNormalizerResult {
	raw, _ := json.Marshal(output)
	var record struct {
		Entity  string                `json:"entity"`
		Matched []graphRetrievalMatch `json:"matched"`
	}
	_ = json.Unmarshal(raw, &record)
	if len(record.Matched) == 0 {
		return rt.ToolNormalizerResult{Summary: fmt.Sprintf("图谱中没有找到实体「%s」", record.Entity), SuggestedActions: []string{"knowledge.search"}, Progress: boolPtr(false)}
	}
	top := record.Matched[0]
	content := top.Summary
	if content == "" {
		content = top.Label
	}
	return rt.ToolNormalizerResult{
		Summary: fmt.Sprintf("实体「%s」（%s）", top.Label, top.Kind), Data: mustJSON(map[string]any{"entity": top}),
		Evidence: []rt.EvidenceInput{{Source: rt.EvidenceGraph, Title: top.Label, Content: content, SourceID: top.ID, Relevance: floatPtr(0.7), Confidence: floatPtr(0.7), Metadata: map[string]any{"kind": top.Kind}}},
		Progress: boolPtr(true),
	}
}

func normalizeGraphRelations(output any, _ any) rt.ToolNormalizerResult {
	raw, _ := json.Marshal(output)
	var record struct {
		Entity string               `json:"entity"`
		Links  []graphRetrievalLink `json:"links"`
		Nodes  []graphRetrievalNode `json:"nodes"`
	}
	_ = json.Unmarshal(raw, &record)
	labels := map[string]string{}
	for _, node := range record.Nodes {
		labels[node.ID] = node.Label
	}
	relations := make([]map[string]any, 0, minInt(len(record.Links), 30))
	for i, link := range record.Links {
		if i >= 30 {
			break
		}
		from, to := labels[link.Source], labels[link.Target]
		if from == "" {
			from = link.Source
		}
		if to == "" {
			to = link.Target
		}
		relations = append(relations, map[string]any{"from": from, "to": to, "relation": link.Relation})
	}
	summary := fmt.Sprintf("实体「%s」有 %d 条关系", record.Entity, len(record.Links))
	progress := true
	if len(record.Links) == 0 {
		summary = fmt.Sprintf("实体「%s」没有可见的关系边", record.Entity)
		progress = false
	}
	return rt.ToolNormalizerResult{Summary: summary, Data: mustJSON(map[string]any{"relations": relations}), Progress: boolPtr(progress)}
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}
