// Package runtime 是 Petrichor Agent Runtime 的 Go 移植（对照 apps/web/src/server/assistant/agent-runtime/）。
//
// 主循环：Reason → Select Action → Execute → Observe → Update State → Finish / Continue / Re-plan。
// 底层工具调用循环基于 aicore.ChatWithTools（对应 TS 的 Mastra mastra-bridge）；
// 本包只负责编排与收敛，具体能力在各自模块里。
package runtime

import (
	"encoding/json"
)

// TaskComplexity 任务复杂度。仅作策略提示，不限制 Agent 实际能力。
type TaskComplexity string

const (
	ComplexityDirect    TaskComplexity = "direct"
	ComplexitySimple    TaskComplexity = "simple"
	ComplexityMultiStep TaskComplexity = "multi_step"
	ComplexityComplex   TaskComplexity = "complex"
)

// AgentStopReason 统一停止原因。
type AgentStopReason string

const (
	StopGoalCompleted      AgentStopReason = "goal_completed"
	StopEnoughEvidence     AgentStopReason = "enough_evidence"
	StopMaxIterations      AgentStopReason = "max_iterations"
	StopMaxToolCalls       AgentStopReason = "max_tool_calls"
	StopMaxExecutionTime   AgentStopReason = "max_execution_time"
	StopMaxTokens          AgentStopReason = "max_tokens"
	StopMaxDelegationDepth AgentStopReason = "max_delegation_depth"
	StopLoopDetected       AgentStopReason = "loop_detected"
	StopNoProgress         AgentStopReason = "no_progress"
	StopPermissionDenied   AgentStopReason = "permission_denied"
	StopCancelled          AgentStopReason = "cancelled"
	StopFatalError         AgentStopReason = "fatal_error"
)

// AgentRunStatus Run 状态。
type AgentRunStatus string

const (
	StatusRunning   AgentRunStatus = "running"
	StatusCompleted AgentRunStatus = "completed"
	StatusFailed    AgentRunStatus = "failed"
	StatusStopped   AgentRunStatus = "stopped"
	StatusCancelled AgentRunStatus = "cancelled"
)

// AgentPlanStepStatus 计划步骤状态。
type AgentPlanStepStatus string

const (
	PlanPending   AgentPlanStepStatus = "pending"
	PlanRunning   AgentPlanStepStatus = "running"
	PlanCompleted AgentPlanStepStatus = "completed"
	PlanSkipped   AgentPlanStepStatus = "skipped"
	PlanFailed    AgentPlanStepStatus = "failed"
)

// AgentPlanStep 计划步骤。可增删改、可重排，禁止退化为固定 DAG。
type AgentPlanStep struct {
	ID            string              `json:"id"`
	Goal          string              `json:"goal"`
	Status        AgentPlanStepStatus `json:"status"`
	DependsOn     []string            `json:"dependsOn,omitempty"`
	ResultSummary string              `json:"resultSummary,omitempty"`
}

// AgentObservation 工具结果的紧凑观察。进入 LLM Context 的是它，而不是原始结果。
type AgentObservation struct {
	ID               string          `json:"id"`
	Type             string          `json:"type"`
	Source           string          `json:"source"`
	Summary          string          `json:"summary"`
	Data             json.RawMessage `json:"data,omitempty"`
	EvidenceIDs      []string        `json:"evidenceIds"`
	SuggestedActions []string        `json:"suggestedActions,omitempty"`
	IsError          bool            `json:"isError,omitempty"`
	CreatedAt        int64           `json:"createdAt"`
}

// AgentEvidenceSource 证据来源域。
type AgentEvidenceSource string

const (
	EvidenceKnowledge EvidenceSourceAlias = "knowledge"
	EvidenceWiki      EvidenceSourceAlias = "wiki"
	EvidenceWeb       EvidenceSourceAlias = "web"
	EvidenceMemory    EvidenceSourceAlias = "memory"
	EvidenceGraph     EvidenceSourceAlias = "graph"
	EvidenceTool      EvidenceSourceAlias = "tool"
	EvidenceSubagent  EvidenceSourceAlias = "subagent"
)

// EvidenceSourceAlias 简短别名。
type EvidenceSourceAlias = AgentEvidenceSource

// AgentEvidence 统一证据。最终答案应尽量由 Evidence 构建。
type AgentEvidence struct {
	ID         string              `json:"id"`
	Source     AgentEvidenceSource `json:"source"`
	Title      string              `json:"title,omitempty"`
	Content    string              `json:"content"`
	SourceID   string              `json:"sourceId,omitempty"`
	URL        string              `json:"url,omitempty"`
	Relevance  *float64            `json:"relevance,omitempty"`
	Confidence *float64            `json:"confidence,omitempty"`
	Freshness  *float64            `json:"freshness,omitempty"`
	FullRead   bool                `json:"fullRead,omitempty"`
	Metadata   map[string]any      `json:"metadata,omitempty"`
	CreatedAt  int64               `json:"createdAt"`
}

// AgentTokenUsage token 用量。
type AgentTokenUsage struct {
	Input  int64 `json:"input"`
	Output int64 `json:"output"`
	Total  int64 `json:"total"`
}

// AgentState 统一 Agent 状态。可序列化，不依赖 LLM chat history 即可恢复。
type AgentState struct {
	RunID           string             `json:"runId"`
	ConversationID  string             `json:"conversationId"`
	UserID          string             `json:"userId"`
	Goal            string             `json:"goal"`
	Complexity      TaskComplexity     `json:"complexity"`
	Plan            []AgentPlanStep    `json:"plan"`
	CompletedSteps  []AgentPlanStep    `json:"completedSteps"`
	PendingSteps    []AgentPlanStep    `json:"pendingSteps"`
	LoadedSkills    []string           `json:"loadedSkills"`
	Observations    []AgentObservation `json:"observations"`
	Evidence        []AgentEvidence    `json:"evidence"`
	OpenQuestions   []string           `json:"openQuestions"`
	Assumptions     []string           `json:"assumptions"`
	ToolCallCount   int                `json:"toolCallCount"`
	DelegationCount int                `json:"delegationCount"`
	Iteration       int                `json:"iteration"`
	TokenUsage      AgentTokenUsage    `json:"tokenUsage"`
	StartedAt       int64              `json:"startedAt"`
	UpdatedAt       int64              `json:"updatedAt"`
	Status          AgentRunStatus     `json:"status"`
	StopReason      AgentStopReason    `json:"stopReason,omitempty"`
}

// RoutingHint Router 只能输出提示，禁止裁剪 Agent 能力。
type RoutingHint struct {
	Domains    []string `json:"domains"`
	Confidence float64  `json:"confidence"`
	Reasoning  string   `json:"reasoning,omitempty"`
}

// ToolNamespace 工具命名空间。
type ToolNamespace string

const (
	NamespaceKnowledge ToolNamespace = "knowledge"
	NamespaceResearch  ToolNamespace = "research"
	NamespaceMemory    ToolNamespace = "memory"
	NamespaceGraph     ToolNamespace = "graph"
	NamespaceWriter    ToolNamespace = "writer"
	NamespaceDocument  ToolNamespace = "document"
	NamespaceAdmin     ToolNamespace = "admin"
	NamespaceSystem    ToolNamespace = "system"
	NamespaceAgent     ToolNamespace = "agent"
)

// ToolRiskLevel 工具风险级别。
type ToolRiskLevel string

const (
	RiskLow    ToolRiskLevel = "low"
	RiskMedium ToolRiskLevel = "medium"
	RiskHigh   ToolRiskLevel = "high"
)

// AgentRuntimeServices Runtime 暴露给 agent.* 元工具的服务面。
type AgentRuntimeServices interface {
	LoadSkill(skillID string) SkillLoadResult
	ListSkills() []SkillCatalogEntry
	GetPlan() []AgentPlanStep
	UpdatePlan(ops []PlanUpdateOp) []AgentPlanStep
	RequestSegmentRestart(reason string)
	RemainingToolCalls() int
}

// ToolExecutionContext 工具执行上下文。
type ToolExecutionContext struct {
	RunID           string
	UserID          int64
	ConversationID  string
	Focus           map[string]any
	QaMode          string // normal | wiki
	SystemRole      string
	DelegationDepth int
	State           *AgentState
	Services        AgentRuntimeServices
}

// PlanUpdateOp 计划变更操作。
type PlanUpdateOp struct {
	Op        string              `json:"op"` // set | add | update | remove | reorder
	Steps     []PlanStepDraft     `json:"steps,omitempty"`
	Goal      string              `json:"goal,omitempty"`
	AfterID   string              `json:"afterId,omitempty"`
	DependsOn []string            `json:"dependsOn,omitempty"`
	ID        string              `json:"id,omitempty"`
	Status    AgentPlanStepStatus `json:"status,omitempty"`
	Summary   string              `json:"resultSummary,omitempty"`
	OrderedID []string            `json:"orderedIds,omitempty"`
}

// PlanStepDraft set 操作的步骤草稿。
type PlanStepDraft struct {
	Goal      string   `json:"goal"`
	DependsOn []string `json:"dependsOn,omitempty"`
}

// AgentToolErrorCode 统一工具错误码。
type AgentToolErrorCode string

const (
	CodeAgentTimeout         AgentToolErrorCode = "AGENT_TIMEOUT"
	CodeAgentLoop            AgentToolErrorCode = "AGENT_LOOP"
	CodeToolTimeout          AgentToolErrorCode = "TOOL_TIMEOUT"
	CodePermissionDenied     AgentToolErrorCode = "TOOL_PERMISSION_DENIED"
	CodeValidationError      AgentToolErrorCode = "TOOL_VALIDATION_ERROR"
	CodeExecutionError       AgentToolErrorCode = "TOOL_EXECUTION_ERROR"
	CodeToolAborted          AgentToolErrorCode = "TOOL_ABORTED"
	CodeSkillNotFound        AgentToolErrorCode = "SKILL_NOT_FOUND"
	CodeSkillDenied          AgentToolErrorCode = "SKILL_PERMISSION_DENIED"
	CodeSubagentFailed       AgentToolErrorCode = "SUBAGENT_FAILED"
	CodeRerankFailed         AgentToolErrorCode = "RERANK_FAILED"
	CodeRetrievalFailed      AgentToolErrorCode = "RETRIEVAL_FAILED"
	CodeContextBudgetExceede AgentToolErrorCode = "CONTEXT_BUDGET_EXCEEDED"
)

// AgentToolErrorShape 面向观察/Trace 的错误形状。
type AgentToolErrorShape struct {
	Code      AgentToolErrorCode `json:"code"`
	Message   string             `json:"message"`
	Retryable bool               `json:"retryable"`
}

// ToolExecutionResult 工具执行结果。
type ToolExecutionResult struct {
	OK         bool
	Output     any
	Error      *AgentToolErrorShape
	DurationMs int64
	Retries    int
}

// ToolNormalizerResult 工具结果 → Observation/Evidence 的归一化结果。
type ToolNormalizerResult struct {
	Summary          string
	Data             json.RawMessage
	SuggestedActions []string
	Evidence         []EvidenceInput
	Progress         *bool
}

// ToolNormalizer 归一化函数签名。
type ToolNormalizer func(output any, input any) ToolNormalizerResult

// AgentToolDefinition 统一工具定义。
type AgentToolDefinition struct {
	ID                   string          `json:"id"`
	Name                 string          `json:"name"`
	Namespace            ToolNamespace   `json:"namespace"`
	Description          string          `json:"description"`
	InputSchema          json.RawMessage `json:"inputSchema"`
	Execute              func(ctx *ToolExecutionContext, input any) (any, error)
	Permissions          []string       `json:"permissions,omitempty"`
	RiskLevel            ToolRiskLevel  `json:"riskLevel"`
	SideEffect           bool           `json:"sideEffect"`
	RequiresConfirmation bool           `json:"requiresConfirmation,omitempty"`
	AllowedInSubAgent    *bool          `json:"allowedInSubAgent,omitempty"`
	RequiresOperator     bool           `json:"requiresOperator,omitempty"`
	Core                 bool           `json:"core,omitempty"`
	Tags                 []string       `json:"tags,omitempty"`
	TimeoutMs            int64          `json:"timeoutMs,omitempty"`
	MaxRetries           int            `json:"maxRetries,omitempty"`
	Normalize            ToolNormalizer `json:"-"`
}

// AllowsSubAgent 是否允许子代理使用（缺省 true）。
func (t *AgentToolDefinition) AllowsSubAgent() bool {
	return t.AllowedInSubAgent == nil || *t.AllowedInSubAgent
}

// AgentSkill 技能定义。
type AgentSkill struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	Instructions string   `json:"instructions"`
	ToolIDs      []string `json:"toolIds"`
	Deps         []string `json:"dependencies,omitempty"`
	Tags         []string `json:"tags,omitempty"`
}

// SkillCatalogEntry 技能目录条目。
type SkillCatalogEntry struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Loaded      bool   `json:"loaded"`
}

// SkillLoadResult 技能加载结果。
type SkillLoadResult struct {
	OK            bool
	SkillID       string
	Loaded        []string
	AlreadyLoaded []string
	Instructions  string
	ToolIDs       []string
	Error         *AgentToolErrorShape
}

// AgentBudget 运行预算。
type AgentBudget struct {
	MaxIterations  int
	MaxToolCalls   int
	MaxTokens      int64
	MaxExecutionMs int64
	MaxSubAgents   int
}

// StopPolicyConfig 停止策略配置。
type StopPolicyConfig struct {
	AgentBudget
	MaxDelegationDepth      int
	MaxNoProgressIterations int
}

// StopDecision 停止裁决。
type StopDecision struct {
	Stop   bool
	Reason AgentStopReason
	Detail string
}
