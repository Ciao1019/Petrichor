package runtime

import (
	"os"
	"strconv"
	"strings"
)

// ===== 配置与 Feature Flag（对照 config.ts）=====

// AgentFeatureFlags 运行开关。
type AgentFeatureFlags struct {
	RuntimeV2     bool
	SoftRouter    bool
	DynamicSkills bool
	Delegation    bool
	Debug         bool
}

func envFlag(name string, fallback bool) bool {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	return raw == "1" || strings.EqualFold(raw, "true")
}

func envInt(name string, fallback int64) int64 {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	if v, err := strconv.ParseInt(raw, 10, 64); err == nil && v > 0 {
		return v
	}
	return fallback
}

// ReadAgentFeatureFlags 读取运行开关。
func ReadAgentFeatureFlags() AgentFeatureFlags {
	return AgentFeatureFlags{
		RuntimeV2:     envFlag("AGENT_RUNTIME_V2", true),
		SoftRouter:    envFlag("SOFT_ROUTER_ENABLED", true),
		DynamicSkills: envFlag("AGENT_DYNAMIC_SKILLS", true),
		Delegation:    envFlag("AGENT_DELEGATION", true),
		Debug:         envFlag("AGENT_DEBUG", false),
	}
}

var budgetByComplexity = map[TaskComplexity]AgentBudget{
	ComplexityDirect:    {MaxIterations: 1, MaxToolCalls: 0, MaxExecutionMs: 60_000},
	ComplexitySimple:    {MaxIterations: 4, MaxToolCalls: 4, MaxExecutionMs: 120_000},
	ComplexityMultiStep: {MaxIterations: 12, MaxToolCalls: 14, MaxExecutionMs: 240_000, MaxSubAgents: 2},
	ComplexityComplex:   {MaxIterations: 24, MaxToolCalls: 32, MaxExecutionMs: 420_000, MaxSubAgents: 5},
}

// ResolveBudget 按复杂度解析预算（环境变量可覆盖）。
func ResolveBudget(complexity TaskComplexity) AgentBudget {
	base, ok := budgetByComplexity[complexity]
	if !ok {
		base = budgetByComplexity[ComplexitySimple]
	}
	out := AgentBudget{
		MaxIterations:  int(envInt("AGENT_MAX_ITERATIONS_"+strings.ToUpper(string(complexity)), int64(base.MaxIterations))),
		MaxToolCalls:   int(envInt("AGENT_MAX_TOOL_CALLS_"+strings.ToUpper(string(complexity)), int64(base.MaxToolCalls))),
		MaxExecutionMs: envInt("AGENT_MAX_EXECUTION_MS", base.MaxExecutionMs),
		MaxSubAgents:   base.MaxSubAgents,
	}
	if maxTokens := envInt("AGENT_MAX_TOKENS", 0); maxTokens > 0 {
		out.MaxTokens = maxTokens
	}
	return out
}

// MaxDelegationDepthLimit 委派深度硬上限。
const MaxDelegationDepthLimit = 2

// ResolveStopPolicyConfig 解析停止策略配置。
func ResolveStopPolicyConfig(complexity TaskComplexity) StopPolicyConfig {
	budget := ResolveBudget(complexity)
	depth := int(envInt("AGENT_MAX_DELEGATION_DEPTH", 2))
	if depth > MaxDelegationDepthLimit {
		depth = MaxDelegationDepthLimit
	}
	return StopPolicyConfig{
		AgentBudget:             budget,
		MaxDelegationDepth:      depth,
		MaxNoProgressIterations: int(envInt("AGENT_MAX_NO_PROGRESS", 3)),
	}
}

// ToolDefaultTimeoutMs 工具执行默认超时。
func ToolDefaultTimeoutMs() int64 { return envInt("AGENT_TOOL_TIMEOUT_MS", 45_000) }

// ToolDefaultMaxRetries 同一 Tool+Args 默认最多重试次数。
func ToolDefaultMaxRetries() int { return int(envInt("AGENT_TOOL_MAX_RETRIES", 1)) }

// SubagentDefaultTimeoutMs 子代理默认超时。
func SubagentDefaultTimeoutMs() int64 { return envInt("AGENT_SUBAGENT_TIMEOUT_MS", 120_000) }

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
		total = envInt("AGENT_CONTEXT_TOKENS", 100_000)
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
