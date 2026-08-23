// sitegraph_service.go 移植 src/server/site-graph/service.ts + extract-agent.ts：
// 生成主流程（骨架 + 注入式 LLM 抽取）、校验、发布流转与图查询编排。
package adminpanel

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"petrichor/api/internal/cache"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

// SiteGraphGenerator LLM 抽取函数注入点：
// input 携带本批文章、已知实体清单与提示词；output 期望 {"nodes":[...],"edges":[...]}，
// 可选返回 "modelName"。为 nil 时生成接口返回 503「AI 服务未就绪」。
type SiteGraphGenerator func(ctx context.Context, input map[string]any) (map[string]any, error)

// SiteGraphGeneratorFn 由上层（AI 接入层或测试）注入。
var SiteGraphGeneratorFn SiteGraphGenerator

const (
	// ConceptSectionKey / TagSectionKey 固定顶层分类键。
	siteGraphBatchSize     = 5
	articleContentLimit    = 2600
	knownEntityPromptLimit = 60
)

func conceptSectionKey() string { return BuildSectionNodeKey("概念") }
func tagSectionKey() string     { return BuildSectionNodeKey("标签") }

// buildSkeletonDraft 确定性结构骨架：root → 分类 → 文章（+ 标签/概念分类）。
func buildSkeletonDraft(articles []ArticleInput) Draft {
	nodes := []DraftNode{{
		NodeKey:    RootKey,
		ParentKey:  nil,
		Kind:       NodeKindRoot,
		Name:       "全站星图",
		Summary:    "站点全部公开内容的星图根节点",
		Route:      strPtrOrNil("/"),
		ArticleID:  nil,
		Attributes: []Attribute{{Name: "文章数", Value: strconv.Itoa(len(articles))}},
		Aliases:    []string{},
		Weight:     10,
		Confidence: 100,
		Source:     "SYSTEM",
	}}
	edges := []DraftEdge{}
	sectionSeen := map[string]struct{}{}
	tagSeen := map[string]struct{}{}
	hasTag := false
	rootKey := RootKey

	for _, article := range articles {
		sectionName := strings.TrimSpace(article.KnowledgeBaseName)
		if sectionName == "" {
			sectionName = "未分类"
		}
		sectionKey := BuildSectionNodeKey(sectionName)
		if _, seen := sectionSeen[sectionKey]; !seen {
			sectionSeen[sectionKey] = struct{}{}
			key := rootKey
			nodes = append(nodes, DraftNode{
				NodeKey:    sectionKey,
				ParentKey:  &key,
				Kind:       NodeKindSection,
				Name:       sectionName,
				Summary:    "分类：" + sectionName,
				Route:      nil,
				ArticleID:  nil,
				Attributes: []Attribute{},
				Aliases:    []string{},
				Weight:     4,
				Confidence: 100,
				Source:     "SYSTEM",
			})
		}

		attributes := []Attribute{
			{Name: "分类", Value: sectionName},
			{Name: "更新时间", Value: article.UpdatedAt[:10]},
		}
		if len(article.Tags) > 0 {
			tags := article.Tags
			if len(tags) > 5 {
				tags = tags[:5]
			}
			attributes = append(attributes, Attribute{Name: "标签", Value: strings.Join(tags, "、")})
		}
		articleKey := BuildArticleNodeKey(article.ArticleID)
		parent := sectionKey
		nodes = append(nodes, DraftNode{
			NodeKey:    articleKey,
			ParentKey:  &parent,
			Kind:       NodeKindArticle,
			Name:       article.Title,
			Summary:    article.Excerpt,
			Route:      strPtrOrNil(article.Route),
			ArticleID:  strPtrOrNil(article.ArticleID),
			Attributes: attributes,
			Aliases:    []string{},
			Weight:     2,
			Confidence: 100,
			Source:     "SYSTEM",
		})

		tags := article.Tags
		if len(tags) > 5 {
			tags = tags[:5]
		}
		for _, tag := range tags {
			tagKey := BuildTagNodeKey(tag)
			if _, seen := tagSeen[tagKey]; !seen {
				tagSeen[tagKey] = struct{}{}
				hasTag = true
				tagParent := tagSectionKey()
				route := "/tags?tag=" + urlQueryEscape(tag)
				nodes = append(nodes, DraftNode{
					NodeKey:    tagKey,
					ParentKey:  &tagParent,
					Kind:       NodeKindTag,
					Name:       tag,
					Summary:    "标签：" + tag,
					Route:      &route,
					ArticleID:  nil,
					Attributes: []Attribute{},
					Aliases:    []string{},
					Weight:     1,
					Confidence: 100,
					Source:     "SYSTEM",
				})
			}
			edges = append(edges, DraftEdge{
				FromKey:    articleKey,
				ToKey:      tagKey,
				Relation:   "标注",
				Kind:       "reference",
				Attributes: []Attribute{},
				Weight:     1,
				Directed:   true,
				Confidence: 100,
				Source:     "SYSTEM",
			})
		}
	}

	conceptParent := RootKey
	nodes = append(nodes, DraftNode{
		NodeKey:    conceptSectionKey(),
		ParentKey:  &conceptParent,
		Kind:       NodeKindSection,
		Name:       "概念",
		Summary:    "由抽取 Agent 从公开文章中归纳出的概念与实体",
		Route:      nil,
		ArticleID:  nil,
		Attributes: []Attribute{},
		Aliases:    []string{},
		Weight:     4,
		Confidence: 100,
		Source:     "SYSTEM",
	})

	if hasTag {
		tagRootParent := RootKey
		route := "/tags"
		nodes = append(nodes, DraftNode{
			NodeKey:    tagSectionKey(),
			ParentKey:  &tagRootParent,
			Kind:       NodeKindSection,
			Name:       "标签",
			Summary:    "文章标签",
			Route:      &route,
			ArticleID:  nil,
			Attributes: []Attribute{},
			Aliases:    []string{},
			Weight:     4,
			Confidence: 100,
			Source:     "SYSTEM",
		})
	}

	return Draft{Nodes: nodes, Edges: edges}
}

// chunkArticles 分批：每批最多 batchSize 篇文章。
func chunkArticles(articles []ArticleInput, size int) [][]ArticleInput {
	if size < 1 {
		size = 1
	}
	batches := [][]ArticleInput{}
	for start := 0; start < len(articles); start += size {
		end := start + size
		if end > len(articles) {
			end = len(articles)
		}
		batches = append(batches, articles[start:end])
	}
	return batches
}

// parseExtractionResult 解析单批模型输出并做幻觉拦截。
func parseExtractionResult(output map[string]any, articleKeys map[string]struct{}) ([]DraftNode, []DraftEdge, []string) {
	warnings := []string{}
	rawNodes, _ := output["nodes"].([]any)
	rawEdges, _ := output["edges"].([]any)

	nodes := []DraftNode{}
	for _, raw := range rawNodes {
		record, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		node := normalizeDraftNode(record)
		if node == nil {
			continue
		}
		// 文章/分类节点由系统骨架负责，模型回写的直接忽略
		if node.Kind != NodeKindConcept && node.Kind != NodeKindEntity {
			continue
		}
		parent := conceptSectionKey()
		node.ParentKey = &parent
		node.Route = nil
		node.ArticleID = nil
		node.Source = "AGENT"
		nodes = append(nodes, *node)
	}

	knownKeys := map[string]struct{}{}
	for key := range articleKeys {
		knownKeys[key] = struct{}{}
	}
	for i := range nodes {
		knownKeys[nodes[i].NodeKey] = struct{}{}
	}

	edges := []DraftEdge{}
	droppedEdges := 0
	for _, raw := range rawEdges {
		record, ok := raw.(map[string]any)
		if !ok {
			droppedEdges++
			continue
		}
		edge := normalizeDraftEdgeValue(record)
		if edge == nil {
			droppedEdges++
			continue
		}
		_, fromOK := knownKeys[edge.FromKey]
		_, toOK := knownKeys[edge.ToKey]
		if !fromOK || !toOK {
			droppedEdges++
			continue
		}
		edge.Source = "AGENT"
		edges = append(edges, *edge)
	}

	if droppedEdges > 0 {
		warnings = append(warnings, fmt.Sprintf("本批丢弃 %d 条指向未知节点的关系", droppedEdges))
	}
	return nodes, edges, warnings
}

// alignNodesWithRegistry 把一批新抽取的概念/实体对齐到注册表。
func alignNodesWithRegistry(parsedNodes []DraftNode, registry *SiteGraphEntityRegistry) ([]DraftNode, map[string]string, int) {
	nodes := []DraftNode{}
	keyRewrites := map[string]string{}
	autoAlignedCount := 0

	for _, node := range parsedNodes {
		if !isAlignableKind(node.Kind) {
			nodes = append(nodes, node)
			continue
		}

		resolved := registry.resolve(&node)
		if resolved.match != matchNone && resolved.canonicalKey != node.NodeKey {
			autoAlignedCount++
			keyRewrites[node.NodeKey] = resolved.canonicalKey
		}

		canonicalNode := node
		canonicalNode.NodeKey = resolved.canonicalKey
		if canonicalNode.NodeKey == node.NodeKey {
			canonicalNode.Aliases = node.Aliases
		} else {
			// 原名在被改写时降级成别名，保留同义写法供下次匹配
			canonicalNode.Aliases = append(append([]string{}, node.Aliases...), node.Name)
		}
		nodes = append(nodes, canonicalNode)

		entry := EntityRegistryEntry{
			CanonicalKey: canonicalNode.NodeKey,
			Name:         canonicalNode.Name,
			Aliases:      canonicalNode.Aliases,
			Kind:         canonicalNode.Kind,
			Weight:       int32(canonicalNode.Weight),
		}
		registry.register(&entry)
	}

	return nodes, keyRewrites, autoAlignedCount
}

// rewriteEdgeKeys 关系两端引用被改写键时同步重写。
func rewriteEdgeKeys(edges []DraftEdge, keyRewrites map[string]string) []DraftEdge {
	if len(keyRewrites) == 0 {
		return edges
	}
	result := make([]DraftEdge, 0, len(edges))
	for _, edge := range edges {
		next := edge
		if rewritten, ok := keyRewrites[edge.FromKey]; ok {
			next.FromKey = rewritten
		}
		if rewritten, ok := keyRewrites[edge.ToKey]; ok {
			next.ToKey = rewritten
		}
		if next.FromKey != next.ToKey {
			result = append(result, next)
		}
	}
	return result
}

// ensureConceptSectionUsed 没有任何概念节点时移除空的「概念」分类。
func ensureConceptSectionUsed(draft *Draft) {
	for i := range draft.Nodes {
		if draft.Nodes[i].ParentKey != nil && *draft.Nodes[i].ParentKey == conceptSectionKey() {
			return
		}
	}
	for i := range draft.Nodes {
		if draft.Nodes[i].NodeKey == conceptSectionKey() {
			draft.Nodes = append(draft.Nodes[:i], draft.Nodes[i+1:]...)
			return
		}
	}
}

type extractionResult struct {
	draft            Draft
	warnings         []string
	modelName        *string
	mergeCandidates  []*MergeCandidate
	autoAlignedCount int
}

// runSiteGraphExtraction 抽取 Agent 主流程：确定性骨架 + 分批模型抽取，逐批容错。
func runSiteGraphExtraction(ctx context.Context, userID int64, articles []ArticleInput,
	modelRefID *int64, existingEntities []EntityRegistryEntry) (*extractionResult, error) {

	generator := SiteGraphGeneratorFn
	if generator == nil {
		return nil, &httpx.HttpError{Status: http.StatusServiceUnavailable, Message: "AI 服务未就绪"}
	}

	skeleton := buildSkeletonDraft(articles)
	warnings := []string{}
	nodes := append([]DraftNode{}, skeleton.Nodes...)
	edges := append([]DraftEdge{}, skeleton.Edges...)
	var modelName *string
	autoAlignedCount := 0

	registry := NewSiteGraphEntityRegistry(existingEntities)

	batches := chunkArticles(articles, siteGraphBatchSize)
	for index, batch := range batches {
		articleKeys := make(map[string]struct{}, len(batch))
		articleKeyList := make([]string, 0, len(batch))
		batchPayload := make([]any, 0, len(batch))
		for _, article := range batch {
			key := BuildArticleNodeKey(article.ArticleID)
			articleKeys[key] = struct{}{}
			articleKeyList = append(articleKeyList, key)
			content := article.ContentMd
			if runeLen(content) > articleContentLimit {
				content = string([]rune(content)[:articleContentLimit]) + "\n[内容已截断]"
			}
			batchPayload = append(batchPayload, map[string]any{
				"articleId":         article.ArticleID,
				"title":             article.Title,
				"route":             article.Route,
				"excerpt":           article.Excerpt,
				"tags":              article.Tags,
				"contentMd":         content,
				"updatedAt":         article.UpdatedAt,
				"knowledgeBaseName": article.KnowledgeBaseName,
				"nodeKey":           key,
			})
		}

		topEntries := registry.topEntries(knownEntityPromptLimit)
		input := map[string]any{
			"userId":        userID,
			"modelRefId":    modelRefID,
			"batchIndex":    index,
			"articles":      batchPayload,
			"articleKeys":   articleKeyList,
			"knownEntities": topEntries,
		}

		output, err := generator(ctx, input)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("第 %d 批抽取失败：%s", index+1, err.Error()))
			continue
		}
		if name := strings.TrimSpace(toStringValue(output["modelName"])); name != "" && modelName == nil {
			modelName = &name
		}

		parsedNodes, parsedEdges, parsedWarnings := parseExtractionResult(output, articleKeys)
		alignedNodes, keyRewrites, alignedCount := alignNodesWithRegistry(parsedNodes, registry)
		autoAlignedCount += alignedCount
		nodes = append(nodes, alignedNodes...)
		edges = append(edges, rewriteEdgeKeys(parsedEdges, keyRewrites)...)
		for _, warning := range parsedWarnings {
			warnings = append(warnings, fmt.Sprintf("第 %d 批：%s", index+1, warning))
		}
	}

	draft := ConsolidateDraft(Draft{Nodes: nodes, Edges: edges})
	ensureConceptSectionUsed(&draft)

	mergeCandidates := []*MergeCandidate{}
	for _, candidate := range registry.mergeCandidates() {
		if candidate.SourceKey != candidate.TargetKey {
			mergeCandidates = append(mergeCandidates, candidate)
		}
	}

	uniqueWarnings := []string{}
	seenWarnings := map[string]struct{}{}

	for _, warning := range warnings {
		if _, dup := seenWarnings[warning]; dup {
			continue
		}
		seenWarnings[warning] = struct{}{}
		uniqueWarnings = append(uniqueWarnings, warning)
		if len(uniqueWarnings) >= 20 {
			break
		}
	}

	return &extractionResult{
		draft:            draft,
		warnings:         uniqueWarnings,
		modelName:        modelName,
		mergeCandidates:  mergeCandidates,
		autoAlignedCount: autoAlignedCount,
	}, nil
}

// GenerateSiteGraph 生成主流程：公开文章 → 抽取 → 校验 → 落库（草稿态）。
func GenerateSiteGraph(ctx context.Context, userID int64, modelRefID *int64, mode string) (*GenerateResult, error) {
	if mode == "" {
		mode = "FULL"
	}
	if SiteGraphGeneratorFn == nil {
		return nil, &httpx.HttpError{Status: http.StatusServiceUnavailable, Message: "AI 服务未就绪"}
	}
	if err := FailStaleRuns(ctx, userID); err != nil {
		return nil, err
	}

	articles, err := LoadPublicArticleInputs(ctx)
	if err != nil {
		return nil, err
	}
	if len(articles) == 0 {
		return nil, httpx.BadRequest("当前没有可用于生成图谱的公开文章，请先公开分享至少一篇文章")
	}

	run, err := CreateRun(ctx, userID, mode)
	if err != nil {
		return nil, err
	}

	existingEntities, err := LoadEntityRegistryEntries(ctx, userID)
	if err != nil {
		_ = FinishRun(ctx, run.ID, userID, "FAILED", nil, len(articles), 0, 0, nil, nil, strPtrOrNil(err.Error()))
		return nil, err
	}

	extraction, err := runSiteGraphExtraction(ctx, userID, articles, modelRefID, existingEntities)
	if err != nil {
		msg := err.Error()
		_ = FinishRun(ctx, run.ID, userID, "FAILED", nil, len(articles), 0, 0, nil, nil, &msg)
		return nil, err
	}

	publicArticleIds, err := LoadPublicArticleIDSet(ctx)
	if err != nil {
		msg := err.Error()
		_ = FinishRun(ctx, run.ID, userID, "FAILED", nil, len(articles), 0, 0, nil, nil, &msg)
		return nil, err
	}
	validation := ValidateSiteGraphDraft(extraction.draft, validateOptions{publicArticleIDs: publicArticleIds})

	persisted, err := PersistDraft(ctx, userID, extraction.draft)
	if err != nil {
		msg := err.Error()
		_ = FinishRun(ctx, run.ID, userID, "FAILED", nil, len(articles), 0, 0, nil, nil, &msg)
		return nil, err
	}

	insertedCandidates, err := SaveMergeCandidates(ctx, userID, extraction.mergeCandidates)
	if err != nil {
		msg := err.Error()
		_ = FinishRun(ctx, run.ID, userID, "FAILED", nil, len(articles), 0, 0, nil, nil, &msg)
		return nil, err
	}
	if err := PruneStaleMergeCandidates(ctx, userID); err != nil {
		msg := err.Error()
		_ = FinishRun(ctx, run.ID, userID, "FAILED", nil, len(articles), 0, 0, nil, nil, &msg)
		return nil, err
	}

	if err := FinishRun(ctx, run.ID, userID, "COMPLETED", extraction.modelName, len(articles),
		persisted.nodeCount, persisted.edgeCount, &validation, extraction.warnings, nil); err != nil {
		return nil, err
	}

	invalidatePublicSiteGraphCache()

	return &GenerateResult{
		RunID:               strconv.FormatInt(run.ID, 10),
		Validation:          validation,
		Warnings:            extraction.warnings,
		ArticleCount:        len(articles),
		NodeCount:           persisted.nodeCount,
		EdgeCount:           persisted.edgeCount,
		LockedSkipped:       persisted.lockedSkipped,
		AutoAlignedCount:    extraction.autoAlignedCount,
		MergeCandidateCount: insertedCandidates,
		Summary:             SummarizeValidationReport(validation),
	}, nil
}

// RevalidateSiteGraph 对库里现有图谱重跑校验。
func RevalidateSiteGraph(ctx context.Context, userID int64) (ValidationReport, string, error) {
	draft, err := LoadStoredDraft(ctx, userID, false)
	if err != nil {
		return ValidationReport{}, "", err
	}
	publicArticleIds, err := LoadPublicArticleIDSet(ctx)
	if err != nil {
		return ValidationReport{}, "", err
	}
	validation := ValidateSiteGraphDraft(draft, validateOptions{publicArticleIDs: publicArticleIds})
	return validation, SummarizeValidationReport(validation), nil
}

// LoadSiteGraphOverview 后台总览。
func LoadSiteGraphOverview(ctx context.Context, userID int64) (map[string]any, error) {
	if err := FailStaleRuns(ctx, userID); err != nil {
		return nil, err
	}
	if err := PruneStaleMergeCandidates(ctx, userID); err != nil {
		return nil, err
	}

	graph, err := LoadAdminGraph(ctx, userID)
	if err != nil {
		return nil, err
	}
	runs, err := ListRuns(ctx, userID, 10)
	if err != nil {
		return nil, err
	}
	options, err := ListNodeOptions(ctx, userID)
	if err != nil {
		return nil, err
	}
	validation, _, err := RevalidateSiteGraph(ctx, userID)
	if err != nil {
		return nil, err
	}
	mergeCandidates, err := ListMergeCandidates(ctx, userID, 100)
	if err != nil {
		return nil, err
	}

	stats := map[string]any{
		"nodeCount":   len(graph.Nodes),
		"edgeCount":   len(graph.Edges),
		"lockedNodes": 0,
		"manualNodes": 0,
	}
	publishedNodes := 0
	draftNodes := 0
	lockedNodes := 0
	manualNodes := 0
	articleNodes := 0
	conceptNodes := 0
	for _, node := range graph.Nodes {
		switch node.Status {
		case "PUBLISHED":
			publishedNodes++
		case "DRAFT":
			draftNodes++
		}
		if node.Locked {
			lockedNodes++
		}
		if node.Source == "MANUAL" {
			manualNodes++
		}
		if node.Kind == NodeKindArticle {
			articleNodes++
		}
		if node.Kind == NodeKindConcept || node.Kind == NodeKindEntity {
			conceptNodes++
		}
	}
	stats["publishedNodes"] = publishedNodes
	stats["draftNodes"] = draftNodes
	stats["lockedNodes"] = lockedNodes
	stats["manualNodes"] = manualNodes
	stats["articleNodes"] = articleNodes
	stats["conceptNodes"] = conceptNodes

	return map[string]any{
		"nodes":           graph.Nodes,
		"edges":           graph.Edges,
		"runs":            runs,
		"nodeOptions":     options,
		"validation":      validation,
		"mergeCandidates": mergeCandidates,
		"stats":           stats,
	}, nil
}

// PublishSiteGraph 发布前先归档下架文章节点，校验不过则拒绝发布。
func PublishSiteGraph(ctx context.Context, userID int64) (map[string]any, error) {
	archived, err := ArchiveStaleArticleNodes(ctx, userID)
	if err != nil {
		return nil, err
	}
	validation, _, err := RevalidateSiteGraph(ctx, userID)
	if err != nil {
		return nil, err
	}
	if !validation.Passed {
		return nil, httpx.BadRequest(SummarizeValidationReport(validation) + "，请先在下方修复错误项")
	}
	result, err := PublishGraph(ctx, userID)
	if err != nil {
		return nil, err
	}
	invalidatePublicSiteGraphCache()
	result["archivedStaleNodes"] = archived
	result["validation"] = validation
	return result, nil
}

// UnpublishSiteGraph 下线图谱。
func UnpublishSiteGraph(ctx context.Context, userID int64) (map[string]any, error) {
	result, err := UnpublishGraph(ctx, userID)
	if err != nil {
		return nil, err
	}
	invalidatePublicSiteGraphCache()
	return result, nil
}

// ClearSiteGraph 清空图谱。
func ClearSiteGraph(ctx context.Context, userID int64) (map[string]any, error) {
	result, err := ClearGraph(ctx, userID)
	if err != nil {
		return nil, err
	}
	invalidatePublicSiteGraphCache()
	return result, nil
}

// ConfirmMergeCandidate 人工确认合并后失效前台缓存。
func ConfirmMergeCandidate(ctx context.Context, userID, sourceNodeID, targetNodeID int64) (*MergeNodesResult, error) {
	result, err := MergeNodes(ctx, userID, sourceNodeID, targetNodeID)
	if err != nil {
		return nil, err
	}
	if err := PruneStaleMergeCandidates(ctx, userID); err != nil {
		return nil, err
	}
	invalidatePublicSiteGraphCache()
	return result, nil
}

// DismissMergeCandidate 忽略合并候选。
func DismissMergeCandidate(ctx context.Context, userID, candidateID int64) (map[string]any, error) {
	return IgnoreMergeCandidate(ctx, userID, candidateID)
}

// invalidatePublicSiteGraphCache 失效前台图谱缓存（Redis 键与 TS 一致）。
func invalidatePublicSiteGraphCache() {
	cache.Drop(cache.CacheKey("public", "site-graph"))
}

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
