// sitegraph_normalize.go 移植 src/server/site-graph/normalize.ts：
// 业务键归一化、文本钳制、草稿合并与收敛。
package adminpanel

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"regexp"
	"strings"
)

var (
	nodeKeySepPattern  = regexp.MustCompile(`[\s/\\#?&=]+`)
	nodeKeyKeepPattern = regexp.MustCompile(`[^a-z0-9一-龥._-]+`)
	dashRunPattern     = regexp.MustCompile(`-+`)
	edgeDashes         = regexp.MustCompile(`^-+|-+$`)
	whitespaceCollapse = regexp.MustCompile(`\s+`)
)

func sha256HexBytes(v string) string {
	sum := sha256.Sum256([]byte(v))
	return hex.EncodeToString(sum[:])
}

// NormalizeNodeKey 业务键归一化：小写、连字符化，保留中文；空串时用哈希兜底。
func NormalizeNodeKey(raw string) string {
	key := raw
	key = strings.TrimSpace(key)
	key = strings.ToLower(key)
	key = nodeKeySepPattern.ReplaceAllString(key, "-")
	key = nodeKeyKeepPattern.ReplaceAllString(key, "")
	key = dashRunPattern.ReplaceAllString(key, "-")
	key = strings.Trim(key, "-")
	if runeLen(key) > LimitNodeKeyLength {
		key = string([]rune(key)[:LimitNodeKeyLength])
	}
	if key == "" {
		return "node-" + sha256HexBytes(raw)[:12]
	}
	return key
}

// BuildArticleNodeKey 文章节点键。
func BuildArticleNodeKey(articleID string) string {
	return "article-" + strings.TrimSpace(articleID)
}

// BuildSectionNodeKey 分类节点键。
func BuildSectionNodeKey(name string) string {
	return NormalizeNodeKey("section-" + name)
}

// BuildTagNodeKey 标签节点键。
func BuildTagNodeKey(tag string) string {
	return NormalizeNodeKey("tag-" + tag)
}

// BuildManualNodeKey 后台手工新增节点的键。
func BuildManualNodeKey(name, kind string) string {
	return NormalizeNodeKey(kind + "-" + name)
}

// NormalizeNodeKind 非法类型回退 concept。
func NormalizeNodeKind(raw any) string {
	value := strings.ToLower(strings.TrimSpace(toStringValue(raw)))
	if inList(SiteGraphNodeKinds, value) {
		return value
	}
	return NodeKindConcept
}

// NormalizeEdgeKind 非法类型回退 reference。
func NormalizeEdgeKind(raw any) string {
	value := strings.ToLower(strings.TrimSpace(toStringValue(raw)))
	if inList(SiteGraphEdgeKinds, value) {
		return value
	}
	return "reference"
}

// NormalizeSource 非法来源回退 AGENT。
func NormalizeSource(raw any) string {
	value := strings.ToUpper(strings.TrimSpace(toStringValue(raw)))
	if value == "MANUAL" || value == "SYSTEM" {
		return value
	}
	return "AGENT"
}

// clampText 折叠空白、裁剪首尾并按 rune 截断。
func clampText(raw any, maxLength int) string {
	text := whitespaceCollapse.ReplaceAllString(toStringValue(raw), " ")
	text = strings.TrimSpace(text)
	if runeLen(text) > maxLength {
		text = string([]rune(text)[:maxLength])
	}
	return text
}

// ClampConfidence 置信度钳制到 0~100，非数回退 80。
func ClampConfidence(raw any) int {
	value := toFloatValue(raw)
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 80
	}
	clamped := int(math.Round(value))
	if clamped < 0 {
		return 0
	}
	if clamped > 100 {
		return 100
	}
	return clamped
}

// ClampWeight 权重钳制到 1~100，非数回退 1。
func ClampWeight(raw any) int {
	value := toFloatValue(raw)
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 1
	}
	clamped := int(math.Round(value))
	if clamped < 1 {
		return 1
	}
	if clamped > 100 {
		return 100
	}
	return clamped
}

// normalizeAttributes 属性归一化：去空、按名去重、截断、限量。
func normalizeAttributes(raw any) []Attribute {
	items, ok := raw.([]any)
	if !ok {
		return []Attribute{}
	}
	seen := map[string]struct{}{}
	attributes := []Attribute{}
	for _, item := range items {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name := clampText(orValue(record["name"], record["key"]), LimitAttrNameLength)
		value := clampText(record["value"], LimitAttrValueLength)
		if name == "" || value == "" {
			continue
		}
		dedupeKey := strings.ToLower(name)
		if _, dup := seen[dedupeKey]; dup {
			continue
		}
		seen[dedupeKey] = struct{}{}
		attributes = append(attributes, Attribute{Name: name, Value: value})
		if len(attributes) >= LimitAttributesPerItem {
			break
		}
	}
	return attributes
}

// normalizeAliases 别名归一化：去空、去重（小写比较）、截断、限量。
func normalizeAliases(raw any) []string {
	items, ok := raw.([]any)
	if !ok {
		return []string{}
	}
	seen := map[string]struct{}{}
	aliases := []string{}
	for _, item := range items {
		alias := clampText(item, LimitAliasLength)
		if alias == "" {
			continue
		}
		dedupeKey := strings.ToLower(alias)
		if _, dup := seen[dedupeKey]; dup {
			continue
		}
		seen[dedupeKey] = struct{}{}
		aliases = append(aliases, alias)
		if len(aliases) >= LimitAliasesPerNode {
			break
		}
	}
	return aliases
}

// NormalizeAliases 导出版本（合并流程复用）。
func NormalizeAliases(raw any) []string { return normalizeAliases(raw) }

// NormalizeAttributes 导出版本（保存节点/关系时复用）。
func NormalizeAttributes(raw any) []Attribute { return normalizeAttributes(raw) }

// normalizeRoute 只允许站内路径，避免 Agent 编造外链。
func normalizeRoute(raw any) *string {
	value := strings.TrimSpace(toStringValue(raw))
	if value == "" || !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") {
		return nil
	}
	if runeLen(value) > 300 {
		value = string([]rune(value)[:300])
	}
	return &value
}

func strPtrOrNil(raw any) *string {
	s, ok := raw.(string)
	if !ok {
		return nil
	}
	return &s
}

func digitsOnly(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// normalizeDraftNode 把模型输出的单个节点收敛成草稿；无名称返回 nil。
func normalizeDraftNode(raw map[string]any) *DraftNode {
	name := clampText(orValue(raw["name"], raw["label"]), LimitNameLength)
	if name == "" {
		return nil
	}

	nodeKey := NormalizeNodeKey(toStringValue(orValue3(raw["nodeKey"], raw["key"], name)))
	var parentKey *string
	parentRaw := orValue(raw["parentKey"], raw["parent"])
	parentStr := strings.TrimSpace(toStringValue(parentRaw))
	if parentRaw != nil && parentStr != "" {
		normalized := NormalizeNodeKey(parentStr)
		if normalized != nodeKey {
			parentKey = &normalized
		}
	}
	articleIDRaw := strings.TrimSpace(toStringValue(raw["articleId"]))
	var articleID *string
	if digitsOnly(articleIDRaw) {
		articleID = &articleIDRaw
	}

	return &DraftNode{
		NodeKey:    nodeKey,
		ParentKey:  parentKey,
		Kind:       NormalizeNodeKind(orValue(raw["kind"], raw["type"])),
		Name:       name,
		Summary:    clampText(orValue(raw["summary"], raw["description"]), LimitSummaryLength),
		Route:      normalizeRoute(orValue(raw["route"], raw["href"])),
		ArticleID:  articleID,
		Attributes: normalizeAttributes(raw["attributes"]),
		Aliases:    normalizeAliases(raw["aliases"]),
		Weight:     ClampWeight(orValueDefault(raw["weight"], float64(1))),
		Confidence: ClampConfidence(orValueDefault(raw["confidence"], float64(80))),
		Source:     NormalizeSource(raw["source"]),
	}
}

func normalizeDraftEdgeValue(raw map[string]any) *DraftEdge {
	hasFrom := raw["fromKey"] != nil || raw["from"] != nil || raw["source"] != nil
	hasTo := raw["toKey"] != nil || raw["to"] != nil || raw["target"] != nil
	relation := clampText(orValue(raw["relation"], raw["label"]), LimitRelationLength)
	fromKey := NormalizeNodeKey(toStringValue(orValue3(raw["fromKey"], raw["from"], raw["source"])))
	toKey := NormalizeNodeKey(toStringValue(orValue3(raw["toKey"], raw["to"], raw["target"])))
	if !hasFrom || !hasTo || relation == "" || fromKey == toKey {
		return nil
	}
	directed := true
	if v, ok := raw["directed"]; ok && v != nil {
		directed = toBoolValue(v)
	}
	return &DraftEdge{
		FromKey:    fromKey,
		ToKey:      toKey,
		Relation:   relation,
		Kind:       NormalizeEdgeKind(orValue(raw["kind"], raw["type"])),
		Attributes: normalizeAttributes(raw["attributes"]),
		Weight:     ClampWeight(orValueDefault(raw["weight"], float64(1))),
		Directed:   directed,
		Confidence: ClampConfidence(orValueDefault(raw["confidence"], float64(80))),
		Source:     NormalizeSource(raw["source"]),
	}
}

func isStructuralKind(kind string) bool {
	return kind == NodeKindRoot || kind == NodeKindSection || kind == NodeKindArticle
}

// mergeDraftNodes 合并同一 nodeKey 的重复节点：结构信息保留先出现者，
// 属性别名取并集，权重累加、置信度取高。
func mergeDraftNodes(nodes []DraftNode) []DraftNode {
	merged := make(map[string]*DraftNode, len(nodes))
	order := make([]string, 0, len(nodes))
	for i := range nodes {
		node := nodes[i]
		existing, ok := merged[node.NodeKey]
		if !ok {
			copied := node
			merged[node.NodeKey] = &copied
			order = append(order, node.NodeKey)
			continue
		}
		if isStructuralKind(existing.Kind) {
			// 结构骨架优先级高于 Agent 抽取的概念节点
		} else {
			existing.Kind = node.Kind
		}
		if existing.Summary == "" {
			existing.Summary = node.Summary
		}
		if existing.Route == nil {
			existing.Route = node.Route
		}
		if existing.ArticleID == nil {
			existing.ArticleID = node.ArticleID
		}
		if existing.ParentKey == nil {
			existing.ParentKey = node.ParentKey
		}
		existing.Attributes = normalizeAttributes(appendAny(attributesToAny(existing.Attributes), attributesToAny(node.Attributes)...))
		aliasRaw := make([]any, 0, len(existing.Aliases)+len(node.Aliases))
		for _, a := range existing.Aliases {
			aliasRaw = append(aliasRaw, a)
		}
		for _, a := range node.Aliases {
			aliasRaw = append(aliasRaw, a)
		}
		existing.Aliases = normalizeAliases(aliasRaw)
		existing.Weight = ClampWeight(float64(existing.Weight + node.Weight))
		if node.Confidence > existing.Confidence {
			existing.Confidence = node.Confidence
		}
		if existing.Source == "MANUAL" || node.Source == "MANUAL" {
			existing.Source = "MANUAL"
		}
	}
	result := make([]DraftNode, 0, len(order))
	for _, key := range order {
		result = append(result, *merged[key])
	}
	return result
}

func attributesToAny(items []Attribute) []any {
	raw := make([]any, 0, len(items))
	for _, item := range items {
		raw = append(raw, map[string]any{"name": item.Name, "value": item.Value})
	}
	return raw
}

// mergeDraftEdges 合并重复关系（同 from/to/relation 小写），权重累加、置信度取高。
func mergeDraftEdges(edges []DraftEdge) []DraftEdge {
	type entry struct {
		edge DraftEdge
	}
	merged := make(map[string]*entry)
	order := make([]string, 0)
	for _, edge := range edges {
		dedupeKey := edge.FromKey + " " + edge.ToKey + " " + strings.ToLower(edge.Relation)
		existing, ok := merged[dedupeKey]
		if !ok {
			merged[dedupeKey] = &entry{edge: edge}
			order = append(order, dedupeKey)
			continue
		}
		e := existing.edge
		e.Attributes = normalizeAttributes(appendAny(attributesToAny(e.Attributes), attributesToAny(edge.Attributes)...))
		e.Weight = ClampWeight(float64(e.Weight + edge.Weight))
		if edge.Confidence > e.Confidence {
			e.Confidence = edge.Confidence
		}
		e.Directed = e.Directed && edge.Directed
		existing.edge = e
	}
	result := make([]DraftEdge, 0, len(order))
	for _, key := range order {
		result = append(result, merged[key].edge)
	}
	return result
}

// ConsolidateDraft 草稿整体收敛：合并重复、丢弃悬空引用、按上限截断。
func ConsolidateDraft(draft Draft) Draft {
	nodes := mergeDraftNodes(draft.Nodes)
	if len(nodes) > LimitMaxNodes {
		nodes = nodes[:LimitMaxNodes]
	}
	nodeKeys := make(map[string]struct{}, len(nodes))
	for _, node := range nodes {
		nodeKeys[node.NodeKey] = struct{}{}
	}
	for i := range nodes {
		if nodes[i].ParentKey != nil {
			if _, ok := nodeKeys[*nodes[i].ParentKey]; !ok {
				nodes[i].ParentKey = nil
			}
		}
	}

	edges := mergeDraftEdges(draft.Edges)
	filtered := edges[:0]
	for _, edge := range edges {
		_, fromOK := nodeKeys[edge.FromKey]
		_, toOK := nodeKeys[edge.ToKey]
		if fromOK && toOK {
			filtered = append(filtered, edge)
		}
	}
	if len(filtered) > LimitMaxEdges {
		filtered = filtered[:LimitMaxEdges]
	}
	return Draft{Nodes: nodes, Edges: filtered}
}
