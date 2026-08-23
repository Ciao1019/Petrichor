// sitegraph_types.go 全站星图共享类型，移植 src/server/site-graph/types.ts。
package adminpanel

import "encoding/json"

// 节点类型：root/section/article 是结构骨架，concept/entity/tag 由 Agent 抽取。
const (
	NodeKindRoot    = "root"
	NodeKindSection = "section"
	NodeKindArticle = "article"
	NodeKindConcept = "concept"
	NodeKindEntity  = "entity"
	NodeKindTag     = "tag"
)

// 关系/状态/来源枚举。
var SiteGraphNodeKinds = []string{NodeKindRoot, NodeKindSection, NodeKindArticle, NodeKindConcept, NodeKindEntity, NodeKindTag}
var SiteGraphEdgeKinds = []string{"reference", "semantic", "derived"}
var SiteGraphStatuses = []string{"DRAFT", "PUBLISHED", "ARCHIVED"}
var SiteGraphSources = []string{"AGENT", "MANUAL", "SYSTEM"}

// RootKey 根节点业务键。
const RootKey = "root"

// 图谱各类文本/集合上限。
const (
	LimitNodeKeyLength           = 120
	LimitNameLength              = 60
	LimitSummaryLength           = 200
	LimitRelationLength          = 20
	LimitAttrNameLength          = 20
	LimitAttrValueLength         = 80
	LimitAttributesPerItem       = 8
	LimitAliasLength             = 40
	LimitAliasesPerNode          = 6
	LimitMaxNodes                = 1200
	LimitMaxEdges                = 2400
	LimitMaxDepth                = 6
	StaleRunTimeoutMs      int64 = 30 * 60 * 1000
)

func inList(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}

// Attribute 节点/关系的结构化属性。
type Attribute struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// DraftNode 抽取阶段节点草稿：只用业务键互相引用，尚未分配数据库 ID。
type DraftNode struct {
	NodeKey    string      `json:"nodeKey"`
	ParentKey  *string     `json:"parentKey"`
	Kind       string      `json:"kind"`
	Name       string      `json:"name"`
	Summary    string      `json:"summary"`
	Route      *string     `json:"route"`
	ArticleID  *string     `json:"articleId"`
	Attributes []Attribute `json:"attributes"`
	Aliases    []string    `json:"aliases"`
	Weight     int         `json:"weight"`
	Confidence int         `json:"confidence"`
	Source     string      `json:"source"`
}

// DraftEdge 抽取阶段关系草稿。
type DraftEdge struct {
	FromKey    string      `json:"fromKey"`
	ToKey      string      `json:"toKey"`
	Relation   string      `json:"relation"`
	Kind       string      `json:"kind"`
	Attributes []Attribute `json:"attributes"`
	Weight     int         `json:"weight"`
	Directed   bool        `json:"directed"`
	Confidence int         `json:"confidence"`
	Source     string      `json:"source"`
}

// Draft 草稿整体。
type Draft struct {
	Nodes []DraftNode `json:"nodes"`
	Edges []DraftEdge `json:"edges"`
}

// ArticleInput 抽取 Agent 的文章输入。
type ArticleInput struct {
	ArticleID         string   `json:"articleId"`
	Title             string   `json:"title"`
	Route             string   `json:"route"`
	Excerpt           string   `json:"excerpt"`
	Tags              []string `json:"tags"`
	ContentMd         string   `json:"contentMd"`
	UpdatedAt         string   `json:"updatedAt"`
	KnowledgeBaseName string   `json:"knowledgeBaseName"`
}

// AdminNode 后台维护页节点视图。
type AdminNode struct {
	ID         string      `json:"id"`
	NodeKey    string      `json:"nodeKey"`
	ParentID   *string     `json:"parentId"`
	ParentKey  *string     `json:"parentKey"`
	Kind       string      `json:"kind"`
	Name       string      `json:"name"`
	Summary    string      `json:"summary"`
	Route      *string     `json:"route"`
	ArticleID  *string     `json:"articleId"`
	Attributes []Attribute `json:"attributes"`
	Aliases    []string    `json:"aliases"`
	Weight     int32       `json:"weight"`
	SortOrder  int32       `json:"sortOrder"`
	Status     string      `json:"status"`
	Source     string      `json:"source"`
	Confidence int32       `json:"confidence"`
	Locked     bool        `json:"locked"`
	Depth      int         `json:"depth"`
	ChildCount int         `json:"childCount"`
	Degree     int         `json:"degree"`
	UpdatedAt  string      `json:"updatedAt"`
}

// SubtreeNode 子树视图：AdminNode 附带子树深度。
type SubtreeNode struct {
	AdminNode
	SubtreeDepth int `json:"subtreeDepth"`
}

// AdminEdge 后台维护页关系视图。
type AdminEdge struct {
	ID           string      `json:"id"`
	FromNodeID   string      `json:"fromNodeId"`
	FromNodeKey  string      `json:"fromNodeKey"`
	FromNodeName string      `json:"fromNodeName"`
	ToNodeID     string      `json:"toNodeId"`
	ToNodeKey    string      `json:"toNodeKey"`
	ToNodeName   string      `json:"toNodeName"`
	Relation     string      `json:"relation"`
	Kind         string      `json:"kind"`
	Attributes   []Attribute `json:"attributes"`
	Weight       int32       `json:"weight"`
	Directed     bool        `json:"directed"`
	Status       string      `json:"status"`
	Source       string      `json:"source"`
	Confidence   int32       `json:"confidence"`
	Locked       bool        `json:"locked"`
	UpdatedAt    string      `json:"updatedAt"`
}

// RunSummary 运行记录摘要。
type RunSummary struct {
	ID           string          `json:"id"`
	Status       string          `json:"status"`
	Mode         string          `json:"mode"`
	ModelName    *string         `json:"modelName"`
	ArticleCount int32           `json:"articleCount"`
	NodeCount    int32           `json:"nodeCount"`
	EdgeCount    int32           `json:"edgeCount"`
	Validation   json.RawMessage `json:"validation"`
	Warnings     []string        `json:"warnings"`
	ErrorMessage *string         `json:"errorMessage"`
	StartedAt    string          `json:"startedAt"`
	FinishedAt   *string         `json:"finishedAt"`
}

// IssueSeverity 问题级别。
const (
	SeverityError   = "error"
	SeverityWarning = "warning"
	SeverityInfo    = "info"
)

// Issue 校验问题项。
type Issue struct {
	Severity string `json:"severity"`
	Code     string `json:"code"`
	Target   string `json:"target"`
	Message  string `json:"message"`
}

// ValidationReport 校验报告。
type ValidationReport struct {
	Score       int     `json:"score"`
	Passed      bool    `json:"passed"`
	NodeCount   int     `json:"nodeCount"`
	EdgeCount   int     `json:"edgeCount"`
	OrphanCount int     `json:"orphanCount"`
	MaxDepth    int     `json:"maxDepth"`
	Issues      []Issue `json:"issues"`
	CheckedAt   string  `json:"checkedAt"`
}

// MergeCandidate 待确认实体合并候选（抽取产物）。
type MergeCandidate struct {
	SourceKey string `json:"sourceKey"`
	TargetKey string `json:"targetKey"`
	Reason    string `json:"reason"`
	Score     int    `json:"score"`
	Detail    string `json:"detail"`
}

// MergeCandidateView 合并候选后台视图。
type MergeCandidateView struct {
	ID           string  `json:"id"`
	SourceKey    string  `json:"sourceKey"`
	SourceName   string  `json:"sourceName"`
	SourceNodeID *string `json:"sourceNodeId"`
	TargetKey    string  `json:"targetKey"`
	TargetName   string  `json:"targetName"`
	TargetNodeID *string `json:"targetNodeId"`
	Reason       string  `json:"reason"`
	Score        int32   `json:"score"`
	Detail       *string `json:"detail"`
	Status       string  `json:"status"`
	CreatedAt    string  `json:"createdAt"`
}

// MergeNodesResult 人工确认合并的结果统计。
type MergeNodesResult struct {
	TargetKey          string `json:"targetKey"`
	AbsorbedAliases    int    `json:"absorbedAliases"`
	MovedEdges         int    `json:"movedEdges"`
	DroppedEdges       int    `json:"droppedEdges"`
	MovedChildren      int    `json:"movedChildren"`
	AttributeConflicts int    `json:"attributeConflicts"`
}

// GenerateResult 生成主流程返回值。
type GenerateResult struct {
	RunID               string           `json:"runId"`
	Validation          ValidationReport `json:"validation"`
	Warnings            []string         `json:"warnings"`
	ArticleCount        int              `json:"articleCount"`
	NodeCount           int              `json:"nodeCount"`
	EdgeCount           int              `json:"edgeCount"`
	LockedSkipped       int              `json:"lockedSkipped"`
	AutoAlignedCount    int              `json:"autoAlignedCount"`
	MergeCandidateCount int              `json:"mergeCandidateCount"`
	Summary             string           `json:"summary"`
}
