package runtime

import (
	"encoding/json"
	"regexp"
	"strings"
	"time"
)

func nowMs() int64 { return time.Now().UnixMilli() }

func trimSpace(s string) string { return strings.TrimSpace(s) }

// ===== 预算跟踪（对照 budget.ts）=====

// BudgetTracker 只负责"还剩多少"，是否停止由 StopPolicy 统一裁决。
type BudgetTracker struct {
	Budget    AgentBudget
	startedAt int64
	subAgents int
}

// NewBudgetTracker 构造。
func NewBudgetTracker(budget AgentBudget, now int64) *BudgetTracker {
	if now <= 0 {
		now = nowMs()
	}
	return &BudgetTracker{Budget: budget, startedAt: now}
}

// ElapsedMs 已运行毫秒。
func (b *BudgetTracker) ElapsedMs() int64 { return nowMs() - b.startedAt }

// RemainingMs 剩余毫秒。
func (b *BudgetTracker) RemainingMs() int64 {
	r := b.Budget.MaxExecutionMs - b.ElapsedMs()
	if r < 0 {
		return 0
	}
	return r
}

// TimeExhausted 时间预算耗尽。
func (b *BudgetTracker) TimeExhausted() bool { return b.RemainingMs() <= 0 }

// CountSubAgent 登记子代理。
func (b *BudgetTracker) CountSubAgent() int {
	b.subAgents++
	return b.subAgents
}

// SubAgentCount 子代理计数。
func (b *BudgetTracker) SubAgentCount() int { return b.subAgents }

// SubAgentsExhausted 子代理额度耗尽。
func (b *BudgetTracker) SubAgentsExhausted() bool { return b.subAgents >= b.Budget.MaxSubAgents }

// ClampToolTimeout 单次工具超时不得超过剩余运行时间；下限 1s 只作用于压缩侧。
func (b *BudgetTracker) ClampToolTimeout(desiredMs int64) int64 {
	remaining := b.RemainingMs()
	if remaining <= 0 {
		return desiredMs
	}
	min := int64(1000)
	if remaining < min {
		remaining = min
	}
	if desiredMs < remaining {
		return desiredMs
	}
	return remaining
}

// ===== 循环检测（对照 loop-detector.ts）=====

// LoopSignal 循环信号。
type LoopSignal struct {
	Kind       string // exact_repeat | pattern_loop | no_evidence_progress | duplicate_search
	ToolID     string
	Times      int
	Pattern    []string
	Calls      int
	Similarity float64
}

type loopCallRecord struct {
	toolID           string
	argsHash         string
	query            string
	resultHash       string
	producedEvidence bool
}

// LoopDetector 四类循环信号检测。
type LoopDetector struct {
	calls                    []loopCallRecord
	exactRepeatThreshold     int
	patternCycleThreshold    int
	noProgressThreshold      int
	querySimilarityThreshold float64
}

// NewLoopDetector 构造（阈值缺省同 TS）。
func NewLoopDetector(noProgressThreshold int) *LoopDetector {
	if noProgressThreshold <= 0 {
		noProgressThreshold = 4
	}
	return &LoopDetector{
		exactRepeatThreshold:     3,
		patternCycleThreshold:    3,
		noProgressThreshold:      noProgressThreshold,
		querySimilarityThreshold: 0.9,
	}
}

// Record 工具执行完成后登记一次调用；返回触发的循环信号（无则 nil）。
func (d *LoopDetector) Record(toolID string, input, output any, producedEvidence bool) *LoopSignal {
	rec := loopCallRecord{
		toolID:           toolID,
		argsHash:         StableHash(input),
		producedEvidence: producedEvidence,
	}
	if q := extractQuery(input); q != "" {
		rec.query = q
	}
	if output != nil {
		rec.resultHash = StableHash(output)
	}
	d.calls = append(d.calls, rec)
	return d.Detect()
}

// Detect 按优先级返回首个命中的信号。
func (d *LoopDetector) Detect() *LoopSignal {
	if s := d.detectExactRepeat(); s != nil {
		return s
	}
	if s := d.detectDuplicateSearch(); s != nil {
		return s
	}
	if s := d.detectPatternLoop(); s != nil {
		return s
	}
	return d.detectNoEvidenceProgress()
}

// NoProgressStreak 从末尾往前数连续没有产生证据的调用。
func (d *LoopDetector) NoProgressStreak() int {
	streak := 0
	for i := len(d.calls) - 1; i >= 0; i-- {
		if d.calls[i].producedEvidence {
			break
		}
		streak++
	}
	return streak
}

func (d *LoopDetector) detectExactRepeat() *LoopSignal {
	if len(d.calls) == 0 {
		return nil
	}
	last := d.calls[len(d.calls)-1]
	times := 0
	for i := len(d.calls) - 1; i >= 0; i-- {
		item := d.calls[i]
		if item.toolID != last.toolID || item.argsHash != last.argsHash {
			break
		}
		times++
	}
	if times >= d.exactRepeatThreshold {
		return &LoopSignal{Kind: "exact_repeat", ToolID: last.toolID, Times: times}
	}
	return nil
}

func (d *LoopDetector) detectDuplicateSearch() *LoopSignal {
	if len(d.calls) == 0 {
		return nil
	}
	last := d.calls[len(d.calls)-1]
	if last.query == "" || last.resultHash == "" {
		return nil
	}
	for i := len(d.calls) - 2; i >= 0; i-- {
		prev := d.calls[i]
		if prev.toolID != last.toolID || prev.query == "" || prev.resultHash != last.resultHash {
			continue
		}
		similarity := QuerySimilarity(prev.query, last.query)
		if similarity >= d.querySimilarityThreshold {
			return &LoopSignal{Kind: "duplicate_search", ToolID: last.toolID, Similarity: similarity}
		}
	}
	return nil
}

func (d *LoopDetector) detectPatternLoop() *LoopSignal {
	for _, period := range []int{2, 3} {
		need := period * d.patternCycleThreshold
		if len(d.calls) < need {
			continue
		}
		tail := d.calls[len(d.calls)-need:]
		base := make([]string, period)
		for i := 0; i < period; i++ {
			base[i] = tail[i].toolID + ":" + tail[i].argsHash
		}
		matched := true
		distinct := map[string]bool{}
		for _, sig := range base {
			distinct[sig] = true
		}
		for i := 0; i < need; i++ {
			if tail[i].toolID+":"+tail[i].argsHash != base[i%period] {
				matched = false
				break
			}
		}
		if matched && len(distinct) > 1 {
			pattern := make([]string, period)
			for i := 0; i < period; i++ {
				pattern[i] = tail[i].toolID
			}
			return &LoopSignal{Kind: "pattern_loop", Pattern: pattern, Times: d.patternCycleThreshold}
		}
	}
	return nil
}

func (d *LoopDetector) detectNoEvidenceProgress() *LoopSignal {
	streak := d.NoProgressStreak()
	if streak >= d.noProgressThreshold {
		return &LoopSignal{Kind: "no_evidence_progress", Calls: streak}
	}
	return nil
}

var punctuationPattern = regexp.MustCompile(`[，。！？、；：“”‘’（）()\[\]{}.,!?;:'"]`)

func extractQuery(input any) string {
	record, ok := input.(map[string]any)
	if !ok {
		raw, err := jsonMarshal(input)
		if err != nil {
			return ""
		}
		if json.Unmarshal(raw, &record) != nil {
			return ""
		}
	}
	for _, key := range []string{"query", "q", "objective", "goal", "keyword"} {
		if v, ok := record[key].(string); ok && trimSpace(v) != "" {
			return trimSpace(v)
		}
	}
	return ""
}

// QuerySimilarity 查询相似度：字符 bigram Jaccard。中文按字符 bigram 比按词更稳。
func QuerySimilarity(a, b string) float64 {
	left := bigrams(normalizeQuery(a))
	right := bigrams(normalizeQuery(b))
	if len(left) == 0 && len(right) == 0 {
		return 1
	}
	if len(left) == 0 || len(right) == 0 {
		return 0
	}
	intersection := 0
	for gram := range left {
		if right[gram] {
			intersection++
		}
	}
	return float64(intersection) / float64(len(left)+len(right)-intersection)
}

func normalizeQuery(value string) string {
	value = strings.ToLower(value)
	value = strings.Join(strings.Fields(value), "")
	value = punctuationPattern.ReplaceAllString(value, "")
	return value
}

func bigrams(value string) map[string]bool {
	runes := []rune(value)
	set := map[string]bool{}
	if len(runes) == 1 {
		set[value] = true
	}
	for i := 0; i+1 < len(runes); i++ {
		set[string(runes[i:i+2])] = true
	}
	return set
}

// ===== 停止裁决（对照 stop-policy.ts）=====

// StopPolicy 统一停止裁决：只要返回 stop=true，Runtime 必须收敛去生成答案，而不是硬中断。
type StopPolicy struct {
	config StopPolicyConfig
	budget *BudgetTracker
	loop   *LoopDetector
}

// NewStopPolicy 构造。
func NewStopPolicy(config StopPolicyConfig, budget *BudgetTracker, loop *LoopDetector) *StopPolicy {
	return &StopPolicy{config: config, budget: budget, loop: loop}
}

func stopDecision(reason AgentStopReason, detail string) StopDecision {
	return StopDecision{Stop: true, Reason: reason, Detail: detail}
}

var continueDecision = StopDecision{}

// EvaluateBeforeIteration 循环前检查：预算是否还允许再迭代一轮。
func (p *StopPolicy) EvaluateBeforeIteration(state *AgentState) StopDecision {
	if state.Iteration >= p.config.MaxIterations {
		return stopDecision(StopMaxIterations, "已达最大迭代次数")
	}
	if p.budget.TimeExhausted() {
		return stopDecision(StopMaxExecutionTime, "已达最大执行时长")
	}
	if p.config.MaxTokens > 0 && state.TokenUsage.Total >= p.config.MaxTokens {
		return stopDecision(StopMaxTokens, "已达 token 上限")
	}
	return continueDecision
}

// EvaluateAfterToolCall 工具执行后检查：工具预算、循环、无进展。
func (p *StopPolicy) EvaluateAfterToolCall(state *AgentState) StopDecision {
	if state.ToolCallCount >= p.config.MaxToolCalls {
		if len(state.Evidence) > 0 {
			return stopDecision(StopEnoughEvidence, "已取得证据，停止继续调用工具并进入最终作答")
		}
		return stopDecision(StopMaxToolCalls, "已达最大工具调用次数")
	}
	if p.budget.TimeExhausted() {
		return stopDecision(StopMaxExecutionTime, "已达最大执行时长")
	}
	if signal := p.loop.Detect(); signal != nil {
		return fromLoopSignal(signal)
	}
	if p.loop.NoProgressStreak() >= p.config.MaxNoProgressIterations {
		return stopDecision(StopNoProgress, "连续多次工具调用没有新增证据")
	}
	return continueDecision
}

// EvaluateBeforeDelegation 委派前检查：深度与子代理数量。
func (p *StopPolicy) EvaluateBeforeDelegation(depth int) StopDecision {
	if depth >= p.config.MaxDelegationDepth {
		return stopDecision(StopMaxDelegationDepth, "委派深度已达上限")
	}
	if p.budget.SubAgentsExhausted() {
		return stopDecision(StopMaxToolCalls, "子代理数量已达上限")
	}
	return continueDecision
}

// RemainingToolCalls 剩余可用工具调用次数。
func (p *StopPolicy) RemainingToolCalls(state *AgentState) int {
	r := p.config.MaxToolCalls - state.ToolCallCount
	if r < 0 {
		return 0
	}
	return r
}

// FromLoopSignal 循环信号 → 停止决策。
func fromLoopSignal(signal *LoopSignal) StopDecision {
	switch signal.Kind {
	case "exact_repeat":
		return stopDecision(StopLoopDetected, "工具连续多次相同参数调用")
	case "pattern_loop":
		return stopDecision(StopLoopDetected, "检测到调用环："+strings.Join(signal.Pattern, " → "))
	case "duplicate_search":
		return stopDecision(StopLoopDetected, "重复检索，结果未变化")
	case "no_evidence_progress":
		return stopDecision(StopNoProgress, "连续多次工具调用没有新增证据")
	}
	return continueDecision
}

// DescribeStopReasonForUser 面向普通用户的停止文案：不暴露内部策略名。
func DescribeStopReasonForUser(reason AgentStopReason) string {
	switch reason {
	case "", StopGoalCompleted, StopEnoughEvidence:
		return ""
	case StopCancelled:
		return "已停止。"
	case StopPermissionDenied:
		return "当前账号没有执行该操作的权限，任务已停止。"
	case StopFatalError:
		return "执行过程中出现问题，任务已停止。"
	default:
		return "任务执行已停止，因为暂时无法获得更多有效信息。"
	}
}
