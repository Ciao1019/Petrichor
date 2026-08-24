package runtime

import (
	"context"
	"regexp"
	"strings"
)

// ===== Petrichor Agent Runtime 主循环（对照 runtime.ts）=====

// MaxSegments 一次 Run 内最多重启多少段推理，防止 skill 反复加载导致空转。
const MaxSegments = 8

// routerHintMinConfidence Router 提示的最低可用置信度。
const routerHintMinConfidence = 0.5

var (
	simpleKnowledgePattern     = regexp.MustCompile(`(?i)(?:是什么|什么意思|是干什么(?:的)?|有(?:哪些|什么)(?:主要|核心)?功能|怎么用|如何使用|使用方法|用途|作用|介绍|概述|说明|教程|原理|区别)`)
	scopedKnowledgeFactPattern = regexp.MustCompile(`(?:是否|能否|能不能|支不支持|支持(?:什么|哪些)?|在哪里|哪个|多少)`)
	nonKnowledgeActionPattern  = regexp.MustCompile(`(?:创建|新建|修改|更新|删除|移动|发布|分享|保存|导出|写一篇|生成一篇|改写|翻译|发邮件|联网|外部资料|网页搜索|历史对话|记住)`)
	systemOverviewPattern      = regexp.MustCompile(`(?:(?:有多少|多少|几个|数量|清单|列出).{0,12}(?:知识库|文档库|文章|文档|对话)|(?:知识库|文档库|文章|文档|对话).{0,12}(?:有多少|多少|几个|数量|清单))`)
	promptInjectionPattern     = regexp.MustCompile(`(?i)(?:忽略.{0,16}(?:以上|之前|系统|开发者)(?:指令|提示)|(?:ignore|disregard).{0,24}(?:previous|system|developer).{0,12}(?:instruction|prompt)|system\s*prompt|developer\s*message|jailbreak|越狱)`)
)

// WikiQaModeGuidance Wiki 问答模式（参考 Tencent/WeKnora 的 Wiki 检索策略）。
const WikiQaModeGuidance = "## Wiki 问答模式\n" +
	"当前是「Wiki 问答」：优先依据知识库的 Wiki 页面回答，而不是原始分片。\n" +
	"检索策略：\n" +
	"1. 回答内容型问题前，先用 wiki_overview 掌握全貌（主题与知识页 / 源文档页两组目录）。\n" +
	"2. 定位页面用 search_wiki_pages：queries 一次传多个关键词（同义概念、别名词一起搜），从 pageKey、摘要与命中片段判断相关性；不要只用单个宽泛词。\n" +
	"3. 对最相关页面调用 read_wiki_page_detail 读全文；返回里的 links/inLinks 是关联页面（带摘要），相关就继续读，形成多跳推理。若 Wiki 页面信息不足需要读源文档补充，回答时仍要引用对应的 Wiki 页面。\n" +
	"4. 【引用格式（最重要）】答案正文中凡是来自某个 Wiki 页面的信息，必须紧跟内联引用 [[pageKey|页面标题]]，例如：Mole 是一款开源清理工具 [[concept-mole|Mole]]。pageKey 必须来自检索结果，严禁编造；证据列表里每条 Wiki 证据都附有「Wiki 引用」提示，照抄即可。\n" +
	"5. 不要输出 [1]、[2] 这类数字角标来标注 Wiki 来源——本模式一律用 [[..]] 内联引用，前端会渲染成可点击的波浪线链接；同一页面多次提及时首次引用即可。\n" +
	"6. 严禁编造或使用 Wiki 之外的知识；检索不到就如实说明，不要杜撰。"

// RunRequest Run 入参。
type RunRequest struct {
	ConversationID         string
	UserID                 int64
	DBRunID                int64
	ThreadID               int64
	SystemRole             string
	Focus                  map[string]any
	QaMode                 string // normal | wiki
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

// ShouldUseSimpleKnowledgeFastPath 高频简单知识问答快车道判定。
func ShouldUseSimpleKnowledgeFastPath(goal string, complexity TaskComplexity, focus map[string]any, hint *RoutingHint) bool {
	goal = trimSpace(goal)
	if complexity != ComplexitySimple || goal == "" || len([]rune(goal)) > 160 {
		return false
	}
	if nonKnowledgeActionPattern.MatchString(goal) || systemOverviewPattern.MatchString(goal) || promptInjectionPattern.MatchString(goal) {
		return false
	}
	if simpleKnowledgePattern.MatchString(goal) {
		return true
	}
	hasKnowledgeScope := false
	if focus != nil {
		_, hasKB := focus["knowledgeBaseId"]
		_, hasArticle := focus["articleId"]
		hasKnowledgeScope = hasKB || hasArticle
	}
	if !hasKnowledgeScope && hint != nil && hint.Confidence >= 0.7 && containsString(hint.Domains, "knowledge") {
		hasKnowledgeScope = true
	}
	return hasKnowledgeScope && scopedKnowledgeFactPattern.MatchString(goal)
}

// MapDomainsToSkills 域名 → 技能预加载映射（仅提示用途）。
func MapDomainsToSkills(domains []string, availableSkillIDs []string) []string {
	alias := map[string]string{
		"knowledge": "knowledge", "doc_library": "documents", "document": "documents",
		"documents": "documents", "system": "system", "content_write": "writer",
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
			toolIDs[toolID] = true
		}
	}
	for toolID := range toolIDs {
		if !containsString(l.activeToolIDs, toolID) {
			l.activeToolIDs = append(l.activeToolIDs, toolID)
		}
	}
	return SkillLoadResult{
		OK: true, SkillID: skillID, Loaded: loaded, AlreadyLoaded: alreadyLoaded,
		Instructions: trimSpace(instructions.String()), ToolIDs: mapKeys(toolIDs),
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

// resolveActiveTools 当前可用工具：核心工具 ∪ 已加载技能解锁的工具。
func (r *PetrichorAgentRuntime) resolveActiveTools(loader *SkillLoader, complexity TaskComplexity, isOperator bool, qaMode string) []*AgentToolDefinition {
	if complexity == ComplexityDirect {
		return nil
	}
	idSet := map[string]bool{}
	for _, id := range r.tools.CoreToolIDs(isOperator) {
		idSet[id] = true
	}
	for _, id := range loader.ActiveToolIDs() {
		idSet[id] = true
	}
	if qaMode == "wiki" {
		wikiNS := NamespaceKnowledge
		for _, tool := range r.tools.List(&ToolFilter{Namespace: wikiNS}) {
			if containsString(tool.Tags, "wiki") {
				idSet[tool.ID] = true
			}
		}
	}
	ids := make([]string, 0, len(idSet))
	for id := range idSet {
		ids = append(ids, id)
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
type synthesizeFinalAnswerInput struct {
	Request         *RunRequest
	State           *AgentStateStore
	Evidence        *EvidenceStore
	Observations    *ObservationStore
	StopReason      AgentStopReason
	Events          *AgentEventEmitter
	Trace           *TraceCollector
	ReplacePrevious bool
}

// synthesizeFinalAnswer 强制收敛：无工具的一次生成，只基于证据作答。
func (r *PetrichorAgentRuntime) synthesizeFinalAnswer(ctx context.Context, input *synthesizeFinalAnswerInput) string {
	evidenceAll := input.Evidence.All()
	pointers := make([]*AgentEvidence, 0, len(evidenceAll))
	for i := range evidenceAll {
		pointers = append(pointers, &evidenceAll[i])
	}
	finalCtx := BuildFinalAnswerContext(struct {
		State        *AgentState
		Evidence     []*AgentEvidence
		CitationIdx  func(id string) int
		Observations *ObservationStore
		Limitations  []string
		WikiMode     bool
	}{
		State:        input.State.Current(),
		Evidence:     pointers,
		CitationIdx:  input.Evidence.CitationIndex,
		Observations: input.Observations,
		WikiMode:     input.Request.QaMode == "wiki",
	})

	stopGuidance := ""
	switch input.StopReason {
	case StopMaxIterations:
		stopGuidance = "\n已达到最大推理轮数，请基于现有信息直接给出结论。"
	case StopMaxToolCalls, StopLoopDetected, StopNoProgress:
		stopGuidance = "\n无法继续获取新信息，请基于现有信息回答并说明局限。"
	case StopCancelled:
		stopGuidance = "\n任务已被取消。"
	}

	instructions := finalCtx + "\n\n## 最终作答要求\n基于以上证据与观察，直接回答用户目标。" +
		BuildAnswerQualityGuidance(input.Request.Goal) + stopGuidance

	controller := NewSegmentController()
	started := false
	segment := RunAgentSegment(ctx, &SegmentRequest{
		AgentID:      "petrichor-agent-final",
		Model:        input.Request.Model,
		Instructions: instructions,
		Prompt:       input.Request.Goal,
		Tools:        nil,
		Ctx: &ToolExecutionContext{
			RunID:          input.State.Current().RunID,
			UserID:         input.Request.UserID,
			ConversationID: input.Request.ConversationID,
			State:          input.State.Current(),
		},
		Executor: nil,
		MaxSteps: 1,
		OnTextDelta: func(delta string) {
			if !started {
				started = true
				payload := map[string]any{}
				if input.ReplacePrevious {
					payload["replace"] = true
				}
				input.Events.Emit("final_answer_started", payload)
				input.Trace.MarkFirstToken()
			}
			input.Events.Emit("final_answer_delta", map[string]any{"delta": delta})
		},
	}, controller)

	input.State.AddTokenUsage(segment.Usage.Input, segment.Usage.Output)
	input.Trace.AddTokenUsage(segment.Usage.Input, segment.Usage.Output)
	input.Trace.AddLlmLatency(segment.LlmMs)
	return trimSpace(segment.Text)
}

// Run 执行一次完整的 Agentic Run。
func (r *PetrichorAgentRuntime) Run(ctx context.Context, request *RunRequest) (*RunResult, error) {
	runID := NewRunID()
	flags := ReadAgentFeatureFlags()
	startedAt := request.StartedAt
	if startedAt <= 0 {
		startedAt = nowMs()
	}

	events := NewAgentEventEmitter(runID, request.OnEvent)
	trace := NewTraceCollector(runID, request.ConversationID, itoa(int(request.UserID)), request.ModelName, startedAt)
	trace.Event("run_started", map[string]any{"goal": request.Goal})
	events.Emit("agent_started", map[string]any{
		"goal": request.Goal, "model": request.ModelName, "conversationId": request.ConversationID,
	})

	// Router 只作提示，失败不影响主流程
	routingHint := (*RoutingHint)(nil)
	if flags.SoftRouter && request.RoutingHint != nil {
		routingHint = request.RoutingHint
		trace.SetRoutingHint(*routingHint)
	}
	actionableHint := (*RoutingHint)(nil)
	if routingHint != nil && routingHint.Confidence >= routerHintMinConfidence {
		actionableHint = routingHint
	}

	complexityDecision := DetectComplexity(ComplexityInput{
		Goal: request.Goal, RoutingHint: actionableHint,
		TurnCount: request.TurnCount, HasFocus: request.Focus != nil,
	})
	complexity := complexityDecision.Complexity
	trace.SetComplexity(complexity, complexityDecision.Reason)
	hintPayload := map[string]any{"complexity": complexity, "reason": complexityDecision.Reason}
	if routingHint != nil {
		hintPayload["routingHint"] = routingHint
	}
	events.Emit("complexity_detected", hintPayload)

	state := NewAgentStateStore(runID, request.ConversationID, itoa(int(request.UserID)), request.Goal, complexity, startedAt)
	observations := NewObservationStore()
	evidenceStore := NewEvidenceStore()
	budget := NewBudgetTracker(ResolveBudget(complexity), startedAt)
	stopConfig := ResolveStopPolicyConfig(complexity)
	loopDetector := NewLoopDetector(stopConfig.MaxNoProgressIterations + 1)
	stopPolicy := NewStopPolicy(stopConfig, budget, loopDetector)
	contextManager := NewContextManager(ResolveContextBudget(request.ContextTokenLimit))

	executor := NewToolExecutor(&ToolExecutorDeps{
		Registry: r.tools, Permissions: r.permissions,
		Observations: observations, Evidence: evidenceStore,
		State: state, Trace: trace, LoopDetector: loopDetector, Events: events,
		ClampTimeout: func(desired int64) int64 { return budget.ClampToolTimeout(desired) },
		OnToolTrace:  request.OnToolTrace,
	})

	skillLoader := NewSkillLoader(r.skills, r.permissions, state, trace, events)

	var segmentRestartReason atomicValue
	services := &RuntimeServices{
		Runtime: r, Flags: flags, State: state, SkillLoader: skillLoader, Complexity: complexity,
		Budget: budget, StopPolicy: stopPolicy,
		RequestRestart: func(reason string) { segmentRestartReason.set(reason) },
	}

	buildCtx := func() *ToolExecutionContext {
		return &ToolExecutionContext{
			RunID: runID, UserID: request.UserID, ConversationID: request.ConversationID,
			Focus: request.Focus, QaMode: request.QaMode, SystemRole: request.SystemRole,
			DelegationDepth: 0, State: state.Current(), Services: services,
		}
	}

	// 预加载：Router hint 只用于预热
	if flags.DynamicSkills && actionableHint != nil && len(actionableHint.Domains) > 0 {
		skillLoader.Preload(MapDomainsToSkills(actionableHint.Domains, r.skills.IDs()))
	}

	// 简单知识问答快车道（Wiki 模式不走）
	simpleFastPath := false
	if request.QaMode != "wiki" && ctx.Err() == nil && r.tools.Has("knowledge.lookup") &&
		ShouldUseSimpleKnowledgeFastPath(request.Goal, complexity, request.Focus, routingHint) {
		outcome := executor.Execute(ctx, "knowledge.lookup", map[string]any{"query": request.Goal}, buildCtx())
		simpleFastPath = outcome.OK && len(outcome.Evidence) > 0
		trace.Event("observation", map[string]any{
			"strategy": "simple_knowledge_fast_path", "hit": simpleFastPath, "evidenceCount": len(outcome.Evidence),
		})
	}

	// 计划
	if ShouldCreatePlan(complexity) {
		steps := state.SetPlan(DraftPlan(request.Goal))
		trace.Event("plan_created", map[string]any{"steps": steps})
		events.Emit("plan_created", map[string]any{"steps": steps})
	}

	answer := ""
	segments := 0
	var fatalErr *AgentError
	stopReason := AgentStopReason("")
	stopDetail := ""

	for segments < MaxSegments {
		if ctx.Err() != nil {
			stopReason = StopCancelled
			break
		}
		before := stopPolicy.EvaluateBeforeIteration(state.Current())
		if before.Stop {
			stopReason = before.Reason
			stopDetail = before.Detail
			break
		}

		segments++
		state.IncrementIteration()

		segmentRestartReason.reset()
		segmentController := NewSegmentController()
		services.RequestRestart = func(reason string) {
			segmentRestartReason.set(reason)
			segmentController.Request(reason)
		}

		var activeTools []*AgentToolDefinition
		if !simpleFastPath {
			activeTools = r.resolveActiveTools(skillLoader, complexity, request.IsOperator, request.QaMode)
		}
		modeGuidance := ""
		qaMode := ""
		if request.QaMode == "wiki" {
			modeGuidance = WikiQaModeGuidance
			qaMode = "wiki"
		}
		built := contextManager.Build(ContextBuildInput{
			State: state.Current(), Observations: observations, Evidence: evidenceStore,
			SkillInstructions: skillLoader.LoadedInstructions(), SkillCatalog: r.skills.List(),
			Tools: activeTools, RecentMessages: request.Messages,
			ConversationSummary:    request.ConversationSummary,
			ConversationBackground: request.ConversationBackground,
			RoutingHint:            actionableHint, ModeGuidance: modeGuidance, QaMode: qaMode,
			RemainingToolCalls: stopPolicy.RemainingToolCalls(state.Current()),
		})

		trimmedMessages := request.Messages
		if len(request.Messages) > 0 {
			trimmedMessages = contextManager.TrimConversation(request.Messages)
		} else {
			trimmedMessages = nil
		}

		answerStarted := false
		maxSteps := stopPolicy.RemainingToolCalls(state.Current())
		if simpleFastPath {
			maxSteps = 1
		} else if maxSteps < 1 {
			maxSteps = 1
		}

		segment := RunAgentSegment(ctx, &SegmentRequest{
			AgentID: "petrichor-agent", Model: request.Model,
			Instructions: built.Instructions,
			Messages:     trimmedMessages, Prompt: request.Goal,
			Tools: activeTools, Ctx: buildCtx(), Executor: executor,
			MaxSteps: maxSteps,
			OnTextDelta: func(delta string) {
				if !answerStarted {
					answerStarted = true
					events.Emit("final_answer_started", map[string]any{})
					trace.MarkFirstToken()
				}
				events.Emit("final_answer_delta", map[string]any{"delta": delta})
			},
			OnAnswerReset: func() {
				if !answerStarted {
					return
				}
				answerStarted = false
				events.Emit("final_answer_started", map[string]any{})
			},
			OnToolOutcome: func(outcome *ToolRunOutcome) {
				decision := stopPolicy.EvaluateAfterToolCall(state.Current())
				if decision.Stop {
					stopReason = decision.Reason
					stopDetail = decision.Detail
					segmentController.Request("stop_policy:" + string(decision.Reason))
				}
			},
		}, segmentController)

		state.AddTokenUsage(segment.Usage.Input, segment.Usage.Output)
		trace.AddTokenUsage(segment.Usage.Input, segment.Usage.Output)
		trace.AddLlmLatency(segment.LlmMs)

		if segment.Aborted {
			stopReason = StopCancelled
			if trimSpace(segment.Text) != "" {
				answer = trimSpace(segment.Text)
			}
			break
		}

		if segment.Stopped == nil {
			answer = trimSpace(segment.Text)
			if answer != "" {
				if stopReason == "" {
					stopReason = StopGoalCompleted
				}
				break
			}
			if stopReason == "" {
				stopReason = StopEnoughEvidence
			}
			break
		}

		if strings.HasPrefix(segment.Stopped.Reason, "stop_policy:") {
			break
		}
		// 因加载技能中止 → 带着新能力继续下一段
		answer = ""

		if reason := segmentRestartReason.get(); reason != "" {
			_ = reason
		}
	}

	if segments >= MaxSegments && answer == "" && stopReason == "" {
		stopReason = StopMaxIterations
		stopDetail = "已达最大推理段数"
	}

	// 已作答但内容明显草率 → 质量门重写
	if answer != "" && evidenceStore.Size() > 0 && (stopReason == StopGoalCompleted || stopReason == StopEnoughEvidence) {
		quality := AssessAnswerQuality(request.Goal, answer, evidenceStore.All())
		trace.Event("answer_quality_checked", map[string]any{
			"adequate": quality.Adequate, "depth": quality.Depth,
			"answerChars": quality.AnswerChars, "contentUnits": quality.ContentUnits,
			"evidenceChars": quality.EvidenceChars, "reasons": quality.Reasons,
		})
		if !quality.Adequate {
			original := answer
			answer = trimSpace(r.synthesizeFinalAnswer(ctx, &synthesizeFinalAnswerInput{
				Request: request, State: state, Evidence: evidenceStore, Observations: observations,
				StopReason: stopReason, Events: events, Trace: trace, ReplacePrevious: true,
			}))
			if answer == "" {
				answer = original
			}
		}
	}

	// 强制收敛作答
	if answer == "" && fatalErr == nil && stopReason != StopCancelled {
		answer = trimSpace(r.synthesizeFinalAnswer(ctx, &synthesizeFinalAnswerInput{
			Request: request, State: state, Evidence: evidenceStore, Observations: observations,
			StopReason: stopReason, Events: events, Trace: trace, ReplacePrevious: false,
		}))
	}

	if answer != "" {
		answer = DedupeRepeatedAnswer(answer)
	}

	metrics := AgentRunMetrics{
		DurationMs: nowMs() - startedAt, ToolCalls: state.Current().ToolCallCount,
		EvidenceCount: evidenceStore.Size(), SubAgentCount: budget.SubAgentCount(),
		Iterations: state.Current().Iteration,
	}

	if stopReason == StopCancelled {
		state.Finish(StatusCancelled, StopCancelled)
		events.Emit("agent_cancelled", map[string]any{"metrics": metrics})
	} else if fatalErr != nil {
		state.Finish(StatusFailed, stopReason)
		events.Emit("agent_error", map[string]any{"message": "执行过程中出现问题", "errorCode": fatalErr.Code})
	} else if stopReason != "" && stopReason != StopGoalCompleted && stopReason != StopEnoughEvidence {
		state.Finish(StatusStopped, stopReason)
		message := stopDetail
		if message == "" {
			message = "任务已停止"
		}
		events.Emit("agent_stopped", map[string]any{"stopReason": stopReason, "message": message, "metrics": metrics})
	} else {
		finalReason := stopReason
		if finalReason == "" {
			finalReason = StopGoalCompleted
		}
		state.Finish(StatusCompleted, finalReason)
	}

	if answer != "" {
		events.Emit("final_answer_completed", map[string]any{"text": answer})
	}
	completedPayload := map[string]any{"status": state.Current().Status, "metrics": metrics}
	if state.Current().StopReason != "" {
		completedPayload["stopReason"] = state.Current().StopReason
	}
	events.Emit("agent_completed", completedPayload)

	evidenceIDs := make([]string, 0, evidenceStore.Size())
	for _, item := range evidenceStore.All() {
		evidenceIDs = append(evidenceIDs, item.ID)
	}
	trace.RecordEvidenceIDs(evidenceIDs)
	trace.Event("final_answer", map[string]any{"length": len([]rune(answer))})
	trace.Finish(state.Current().StopReason)

	finalState := state.Snapshot()
	finalTrace := trace.Build()

	return &RunResult{
		RunID: runID, Answer: answer, State: finalState, Trace: finalTrace,
		Evaluation: EvaluateRun(finalState, finalTrace, answer),
	}, nil
}

type atomicValue struct{ v string }

func (a *atomicValue) set(v string) { a.v = v }
func (a *atomicValue) get() string  { return a.v }
func (a *atomicValue) reset()       { a.v = "" }
