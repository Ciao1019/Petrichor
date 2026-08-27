package runtime

import (
	"petrichor/api/internal/config"
)

// ===== 配置与 Feature Flag（对照 config.ts）=====

// AgentFeatureFlags 运行开关。
type AgentFeatureFlags struct {
	SoftRouter    bool
	DynamicSkills bool
	Delegation    bool
	Debug         bool
}

// ReadAgentFeatureFlags 读取运行开关。
func ReadAgentFeatureFlags() AgentFeatureFlags {
	features := config.Get().Agent.Features
	return AgentFeatureFlags{
		SoftRouter:    features.SoftRouter,
		DynamicSkills: features.DynamicSkills,
		Delegation:    features.Delegation,
		Debug:         features.Debug,
	}
}

var budgetByComplexity = map[TaskComplexity]AgentBudget{
	ComplexityDirect:    {MaxIterations: 1, MaxToolCalls: 0, MaxExecutionMs: 60_000},
	ComplexitySimple:    {MaxIterations: 4, MaxToolCalls: 4, MaxExecutionMs: 120_000},
	ComplexityMultiStep: {MaxIterations: 12, MaxToolCalls: 14, MaxExecutionMs: 240_000, MaxSubAgents: 2},
	ComplexityComplex:   {MaxIterations: 24, MaxToolCalls: 32, MaxExecutionMs: 420_000, MaxSubAgents: 5},
}

// ResolveBudget 按复杂度解析预算（TOML 可覆盖）。
func ResolveBudget(complexity TaskComplexity) AgentBudget {
	base, ok := budgetByComplexity[complexity]
	if !ok {
		base = budgetByComplexity[ComplexitySimple]
	}
	overrides := complexityBudgetOverrides(complexity)
	out := AgentBudget{
		MaxIterations:  positiveOr(overrides.MaxIterations, base.MaxIterations),
		MaxToolCalls:   positiveOr(overrides.MaxToolCalls, base.MaxToolCalls),
		MaxExecutionMs: positiveInt64Or(config.Get().Agent.Budget.MaxExecutionMs, base.MaxExecutionMs),
		MaxSubAgents:   base.MaxSubAgents,
	}
	if overrides.MaxSubAgents > 0 {
		out.MaxSubAgents = overrides.MaxSubAgents
	}
	if maxTokens := config.Get().Agent.Budget.MaxTokens; maxTokens > 0 {
		out.MaxTokens = maxTokens
	}
	return out
}

func complexityBudgetOverrides(complexity TaskComplexity) config.AgentComplexityBudget {
	budget := config.Get().Agent.Budget
	switch complexity {
	case ComplexityDirect:
		return budget.Direct
	case ComplexitySimple:
		return budget.Simple
	case ComplexityMultiStep:
		return budget.MultiStep
	case ComplexityComplex:
		return budget.Complex
	default:
		return config.AgentComplexityBudget{}
	}
}

func positiveOr(value, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}

func positiveInt64Or(value, fallback int64) int64 {
	if value > 0 {
		return value
	}
	return fallback
}

// MaxDelegationDepthLimit 委派深度硬上限。
const MaxDelegationDepthLimit = 2

// ResolveStopPolicyConfig 解析停止策略配置。
func ResolveStopPolicyConfig(complexity TaskComplexity) StopPolicyConfig {
	budget := ResolveBudget(complexity)
	configured := config.Get().Agent.Budget
	depth := positiveOr(configured.MaxDelegationDepth, 2)
	if depth > MaxDelegationDepthLimit {
		depth = MaxDelegationDepthLimit
	}
	return StopPolicyConfig{
		AgentBudget:             budget,
		MaxDelegationDepth:      depth,
		MaxNoProgressIterations: positiveOr(configured.MaxNoProgress, 3),
	}
}

// ToolDefaultTimeoutMs 工具执行默认超时。
func ToolDefaultTimeoutMs() int64 {
	return positiveInt64Or(config.Get().Agent.Budget.ToolTimeoutMs, 45_000)
}

// ToolDefaultMaxRetries 同一 Tool+Args 默认最多重试次数。
func ToolDefaultMaxRetries() int {
	return positiveOr(config.Get().Agent.Budget.ToolMaxRetries, 1)
}

// SubagentDefaultTimeoutMs 子代理默认超时。
func SubagentDefaultTimeoutMs() int64 {
	return positiveInt64Or(config.Get().Agent.Budget.SubagentTimeoutMs, 120_000)
}

// ContextBudgetConfig 上下文分区预算。
type ContextBudgetConfig struct {
	Total        int64
	System       int64
	Conversation int64
	Evidence     int64
	Observation  int64
	Skill        int64
}

// ResolveContextBudget 解析上下文预算（比例同 TS：system 8% / skill 12% / evidence 30% / observation 10% / conversation 40%）。
func ResolveContextBudget(total int64) ContextBudgetConfig {
	if total <= 0 {
		total = positiveInt64Or(config.Get().Agent.Budget.ContextTokens, 100_000)
	}
	return ContextBudgetConfig{
		Total:        total,
		System:       total * 8 / 100,
		Skill:        total * 12 / 100,
		Evidence:     total * 30 / 100,
		Observation:  total * 10 / 100,
		Conversation: total * 40 / 100,
	}
}
