package runtime

import (
	"regexp"
	"strings"
)

// ===== Petrichor Agent Runtime 主循环（对照 runtime.ts）=====

// MaxSegments 一次 Run 内最多重启多少段推理，防止 skill 反复加载导致空转。
const MaxSegments = 8

// routerHintMinConfidence Router 提示的最低可用置信度。
const routerHintMinConfidence = 0.5

var (
	promptInjectionPattern      = regexp.MustCompile(`(?i)(?:忽略.{0,16}(?:以上|之前|系统|开发者)(?:指令|提示)|(?:ignore|disregard).{0,24}(?:previous|system|developer).{0,12}(?:instruction|prompt)|system\s*prompt|developer\s*message|jailbreak|越狱)`)
	promptInjectionStudyPattern = regexp.MustCompile(`(?i)(?:什么是|解释|分析|识别|检测|防范|防御|示例|例子|研究|讨论|how\s+to\s+(?:detect|prevent)|what\s+is|explain|analy[sz]e|example)`)
)

// RunRequest Run 入参。
type RunRequest struct {
	RunKey                 string
	ConversationID         string
	UserID                 int64
	DBRunID                int64
	ThreadID               int64
	SystemRole             string
	Focus                  map[string]any
	Goal                   string
	Messages               []map[string]any
	Model                  *ResolvedModelHandle
	ModelName              string
	StartedAt              int64
	ConversationSummary    *ConversationSummary
	ConversationBackground string
	RoutingHint            *RoutingHint
	TurnCount              int
	InjectionGuard         *struct {
		ProviderKey string
		ModelID     string
	}
	IsOperator        bool
	ContextTokenLimit int64
	OnEvent           EventSink
	OnToolTrace       func(trace AgentToolTrace)
}

// RunResult Run 出参。
type RunResult struct {
	RunID      string
	Answer     string
	State      *AgentState
	Trace      *AgentTrace
	Evaluation map[string]any
}

// ToolRegistry 工具注册表（由 tools 层填充）。
var defaultTools = NewToolRegistry()

// SkillRegistry 技能注册表。
var defaultSkills = NewSkillRegistry()

// RegisterDefaultTool 注册到全局注册表（tools 层 init 时调用）。
func RegisterDefaultTool(tool *AgentToolDefinition) { defaultTools.Register(tool) }

// RegisterDefaultSkills 批量注册技能。
func RegisterDefaultSkills(skills []AgentSkill) { defaultSkills.RegisterMany(skills) }

// DefaultToolRegistry 暴露全局工具注册表。
func DefaultToolRegistry() *AgentToolRegistry { return defaultTools }

// DefaultSkills 暴露全局技能注册表。
func DefaultSkills() *SkillRegistryImpl { return defaultSkills }

// SkillRegistryImpl 技能注册表实现（对照 skill-registry.ts）。
type SkillRegistryImpl struct {
	skills map[string]AgentSkill
	order  []string
}

// NewSkillRegistry 构造。
func NewSkillRegistry() *SkillRegistryImpl {
	return &SkillRegistryImpl{skills: map[string]AgentSkill{}}
}

// Register 注册技能。
func (r *SkillRegistryImpl) Register(skill AgentSkill) {
	if _, exists := r.skills[skill.ID]; !exists {
		r.order = append(r.order, skill.ID)
	}
	r.skills[skill.ID] = skill
}

// RegisterMany 批量注册。
func (r *SkillRegistryImpl) RegisterMany(skills []AgentSkill) {
	for _, s := range skills {
		r.Register(s)
	}
}

// Get 取技能。
func (r *SkillRegistryImpl) Get(id string) *AgentSkill {
	if s, ok := r.skills[id]; ok {
		return &s
	}
	return nil
}

// List 全部技能。
func (r *SkillRegistryImpl) List() []AgentSkill {
	out := make([]AgentSkill, 0, len(r.order))
	for _, id := range r.order {
		out = append(out, r.skills[id])
	}
	return out
}

// IDs 全部技能 id。
func (r *SkillRegistryImpl) IDs() []string { return append([]string{}, r.order...) }

// ResolveWithDependencies 解析依赖链，返回按依赖优先的加载顺序；自动去环。
func (r *SkillRegistryImpl) ResolveWithDependencies(id string, seen map[string]bool) []AgentSkill {
	if seen == nil {
		seen = map[string]bool{}
	}
	if seen[id] {
		return nil
	}
	skill, ok := r.skills[id]
	if !ok {
		return nil
	}
	seen[id] = true
	result := []AgentSkill{}
	for _, dep := range skill.Deps {
		result = append(result, r.ResolveWithDependencies(dep, seen)...)
	}
	result = append(result, skill)
	return result
}

// RenderSkillCatalog 能力目录：只给一行描述，不给完整 instructions。
func RenderSkillCatalog(skills []AgentSkill) string {
	return renderSkillCatalogLineFormat(skills)
}

func renderSkillCatalogLineFormat(skills []AgentSkill) string {
	if len(skills) == 0 {
		return ""
	}
	lines := make([]string, 0, len(skills))
	for _, skill := range skills {
		lines = append(lines, "- "+skill.ID+": "+skill.Description)
	}
	return "可加载的能力（用 agent.load_skill 加载）：\n" + joinStrings(lines, "\n")
}

// MapDomainsToSkills 域名 → 技能预加载映射（仅提示用途）。
func MapDomainsToSkills(domains []string, availableSkillIDs []string) []string {
	alias := map[string]string{
		"knowledge": "knowledge", "doc_library": "documents", "document": "documents",
		"documents": "documents", "system": "system", "content_write": "documents",
		"write": "writer", "writer": "writer", "admin": "admin",
		"research": "research", "graph": "graph", "memory": "memory",
	}
	out := []string{}
	added := map[string]bool{}
	for _, domain := range domains {
		skillID, ok := alias[domain]
		if !ok || !containsString(availableSkillIDs, skillID) || added[skillID] {
			continue
		}
		added[skillID] = true
		out = append(out, skillID)
	}
	return out
}

// DraftPlan 复杂任务的初始计划草案：只给骨架，Agent 会按观察不断改写。
func DraftPlan(goal string) []PlanStepDraft {
	return []PlanStepDraft{
		{Goal: "明确「" + truncateRunes(goal, 40) + "」需要哪些信息"},
		{Goal: "检索并阅读相关资料"},
		{Goal: "核对信息是否足够、是否存在冲突"},
		{Goal: "综合形成结论"},
	}
}

// ApplyPlanOps 计划变更操作应用。
func ApplyPlanOps(state *AgentStateStore, ops []PlanUpdateOp) []string {
	changed := []string{}
	for _, op := range ops {
		switch op.Op {
		case "set":
			steps := state.SetPlan(op.Steps)
			for _, step := range steps {
				changed = append(changed, step.ID)
			}
		case "add":
			step := state.AddPlanStep(op.Goal, op.DependsOn, op.AfterID)
			changed = append(changed, step.ID)
		case "update":
			status := op.Status
			var statusPtr *AgentPlanStepStatus
			if status != "" {
				statusPtr = &status
			}
			if state.UpdatePlanStep(op.ID, op.Goal, statusPtr, op.Summary) {
				changed = append(changed, op.ID)
			}
		case "remove":
			if state.RemovePlanStep(op.ID) {
				changed = append(changed, op.ID)
			}
		case "reorder":
			state.ReorderPlan(op.OrderedID)
			changed = append(changed, op.OrderedID...)
		}
	}
	return changed
}

// PetrichorAgentRuntime 编排器。
type PetrichorAgentRuntime struct {
	tools       *AgentToolRegistry
	skills      *SkillRegistryImpl
	permissions PermissionResolver
}

// NewRuntime 构造（使用全局默认注册表）。
func NewRuntime() *PetrichorAgentRuntime {
	return &PetrichorAgentRuntime{
		tools:       defaultTools,
		skills:      defaultSkills,
		permissions: NewDefaultPermissionResolver(func(toolID string) *AgentToolDefinition { return defaultTools.Get(toolID) }),
	}
}

// RuntimeServices 面向元工具的服务面实现。
type RuntimeServices struct {
	Runtime            *PetrichorAgentRuntime
	Flags              AgentFeatureFlags
	State              *AgentStateStore
	SkillLoader        *SkillLoader
	Complexity         TaskComplexity
	Budget             *BudgetTracker
	StopPolicy         *StopPolicy
	RequestRestart     func(reason string)
	DelegationDisabled string // 非空表示委派被禁用及原因
	DelegateFn         func(inputs []DelegateTaskInput) []DelegationResult
	onPlanChanged      func(steps []AgentPlanStep, changed []string)
}

// LoadSkill 动态加载技能；Router 无权阻止。
func (s *RuntimeServices) LoadSkill(skillID string) SkillLoadResult {
	if !s.Flags.DynamicSkills {
		f := false
		return SkillLoadResult{
			OK: false, SkillID: skillID,
			Error: &AgentToolErrorShape{Code: CodeSkillNotFound, Message: "动态技能已关闭", Retryable: f},
		}
	}
	return s.SkillLoader.Load(skillID)
}

// ListSkills 列出技能目录。
func (s *RuntimeServices) ListSkills() []SkillCatalogEntry {
	out := []SkillCatalogEntry{}
	for _, skill := range s.Runtime.skills.List() {
		out = append(out, SkillCatalogEntry{
			ID: skill.ID, Name: skill.Name, Description: skill.Description,
			Loaded: s.State.HasSkill(skill.ID),
		})
	}
	return out
}

// GetPlan 当前计划。
func (s *RuntimeServices) GetPlan() []AgentPlanStep { return s.State.Current().Plan }

// UpdatePlan 更新计划（应用变更并广播事件）。
func (s *RuntimeServices) UpdatePlan(ops []PlanUpdateOp) []AgentPlanStep {
	changed := ApplyPlanOps(s.State, ops)
	plan := s.State.Current().Plan
	if s.onPlanChanged != nil {
		s.onPlanChanged(plan, changed)
	}
	return plan
}

// RequestSegmentRestart 请求换段。
func (s *RuntimeServices) RequestSegmentRestart(reason string) {
	if s.RequestRestart != nil {
		s.RequestRestart(reason)
	}
}

// RemainingToolCalls 剩余工具预算。
func (s *RuntimeServices) RemainingToolCalls() int {
	return s.StopPolicy.RemainingToolCalls(s.State.Current())
}

// Delegate 并行委派子任务（复杂度门控在 Runtime 侧完成）。
func (s *RuntimeServices) Delegate(inputs []DelegateTaskInput) []DelegationResult {
	if s.DelegateFn == nil {
		return failedDelegations(inputs, "委派能力未启用")
	}
	return s.DelegateFn(inputs)
}

func failedDelegations(inputs []DelegateTaskInput, reason string) []DelegationResult {
	out := make([]DelegationResult, 0, len(inputs))
	for _, input := range inputs {
		out = append(out, DelegationResult{
			Status: "failed", Summary: reason + "：" + input.Objective,
			Evidence: []*AgentEvidence{}, TraceID: "",
		})
	}
	return out
}

// DelegateTaskInput 委派入参。
type DelegateTaskInput struct {
	Objective      string   `json:"objective"`
	Context        string   `json:"context,omitempty"`
	SkillIDs       []string `json:"skillIds,omitempty"`
	AllowedToolIDs []string `json:"allowedToolIds,omitempty"`
	ExpectedOutput string   `json:"expectedOutput,omitempty"`
	MaxIterations  int      `json:"maxIterations,omitempty"`
	MaxToolCalls   int      `json:"maxToolCalls,omitempty"`
}

// DelegationResult 委派结果。
type DelegationResult struct {
	TaskID        string             `json:"taskId"`
	Status        string             `json:"status"` // completed | failed | stopped
	Summary       string             `json:"summary"`
	Evidence      []*AgentEvidence   `json:"evidence"`
	TraceID       string             `json:"traceId"`
	ToolCallCount int                `json:"toolCallCount,omitempty"`
	DurationMs    int64              `json:"durationMs,omitempty"`
	StopReason    AgentStopReason    `json:"stopReason,omitempty"`
	ErrorCode     AgentToolErrorCode `json:"errorCode,omitempty"`
}

// SkillLoader 技能加载器（对照 skill-loader.ts 的核心路径）。
type SkillLoader struct {
	skills        *SkillRegistryImpl
	permissions   PermissionResolver
	state         *AgentStateStore
	trace         *TraceCollector
	events        *AgentEventEmitter
	activeToolIDs []string
	instructions  []SkillInstruction
}

// NewSkillLoader 构造。
func NewSkillLoader(skills *SkillRegistryImpl, permissions PermissionResolver, state *AgentStateStore, trace *TraceCollector, events *AgentEventEmitter) *SkillLoader {
	return &SkillLoader{skills: skills, permissions: permissions, state: state, trace: trace, events: events}
}

// ActiveToolIDs 已加载技能解锁的工具。
func (l *SkillLoader) ActiveToolIDs() []string { return l.activeToolIDs }

// LoadedInstructions 已加载技能的指令。
func (l *SkillLoader) LoadedInstructions() []SkillInstruction { return l.instructions }

// Preload 预加载技能（Router 提示用）。
func (l *SkillLoader) Preload(skillIDs []string) {
	for _, id := range skillIDs {
		l.Load(id)
	}
}

// Load 加载技能及其依赖。
func (l *SkillLoader) Load(skillID string) SkillLoadResult {
	chain := l.skills.ResolveWithDependencies(skillID, nil)
	if len(chain) == 0 {
		f := false
		return SkillLoadResult{
			OK: false, SkillID: skillID,
			Error: &AgentToolErrorShape{Code: CodeSkillNotFound, Message: "未知 skill：" + skillID, Retryable: f},
		}
	}
	loaded := []string{}
	alreadyLoaded := []string{}
	toolIDs := map[string]bool{}
	orderedToolIDs := []string{}
	var instructions strings.Builder
	for _, skill := range chain {
		if !l.state.MarkSkillLoaded(skill.ID) {
			alreadyLoaded = append(alreadyLoaded, skill.ID)
		} else {
			loaded = append(loaded, skill.ID)
			l.instructions = append(l.instructions, SkillInstruction{SkillID: skill.ID, Instructions: skill.Instructions})
			l.trace.RecordSkillLoad(AgentSkillTrace{SkillID: skill.ID, LoadedAt: nowMs(), ToolIDs: skill.ToolIDs})
			l.events.Emit("skill_loaded", map[string]any{
				"skillId": skill.ID, "name": skill.Name, "description": skill.Description, "toolIds": skill.ToolIDs,
			})
		}
		instructions.WriteString(skill.Instructions)
		instructions.WriteString("\n")
		for _, toolID := range skill.ToolIDs {
			if !toolIDs[toolID] {
				toolIDs[toolID] = true
				orderedToolIDs = append(orderedToolIDs, toolID)
			}
		}
	}
	for _, toolID := range orderedToolIDs {
		if !containsString(l.activeToolIDs, toolID) {
			l.activeToolIDs = append(l.activeToolIDs, toolID)
		}
	}
	return SkillLoadResult{
		OK: true, SkillID: skillID, Loaded: loaded, AlreadyLoaded: alreadyLoaded,
		Instructions: trimSpace(instructions.String()), ToolIDs: orderedToolIDs,
	}
}

func mapKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// EvaluateRun 运行评估（对照 eval.ts 的核心指标）。
func EvaluateRun(state *AgentState, trace *AgentTrace, answer string) map[string]any {
	score := 0.0
	if answer != "" {
		score += 0.4
	}
	if len(trace.ToolCalls) > 0 || len(state.Evidence) > 0 || answer != "" {
		score += 0.2
	}
	if len(state.Evidence) > 0 {
		score += 0.2
	}
	if state.Status == StatusCompleted {
		score += 0.2
	}
	reason := ""
	if state.StopReason != "" {
		reason = string(state.StopReason)
	}
	return map[string]any{
		"score": score, "status": state.Status, "stopReason": reason,
		"toolCalls": len(trace.ToolCalls), "evidenceCount": len(state.Evidence),
		"answerChars": len([]rune(answer)),
	}
}

// resolveActiveTools 当前可用工具：核心工具 ∪ Wiki 工具 ∪ 已加载技能解锁的工具。
//
// Wiki 工具无条件挂上：知识库里的 Wiki 页面是整理过的结论，源文档分片是原始素材，
// 该读哪一层由 Agent 按问题自行判断，不由调用方在提问前拨开关决定。
func (r *PetrichorAgentRuntime) resolveActiveTools(loader *SkillLoader, complexity TaskComplexity, isOperator bool) []*AgentToolDefinition {
	if complexity == ComplexityDirect {
		return nil
	}
	ids := make([]string, 0, 16)
	idSet := map[string]bool{}
	add := func(id string) {
		if id == "" || idSet[id] {
			return
		}
		idSet[id] = true
		ids = append(ids, id)
	}
	for _, id := range r.tools.CoreToolIDs(isOperator) {
		add(id)
	}
	for _, id := range loader.ActiveToolIDs() {
		add(id)
	}
	for _, tool := range r.tools.List(&ToolFilter{Namespace: NamespaceKnowledge}) {
		if containsString(tool.Tags, "wiki") {
			add(tool.ID)
		}
	}
	out := make([]*AgentToolDefinition, 0, len(ids))
	for _, id := range ids {
		tool := r.tools.Get(id)
		if tool == nil {
			continue
		}
		if tool.RequiresOperator && !isOperator {
			continue
		}
		out = append(out, tool)
	}
	return out
}

// synthesizeFinalAnswerInput 收敛作答入参。
