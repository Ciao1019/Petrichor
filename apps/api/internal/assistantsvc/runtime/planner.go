package runtime

import "regexp"

// ===== 复杂度识别与计划管理（对照 planner.ts）=====

// ComplexitySignal 复杂度信号。
type ComplexitySignal struct {
	ID      string `json:"id"`
	Weight  int    `json:"weight"`
	Matched bool   `json:"matched"`
	Detail  string `json:"detail,omitempty"`
}

// ComplexityDecision 复杂度判定结果。
type ComplexityDecision struct {
	Complexity TaskComplexity     `json:"complexity"`
	Reason     string             `json:"reason"`
	Score      int                `json:"score"`
	Signals    []ComplexitySignal `json:"signals"`
}

// ComplexityInput 判定入参。
type ComplexityInput struct {
	Goal        string
	RoutingHint *RoutingHint
	TurnCount   int
	HasFocus    bool
}

var directPatterns = []*regexp.Regexp{
	regexp.MustCompile(`^\s*(你好|hi|hello|在吗|谢谢|thanks?)\s*[!！。.]*$`),
	regexp.MustCompile(`^\s*\d+\s*[+\-*/×÷]\s*\d+\s*(=|等于)?\s*(多少|几)?\s*[?？。.!！]*\s*$`),
	regexp.MustCompile(`^\s*(你是谁|你能做什么|介绍一下你自己)\s*[?？]?\s*$`),
}

var researchPatterns = []*regexp.Regexp{
	regexp.MustCompile(`官方|最新|近期|当前版本|业界|社区|发布|release|changelog`),
	regexp.MustCompile(`查(一下|查)?(网上|外部|公开)`),
	regexp.MustCompile(`对比.*(官方|业界|市面|开源)`),
}

var complexPatterns = []*regexp.Regexp{
	regexp.MustCompile(`分别(研究|调研|分析|对比)`),
	regexp.MustCompile(`(对比|比较).{0,20}(和|与|vs).{0,20}(的|之间)?`),
	regexp.MustCompile(`技术选型|方案选型|可行性分析|风险(评估|清单|分析)`),
	regexp.MustCompile(`(写|生成|输出)(一份|一篇)?(技术方案|设计文档|调研报告|白皮书|方案)`),
	regexp.MustCompile(`全面(分析|梳理|评估)`),
}

var multiStepPatterns = []*regexp.Regexp{
	regexp.MustCompile(`为什么|原因|怎么(做|实现|修|解决)|如何(实现|优化|排查)`),
	regexp.MustCompile(`哪些.*(依赖|关联|影响)`),
	regexp.MustCompile(`在哪里|哪个模块|定位`),
	regexp.MustCompile(`先.*(再|然后|接着)`),
}

var simplePatterns = []*regexp.Regexp{
	regexp.MustCompile(`是什么|什么是|定义|含义`),
	regexp.MustCompile(`有多少|列出|清单|列表`),
	regexp.MustCompile(`怎么部署|部署方式|配置在哪`),
}

var clauseSplitPattern = regexp.MustCompile(`[，,；;。.？?！!、和以及并且然后再]+`)

func anyMatch(patterns []*regexp.Regexp, goal string) bool {
	for _, p := range patterns {
		if p.MatchString(goal) {
			return true
		}
	}
	return false
}

// DetectComplexity 规则复杂度判定：简单请求不会因此多出一次 LLM 调用。
func DetectComplexity(input ComplexityInput) ComplexityDecision {
	goal := trimSpace(input.Goal)
	signals := []ComplexitySignal{}

	if goal == "" {
		return ComplexityDecision{Complexity: ComplexityDirect, Reason: "空目标", Signals: signals}
	}

	direct := anyMatch(directPatterns, goal)
	signals = append(signals, ComplexitySignal{ID: "direct_pattern", Matched: direct})
	if direct {
		return ComplexityDecision{Complexity: ComplexityDirect, Reason: "寒暄/常识类问题，直接回答", Signals: signals}
	}

	score := 0
	push := func(id string, weight int, matched bool, detail string) {
		signals = append(signals, ComplexitySignal{ID: id, Weight: weight, Matched: matched, Detail: detail})
		if matched {
			score += weight
		}
	}

	complexMatches := 0
	for _, p := range complexPatterns {
		if p.MatchString(goal) {
			complexMatches++
		}
	}
	signals = append(signals, ComplexitySignal{ID: "complex_pattern", Weight: 3, Matched: complexMatches > 0, Detail: "多子任务/比较/综合分析"})
	capped := complexMatches * 3
	if capped > 6 {
		capped = 6
	}
	score += capped

	push("research_pattern", 2, anyMatch(researchPatterns, goal), "需要外部资料")
	push("multi_step_pattern", 2, anyMatch(multiStepPatterns, goal), "需要多轮检索")
	push("simple_pattern", -1, anyMatch(simplePatterns, goal), "单步检索足够")
	push("long_goal", 1, len([]rune(goal)) >= 60, "目标描述较长")
	push("very_long_goal", 1, len([]rune(goal)) >= 140, "目标描述很长")
	push("multi_clause", 1, countClauses(goal) >= 3, "包含多个诉求")
	push("multi_domain", 2, input.RoutingHint != nil && len(input.RoutingHint.Domains) >= 2, "跨多个域")
	push("long_conversation", 1, input.TurnCount >= 12, "长会话延续任务")
	push("has_focus", -1, input.HasFocus, "已锁定检索范围")

	var complexity TaskComplexity
	switch {
	case score >= 5:
		complexity = ComplexityComplex
	case score >= 2:
		complexity = ComplexityMultiStep
	default:
		complexity = ComplexitySimple
	}

	matchedDetails := []string{}
	for _, signal := range signals {
		if signal.Matched && signal.Weight > 0 {
			detail := signal.Detail
			if detail == "" {
				detail = signal.ID
			}
			matchedDetails = append(matchedDetails, detail)
		}
	}
	reason := "单步或少量工具即可完成"
	if len(matchedDetails) > 0 {
		reason = joinStrings(matchedDetails, "、")
	}

	return ComplexityDecision{Complexity: complexity, Reason: reason, Score: score, Signals: signals}
}

// ShouldCreatePlan 只有复杂任务才生成计划。
func ShouldCreatePlan(complexity TaskComplexity) bool { return complexity == ComplexityComplex }

// AllowsDelegation 委派对简单任务没有价值。
func AllowsDelegation(complexity TaskComplexity) bool {
	return complexity == ComplexityComplex || complexity == ComplexityMultiStep
}

func countClauses(goal string) int {
	parts := clauseSplitPattern.Split(goal, -1)
	count := 0
	for _, part := range parts {
		if len([]rune(trimSpace(part))) >= 4 {
			count++
		}
	}
	return count
}

// NextActionableStep 计划推进：返回下一个可执行步骤（依赖已完成且自身 pending）。
func NextActionableStep(plan []AgentPlanStep) *AgentPlanStep {
	done := map[string]bool{}
	for _, step := range plan {
		if step.Status == PlanCompleted || step.Status == PlanSkipped {
			done[step.ID] = true
		}
	}
	for i := range plan {
		step := &plan[i]
		if step.Status != PlanPending {
			continue
		}
		ok := true
		for _, dep := range step.DependsOn {
			if !done[dep] {
				ok = false
				break
			}
		}
		if ok {
			return step
		}
	}
	return nil
}

// PlanProgress 计划进度。
func PlanProgress(plan []AgentPlanStep) (done, total int, allDone bool) {
	total = len(plan)
	for _, step := range plan {
		if step.Status == PlanCompleted || step.Status == PlanSkipped {
			done++
		}
	}
	return done, total, total > 0 && done == total
}

func joinStrings(parts []string, sep string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += sep
		}
		out += p
	}
	return out
}
