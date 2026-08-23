// sitegraph_validate.go 移植 src/server/site-graph/validate.ts：纯函数图谱校验。
package adminpanel

import (
	"fmt"
	"strings"
	"time"
)

const defaultMinConfidence = 50

type validateOptions struct {
	// publicArticleIDs 当前允许出现在前台的文章 ID 集合，用于拦截私有文章。
	publicArticleIDs map[string]struct{}
	// minConfidence 低于该置信度只记 info。
	minConfidence int
}

func newStringSet(items []string) map[string]struct{} {
	set := make(map[string]struct{}, len(items))
	for _, item := range items {
		set[item] = struct{}{}
	}
	return set
}

// analyzeParentChains 沿 parentKey 向上走，标记成环节点并计算深度。
func analyzeParentChains(draft Draft, nodeByKey map[string]*DraftNode) (map[string]struct{}, map[string]int) {
	cycleKeys := map[string]struct{}{}
	depthByKey := map[string]int{}

	for i := range draft.Nodes {
		node := draft.Nodes[i]
		if _, done := depthByKey[node.NodeKey]; done {
			continue
		}
		var chain []string
		visiting := map[string]struct{}{}
		current := node.NodeKey
		baseDepth := -1

		for current != "" {
			if cached, ok := depthByKey[current]; ok {
				baseDepth = cached
				break
			}
			if _, looped := visiting[current]; looped {
				for _, key := range chain {
					cycleKeys[key] = struct{}{}
				}
				baseDepth = -1
				break
			}
			visiting[current] = struct{}{}
			chain = append(chain, current)
			var parentKey string
			if parent := nodeByKey[current]; parent != nil && parent.ParentKey != nil {
				parentKey = *parent.ParentKey
			}
			if parentKey == "" {
				current = ""
				continue
			}
			if _, exists := nodeByKey[parentKey]; !exists {
				current = ""
				continue
			}
			current = parentKey
		}

		depth := baseDepth + 1
		for j := len(chain) - 1; j >= 0; j-- {
			key := chain[j]
			if _, cycle := cycleKeys[key]; cycle {
				depthByKey[key] = 0
				continue
			}
			depthByKey[key] = depth
			depth++
		}
	}

	return cycleKeys, depthByKey
}

// ValidateSiteGraphDraft 图谱校验：抽取完成后、写库前必跑一次，后台可随时重跑。
func ValidateSiteGraphDraft(draft Draft, options validateOptions) ValidationReport {
	minConfidence := defaultMinConfidence
	if options.minConfidence > 0 {
		minConfidence = options.minConfidence
	}
	issues := []Issue{}

	nodeByKey := make(map[string]*DraftNode, len(draft.Nodes))
	duplicateKeys := map[string]struct{}{}
	for i := range draft.Nodes {
		node := draft.Nodes[i]
		if _, dup := nodeByKey[node.NodeKey]; dup {
			duplicateKeys[node.NodeKey] = struct{}{}
			continue
		}
		nodeByKey[node.NodeKey] = &draft.Nodes[i]
	}
	for key := range duplicateKeys {
		issues = append(issues, Issue{
			Severity: SeverityError,
			Code:     "duplicate_key",
			Target:   key,
			Message:  "存在重复的节点键，同一节点被定义了多次",
		})
	}

	if _, hasRoot := nodeByKey[RootKey]; !hasRoot {
		issues = append(issues, Issue{
			Severity: SeverityError,
			Code:     "missing_root",
			Target:   RootKey,
			Message:  "缺少根节点，前台点群无法建立层级",
		})
	}

	if len(draft.Nodes) > LimitMaxNodes {
		issues = append(issues, Issue{
			Severity: SeverityWarning,
			Code:     "oversized_graph",
			Target:   "graph",
			Message:  fmt.Sprintf("节点数 %d 超过上限 %d，前台渲染可能卡顿", len(draft.Nodes), LimitMaxNodes),
		})
	}
	if len(draft.Edges) > LimitMaxEdges {
		issues = append(issues, Issue{
			Severity: SeverityWarning,
			Code:     "oversized_graph",
			Target:   "graph",
			Message:  fmt.Sprintf("关系数 %d 超过上限 %d，前台渲染可能卡顿", len(draft.Edges), LimitMaxEdges),
		})
	}

	nameOwners := map[string][]string{}
	for i := range draft.Nodes {
		node := draft.Nodes[i]
		name := strings.TrimSpace(node.Name)
		if name == "" {
			issues = append(issues, Issue{Severity: SeverityError, Code: "empty_name", Target: node.NodeKey, Message: "节点名称为空"})
		}
		if node.Route != nil && (!strings.HasPrefix(*node.Route, "/") || strings.HasPrefix(*node.Route, "//")) {
			issues = append(issues, Issue{
				Severity: SeverityError,
				Code:     "external_route",
				Target:   node.NodeKey,
				Message:  fmt.Sprintf("节点链接 %s 不是站内路径", *node.Route),
			})
		}
		if node.ParentKey != nil {
			if _, ok := nodeByKey[*node.ParentKey]; !ok {
				issues = append(issues, Issue{
					Severity: SeverityError,
					Code:     "broken_parent",
					Target:   node.NodeKey,
					Message:  fmt.Sprintf("父节点 %s 不存在", *node.ParentKey),
				})
			}
		}
		if node.Kind == NodeKindArticle {
			if node.ArticleID == nil {
				issues = append(issues, Issue{
					Severity: SeverityError,
					Code:     "article_without_id",
					Target:   node.NodeKey,
					Message:  "文章节点缺少 articleId，无法与站内文章对应",
				})
			} else if options.publicArticleIDs != nil {
				if _, public := options.publicArticleIDs[*node.ArticleID]; !public {
					issues = append(issues, Issue{
						Severity: SeverityWarning,
						Code:     "private_article",
						Target:   node.NodeKey,
						Message: fmt.Sprintf("文章 %s 当前未公开，该节点不会出现在前台（发布时会自动归档）",
							*node.ArticleID),
					})
				}
			}
		}
		if (node.Kind == NodeKindConcept || node.Kind == NodeKindEntity) && len(node.Attributes) == 0 {
			issues = append(issues, Issue{
				Severity: SeverityInfo,
				Code:     "missing_attributes",
				Target:   node.NodeKey,
				Message:  "概念/实体节点没有任何属性，信息量偏低",
			})
		}
		if name == "" && node.Kind != NodeKindRoot {
			// 名称与摘要都缺失时补一条摘要告警（root 除外）
		}
		if strings.TrimSpace(node.Summary) == "" && node.Kind != NodeKindRoot {
			issues = append(issues, Issue{
				Severity: SeverityInfo,
				Code:     "missing_summary",
				Target:   node.NodeKey,
				Message:  "节点缺少摘要，前台悬停时无内容可展示",
			})
		}
		if node.Confidence < minConfidence {
			issues = append(issues, Issue{
				Severity: SeverityInfo,
				Code:     "low_confidence",
				Target:   node.NodeKey,
				Message:  fmt.Sprintf("节点置信度 %d 偏低，建议人工确认", node.Confidence),
			})
		}

		nameKey := strings.ToLower(name)
		if nameKey != "" {
			nameOwners[nameKey] = append(nameOwners[nameKey], node.NodeKey)
		}
	}

	// 保持输出稳定：按名称排序后遍历
	namesSorted := make([]string, 0, len(nameOwners))
	for name := range nameOwners {
		namesSorted = append(namesSorted, name)
	}
	sortStrings(namesSorted)
	for _, name := range namesSorted {
		keys := nameOwners[name]
		if len(keys) > 1 {
			issues = append(issues, Issue{
				Severity: SeverityInfo,
				Code:     "duplicate_name",
				Target:   strings.Join(keys, " / "),
				Message:  fmt.Sprintf("名称「%s」对应多个节点，可能需要合并", name),
			})
		}
	}

	cycleKeys, depthByKey := analyzeParentChains(draft, nodeByKey)
	cycleList := make([]string, 0, len(cycleKeys))
	for key := range cycleKeys {
		cycleList = append(cycleList, key)
	}
	sortStrings(cycleList)
	for _, key := range cycleList {
		issues = append(issues, Issue{
			Severity: SeverityError,
			Code:     "parent_cycle",
			Target:   key,
			Message:  "父子关系成环，层级无法展开",
		})
	}

	maxDepth := 0
	depthEntries := make([]string, 0, len(depthByKey))
	for key := range depthByKey {
		depthEntries = append(depthEntries, key)
	}
	sortStrings(depthEntries)
	for _, key := range depthEntries {
		depth := depthByKey[key]
		if depth > maxDepth {
			maxDepth = depth
		}
		if depth > LimitMaxDepth {
			issues = append(issues, Issue{
				Severity: SeverityWarning,
				Code:     "too_deep",
				Target:   key,
				Message:  fmt.Sprintf("节点层级 %d 超过上限 %d", depth, LimitMaxDepth),
			})
		}
	}

	connected := map[string]struct{}{}
	for _, edge := range draft.Edges {
		_, fromOK := nodeByKey[edge.FromKey]
		_, toOK := nodeByKey[edge.ToKey]
		target := edge.FromKey + " → " + edge.ToKey
		if !fromOK || !toOK {
			issues = append(issues, Issue{Severity: SeverityError, Code: "broken_edge", Target: target, Message: "关系端点指向不存在的节点"})
			continue
		}
		if edge.FromKey == edge.ToKey {
			issues = append(issues, Issue{Severity: SeverityError, Code: "self_edge", Target: edge.FromKey, Message: "关系指向自身"})
			continue
		}
		if strings.TrimSpace(edge.Relation) == "" {
			issues = append(issues, Issue{Severity: SeverityError, Code: "empty_relation", Target: target, Message: "关系缺少名称"})
		}
		if edge.Confidence < minConfidence {
			issues = append(issues, Issue{
				Severity: SeverityInfo,
				Code:     "low_confidence",
				Target:   target,
				Message:  fmt.Sprintf("关系置信度 %d 偏低，建议人工确认", edge.Confidence),
			})
		}
		connected[edge.FromKey] = struct{}{}
		connected[edge.ToKey] = struct{}{}
	}

	parents := map[string]struct{}{}
	for i := range draft.Nodes {
		if draft.Nodes[i].ParentKey != nil {
			parents[*draft.Nodes[i].ParentKey] = struct{}{}
		}
	}
	orphanCount := 0
	for i := range draft.Nodes {
		node := draft.Nodes[i]
		if node.NodeKey == RootKey {
			continue
		}
		hasParent := node.ParentKey != nil
		_, hasChild := parents[node.NodeKey]
		_, isConnected := connected[node.NodeKey]
		if hasParent || hasChild || isConnected {
			continue
		}
		orphanCount++
		if orphanCount <= 20 {
			issues = append(issues, Issue{
				Severity: SeverityWarning,
				Code:     "orphan_node",
				Target:   node.NodeKey,
				Message:  "孤立节点：既无父节点也无任何关系",
			})
		}
	}

	errorCount := 0
	warningCount := 0
	for _, issue := range issues {
		switch issue.Severity {
		case SeverityError:
			errorCount++
		case SeverityWarning:
			warningCount++
		}
	}
	score := 100 - errorCount*20 - warningCount*5
	if score < 0 {
		score = 0
	}
	if len(issues) > 200 {
		issues = issues[:200]
	}

	return ValidationReport{
		Score:       score,
		Passed:      errorCount == 0,
		NodeCount:   len(draft.Nodes),
		EdgeCount:   len(draft.Edges),
		OrphanCount: orphanCount,
		MaxDepth:    maxDepth,
		Issues:      issues,
		CheckedAt:   formatISO(time.Now()),
	}
}

// SummarizeValidationReport 把校验报告压成一句话。
func SummarizeValidationReport(report ValidationReport) string {
	errorCount := 0
	warningCount := 0
	for _, issue := range report.Issues {
		switch issue.Severity {
		case SeverityError:
			errorCount++
		case SeverityWarning:
			warningCount++
		}
	}
	if errorCount > 0 {
		return fmt.Sprintf("校验未通过：%d 个错误、%d 个警告（评分 %d）", errorCount, warningCount, report.Score)
	}
	if warningCount > 0 {
		return fmt.Sprintf("校验通过，但有 %d 个警告（评分 %d）", warningCount, report.Score)
	}
	return fmt.Sprintf("校验通过（评分 %d）", report.Score)
}
