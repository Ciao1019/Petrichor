package runtime

// AgentStateStore Agent 状态容器（对照 state.ts）。
//
// 设计约束：
// - 完全可序列化，不依赖 LLM chat history 就能恢复；
// - 每次 Tool Call、Skill Load 之后都必须更新。
type AgentStateStore struct {
	state *AgentState
}

// NewAgentStateStore 初始化状态。
func NewAgentStateStore(runID, conversationID, userID, goal string, complexity TaskComplexity, now int64) *AgentStateStore {
	if now <= 0 {
		now = nowMs()
	}
	if complexity == "" {
		complexity = ComplexitySimple
	}
	return &AgentStateStore{state: &AgentState{
		RunID:          runID,
		ConversationID: conversationID,
		UserID:         userID,
		Goal:           goal,
		Complexity:     complexity,
		Plan:           []AgentPlanStep{},
		CompletedSteps: []AgentPlanStep{},
		PendingSteps:   []AgentPlanStep{},
		LoadedSkills:   []string{},
		Observations:   []AgentObservation{},
		Evidence:       []AgentEvidence{},
		OpenQuestions:  []string{},
		Assumptions:    []string{},
		TokenUsage:     AgentTokenUsage{},
		StartedAt:      now,
		UpdatedAt:      now,
		Status:         StatusRunning,
	}}
}

func (s *AgentStateStore) touch() { s.state.UpdatedAt = nowMs() }

// Current 只读引用，供 ToolExecutionContext 传递；外部禁止直接改字段。
func (s *AgentStateStore) Current() *AgentState { return s.state }

// Snapshot 深拷贝快照。
func (s *AgentStateStore) Snapshot() *AgentState { return cloneState(s.state) }

func (s *AgentStateStore) setComplexity(complexity TaskComplexity) {
	s.state.Complexity = complexity
	s.touch()
}

// SetPlan 生成计划；简单请求不应调用。
func (s *AgentStateStore) SetPlan(drafts []PlanStepDraft) []AgentPlanStep {
	plan := make([]AgentPlanStep, 0, len(drafts))
	for _, d := range drafts {
		plan = append(plan, AgentPlanStep{ID: NewID("step"), Goal: d.Goal, Status: PlanPending, DependsOn: d.DependsOn})
	}
	s.state.Plan = plan
	s.syncPlanBuckets()
	s.touch()
	return s.state.Plan
}

// AddPlanStep 追加步骤（可指定 afterId）。
func (s *AgentStateStore) AddPlanStep(goal string, dependsOn []string, afterID string) AgentPlanStep {
	next := AgentPlanStep{ID: NewID("step"), Goal: goal, Status: PlanPending, DependsOn: dependsOn}
	index := -1
	if afterID != "" {
		for i := range s.state.Plan {
			if s.state.Plan[i].ID == afterID {
				index = i
				break
			}
		}
	}
	if index >= 0 && index+1 <= len(s.state.Plan) {
		tail := append([]AgentPlanStep{}, s.state.Plan[index+1:]...)
		s.state.Plan = append(append(s.state.Plan[:index+1], next), tail...)
	} else {
		s.state.Plan = append(s.state.Plan, next)
	}
	s.syncPlanBuckets()
	s.touch()
	return next
}

// UpdatePlanStep 更新步骤；未命中返回 false。
func (s *AgentStateStore) UpdatePlanStep(id string, goal string, status *AgentPlanStepStatus, resultSummary string) bool {
	for i := range s.state.Plan {
		step := &s.state.Plan[i]
		if step.ID != id {
			continue
		}
		if goal != "" {
			step.Goal = goal
		}
		if status != nil {
			step.Status = *status
		}
		if resultSummary != "" {
			step.ResultSummary = resultSummary
		}
		s.syncPlanBuckets()
		s.touch()
		return true
	}
	return false
}

// RemovePlanStep 删除步骤。
func (s *AgentStateStore) RemovePlanStep(id string) bool {
	kept := s.state.Plan[:0]
	removed := false
	for _, step := range s.state.Plan {
		if step.ID == id {
			removed = true
			continue
		}
		kept = append(kept, step)
	}
	s.state.Plan = kept
	if removed {
		s.syncPlanBuckets()
		s.touch()
	}
	return removed
}

// ReorderPlan 重新排序：给定完整 id 顺序，未列出的保持原相对次序追加在后。
func (s *AgentStateStore) ReorderPlan(orderedIDs []string) []AgentPlanStep {
	byID := map[string]AgentPlanStep{}
	for _, step := range s.state.Plan {
		byID[step.ID] = step
	}
	next := make([]AgentPlanStep, 0, len(s.state.Plan))
	seen := map[string]bool{}
	for _, id := range orderedIDs {
		if step, ok := byID[id]; ok {
			next = append(next, step)
			seen[id] = true
		}
	}
	for _, step := range s.state.Plan {
		if !seen[step.ID] {
			next = append(next, step)
		}
	}
	s.state.Plan = next
	s.syncPlanBuckets()
	s.touch()
	return s.state.Plan
}

func (s *AgentStateStore) syncPlanBuckets() {
	completed := []AgentPlanStep{}
	pending := []AgentPlanStep{}
	for _, step := range s.state.Plan {
		if step.Status == PlanCompleted || step.Status == PlanSkipped {
			completed = append(completed, step)
		} else if step.Status == PlanPending || step.Status == PlanRunning {
			pending = append(pending, step)
		}
	}
	s.state.CompletedSteps = completed
	s.state.PendingSteps = pending
}

// MarkSkillLoaded 标记技能已加载；重复返回 false。
func (s *AgentStateStore) MarkSkillLoaded(skillID string) bool {
	for _, id := range s.state.LoadedSkills {
		if id == skillID {
			return false
		}
	}
	s.state.LoadedSkills = append(s.state.LoadedSkills, skillID)
	s.touch()
	return true
}

// HasSkill 技能是否已加载。
func (s *AgentStateStore) HasSkill(skillID string) bool {
	for _, id := range s.state.LoadedSkills {
		if id == skillID {
			return true
		}
	}
	return false
}

// AddObservation 记录观察。
func (s *AgentStateStore) AddObservation(observation AgentObservation) {
	s.state.Observations = append(s.state.Observations, observation)
	s.touch()
}

// AddEvidence 记录证据（按 id 去重）。
func (s *AgentStateStore) AddEvidence(evidence []AgentEvidence) {
	if len(evidence) == 0 {
		return
	}
	known := map[string]bool{}
	for _, item := range s.state.Evidence {
		known[item.ID] = true
	}
	for _, item := range evidence {
		if known[item.ID] {
			continue
		}
		known[item.ID] = true
		s.state.Evidence = append(s.state.Evidence, item)
	}
	s.touch()
}

// IncrementToolCall 工具调用计数 +1。
func (s *AgentStateStore) IncrementToolCall() int {
	s.state.ToolCallCount++
	s.touch()
	return s.state.ToolCallCount
}

// IncrementDelegation 委派计数 +1。
func (s *AgentStateStore) IncrementDelegation() int {
	s.state.DelegationCount++
	s.touch()
	return s.state.DelegationCount
}

// IncrementIteration 迭代计数 +1。
func (s *AgentStateStore) IncrementIteration() int {
	s.state.Iteration++
	s.touch()
	return s.state.Iteration
}

// AddTokenUsage 累加 token 用量。
func (s *AgentStateStore) AddTokenUsage(input, output int64) {
	s.state.TokenUsage.Input += input
	s.state.TokenUsage.Output += output
	total := input + output
	s.state.TokenUsage.Total += total
	s.touch()
}

// AddOpenQuestion 登记待解决问题。
func (s *AgentStateStore) AddOpenQuestion(question string) {
	question = trimSpace(question)
	if question == "" {
		return
	}
	for _, q := range s.state.OpenQuestions {
		if q == question {
			return
		}
	}
	s.state.OpenQuestions = append(s.state.OpenQuestions, question)
	s.touch()
}

// Finish 收敛到终态。
func (s *AgentStateStore) Finish(status AgentRunStatus, reason AgentStopReason) {
	s.state.Status = status
	if reason != "" {
		s.state.StopReason = reason
	}
	s.touch()
}

func cloneState(src *AgentState) *AgentState {
	out := *src
	out.Plan = append([]AgentPlanStep{}, src.Plan...)
	out.CompletedSteps = append([]AgentPlanStep{}, src.CompletedSteps...)
	out.PendingSteps = append([]AgentPlanStep{}, src.PendingSteps...)
	out.LoadedSkills = append([]string{}, src.LoadedSkills...)
	out.Observations = append([]AgentObservation{}, src.Observations...)
	out.Evidence = append([]AgentEvidence{}, src.Evidence...)
	out.OpenQuestions = append([]string{}, src.OpenQuestions...)
	out.Assumptions = append([]string{}, src.Assumptions...)
	return &out
}
