/**
 * Agent Runtime 核心类型（需求 §112：核心类型集中放置，避免循环依赖）。
 *
 * 本文件只放类型与常量，不引入任何运行期模块，保证任意子模块都能安全 import。
 */

// ============================================================================
// 任务复杂度与停止原因
// ============================================================================

/** 任务复杂度（§8）。仅作策略提示，不限制 Agent 实际能力。 */
export type TaskComplexity = "direct" | "simple" | "multi_step" | "complex"

export const TASK_COMPLEXITIES: TaskComplexity[] = ["direct", "simple", "multi_step", "complex"]

/** 统一停止原因（§57） */
export type AgentStopReason =
    | "goal_completed"
    | "enough_evidence"
    | "max_iterations"
    | "max_tool_calls"
    | "max_execution_time"
    | "max_tokens"
    | "max_delegation_depth"
    | "loop_detected"
    | "no_progress"
    | "permission_denied"
    | "cancelled"
    | "fatal_error"

export type AgentRunStatus = "running" | "completed" | "failed" | "stopped" | "cancelled"

// ============================================================================
// Plan
// ============================================================================

export type AgentPlanStepStatus = "pending" | "running" | "completed" | "skipped" | "failed"

/** 计划步骤（§7）。可增删改、可重排，禁止退化为固定 DAG。 */
export type AgentPlanStep = {
    id: string
    goal: string
    status: AgentPlanStepStatus
    dependsOn?: string[]
    resultSummary?: string
}

// ============================================================================
// Observation / Evidence
// ============================================================================

/** 工具结果的紧凑观察（§17）。进入 LLM Context 的是它，而不是原始结果。 */
export type AgentObservation = {
    id: string
    /** 观察类型，通常等于工具语义，如 knowledge_search / tool_error */
    type: string
    /** 产生该观察的来源，通常是 toolId */
    source: string
    summary: string
    /** 可选结构化摘要数据；仍需受 Context Manager 控制注入 */
    data?: unknown
    evidenceIds: string[]
    suggestedActions?: string[]
    isError?: boolean
    createdAt: number
}

export type AgentEvidenceSource =
    | "knowledge"
    | "web"
    | "memory"
    | "graph"
    | "tool"
    | "subagent"

/** 统一证据（§18/§20）。最终答案应尽量由 Evidence 构建。 */
export type AgentEvidence = {
    id: string
    source: AgentEvidenceSource
    title?: string
    content: string
    /** 内部来源标识：knowledge nodeKey / articleId / memory id 等 */
    sourceId?: string
    url?: string
    relevance?: number
    confidence?: number
    /** 新鲜度 0~1，越大越新（§20） */
    freshness?: number
    metadata?: EvidenceMetadata
    createdAt: number
}

export type EvidenceMetadata = {
    knowledgeBaseId?: string
    articleId?: string
    nodeKey?: string
    path?: string[]
    publishedAt?: string
    fetchedAt?: string
    /** 来源质量 0~1（§41），第一版按规则给分 */
    sourceQuality?: number
    /** 产生该证据的 subagent 任务 id */
    taskId?: string
    [key: string]: unknown
}

// ============================================================================
// State
// ============================================================================

export type AgentTokenUsage = {
    input: number
    output: number
    total: number
}

/** 统一 Agent 状态（§6）。可序列化，不依赖 LLM chat history 即可恢复。 */
export type AgentState = {
    runId: string
    conversationId: string
    userId: string

    goal: string
    complexity: TaskComplexity

    plan: AgentPlanStep[]
    completedSteps: AgentPlanStep[]
    pendingSteps: AgentPlanStep[]

    loadedSkills: string[]

    observations: AgentObservation[]
    evidence: AgentEvidence[]

    openQuestions: string[]
    assumptions: string[]

    toolCallCount: number
    delegationCount: number
    iteration: number

    tokenUsage: AgentTokenUsage

    startedAt: number
    updatedAt: number

    status: AgentRunStatus
    stopReason?: AgentStopReason
}

// ============================================================================
// Routing Hint（§5）
// ============================================================================

export type RouterMode = "disabled" | "soft"

/** Router 只能输出提示，禁止裁剪 Agent 能力。 */
export type RoutingHint = {
    domains: string[]
    confidence: number
    reasoning?: string
}

// ============================================================================
// Tool Registry（§11/§12）
// ============================================================================

export type ToolNamespace =
    | "knowledge"
    | "research"
    | "memory"
    | "graph"
    | "writer"
    | "document"
    | "admin"
    | "system"
    | "agent"

export const TOOL_NAMESPACES: ToolNamespace[] = [
    "knowledge",
    "research",
    "memory",
    "graph",
    "writer",
    "document",
    "admin",
    "system",
    "agent",
]

export type ToolRiskLevel = "low" | "medium" | "high"

/** 工具执行上下文（§13） */
export type ToolExecutionContext = {
    runId: string
    userId: number
    conversationId: string
    workspaceId?: string
    /** 站内 focus（知识库/文档库/文章范围） */
    focus?: unknown
    systemRole?: string | null
    /** 当前委派深度，主 Agent 为 0 */
    delegationDepth: number
    state: AgentState
    abortSignal?: AbortSignal
    /** 主 Agent 的 DB run id，用于步骤落库与审计 */
    dbRunId?: number
    threadId?: number
    /** Runtime 暴露给 agent.* 元工具的服务；子代理为 undefined */
    services?: AgentRuntimeServices
}

/**
 * Runtime 服务面（供 agent.* 元工具调用）。
 * 用结构化类型声明，避免 types.ts 反向依赖运行期模块。
 */
export type AgentRuntimeServices = {
    /** 动态加载技能；Router 无权阻止 */
    loadSkill(skillId: string): Promise<SkillLoadResult>
    /** 列出未加载的技能目录 */
    listSkills(): Array<{ id: string; name: string; description: string; loaded: boolean }>
    /** 并行委派子任务 */
    delegate(inputs: DelegateTaskInput[]): Promise<DelegationResult[]>
    /** 增删改查计划 */
    getPlan(): AgentPlanStep[]
    updatePlan(ops: PlanUpdateOp[]): AgentPlanStep[]
    /** 请求结束当前推理段并以新能力重启（load_skill 后使用） */
    requestSegmentRestart(reason: string): void
    /** 剩余工具调用预算，便于工具提示模型收敛 */
    remainingToolCalls(): number
}

/** 计划变更操作（§7：可增、可改、可删、可跳过、可重排） */
export type PlanUpdateOp =
    | { op: "set"; steps: Array<{ goal: string; dependsOn?: string[] }> }
    | { op: "add"; goal: string; afterId?: string; dependsOn?: string[] }
    | { op: "update"; id: string; goal?: string; status?: AgentPlanStepStatus; resultSummary?: string }
    | { op: "remove"; id: string }
    | { op: "reorder"; orderedIds: string[] }

export type AgentToolErrorCode =
    | "AGENT_TIMEOUT"
    | "AGENT_LOOP"
    | "TOOL_TIMEOUT"
    | "TOOL_PERMISSION_DENIED"
    | "TOOL_VALIDATION_ERROR"
    | "TOOL_EXECUTION_ERROR"
    | "TOOL_ABORTED"
    | "SKILL_NOT_FOUND"
    | "SKILL_PERMISSION_DENIED"
    | "SUBAGENT_FAILED"
    | "RERANK_FAILED"
    | "RETRIEVAL_FAILED"
    | "CONTEXT_BUDGET_EXCEEDED"

export type AgentToolErrorShape = {
    code: AgentToolErrorCode
    message: string
    retryable: boolean
    details?: unknown
}

export type ToolExecutionResult = {
    ok: boolean
    output?: unknown
    error?: AgentToolErrorShape
    durationMs: number
    /** 实际重试次数（不含首次执行） */
    retries: number
}

/**
 * 工具结果 → Observation / Evidence 的归一化器（§152 第 6 步）。
 * 返回的 evidence 不带 id/createdAt，由 EvidenceStore 统一分配与去重。
 */
export type ToolNormalizerResult = {
    summary: string
    data?: unknown
    suggestedActions?: string[]
    evidence?: Array<Omit<AgentEvidence, "id" | "createdAt">>
    /**
     * 本次调用是否推进了任务。
     *
     * 不能简单等同于"产出了 Evidence"：检索类工具按设计只产候选、不产证据
     * （§31 search ≠ read），若把它算作无进展，正常的 search → read 流程
     * 会被 no_progress 误杀。缺省值为"产出了证据"。
     */
    progress?: boolean
}

export type ToolNormalizer = (
    output: unknown,
    input: unknown,
) => ToolNormalizerResult

/** 统一工具定义（§12） */
export type AgentToolDefinition = {
    /** 全局唯一 id，形如 knowledge.search */
    id: string
    /** 对模型暴露的名字，保持与旧公开工具名兼容 */
    name: string
    namespace: ToolNamespace
    description: string
    inputSchema: unknown
    execute: (ctx: ToolExecutionContext, input: unknown) => Promise<unknown>
    permissions?: string[]
    riskLevel: ToolRiskLevel
    sideEffect: boolean
    requiresConfirmation?: boolean
    allowedInSubAgent?: boolean
    /** 仅操作员可见 */
    requiresOperator?: boolean
    /** 是否属于主 Agent 默认核心工具（§10） */
    core?: boolean
    tags?: string[]
    /** 单次执行超时，缺省走全局默认 */
    timeoutMs?: number
    /** 最大自动重试次数，缺省 1（§60） */
    maxRetries?: number
    normalize?: ToolNormalizer
}

// ============================================================================
// Skill（§14）
// ============================================================================

export type AgentSkill = {
    id: string
    name: string
    description: string
    instructions: string
    toolIds: string[]
    dependencies?: string[]
    permissions?: string[]
    tags?: string[]
}

export type SkillLoadResult = {
    ok: boolean
    skillId: string
    /** 本次真正新加载的 skill（含依赖） */
    loaded: string[]
    /** 因已加载而跳过的 */
    alreadyLoaded: string[]
    instructions?: string
    toolIds: string[]
    error?: AgentToolErrorShape
    available?: Array<{ id: string; description: string }>
}

// ============================================================================
// Delegation（§49）
// ============================================================================

export type DelegateTaskInput = {
    objective: string
    context?: string
    skillIds?: string[]
    allowedToolIds?: string[]
    expectedOutput?: string
    maxIterations?: number
    maxToolCalls?: number
}

export type AgentArtifact = {
    id: string
    type: string
    title?: string
    content: string
    metadata?: Record<string, unknown>
}

export type DelegationResult = {
    taskId: string
    status: "completed" | "failed" | "stopped"
    summary: string
    evidence: AgentEvidence[]
    artifacts?: AgentArtifact[]
    traceId: string
    /** 便于 Main Agent 与 UI 判断是否值得再委派 */
    toolCallCount?: number
    durationMs?: number
    stopReason?: AgentStopReason
    errorCode?: AgentToolErrorCode
}

// ============================================================================
// Budget & Stop Policy（§56/§62）
// ============================================================================

export type AgentBudget = {
    maxIterations: number
    maxToolCalls: number
    maxTokens?: number
    maxExecutionMs: number
    maxSubAgents: number
}

export type StopPolicyConfig = AgentBudget & {
    maxDelegationDepth: number
    maxNoProgressIterations: number
}

export type StopDecision = {
    stop: boolean
    reason?: AgentStopReason
    detail?: string
}

// ============================================================================
// Trace（§64/§65）
// ============================================================================

export type AgentTraceEventType =
    | "run_started"
    | "user_input"
    | "routing_hint"
    | "complexity_decided"
    | "plan_created"
    | "plan_updated"
    | "skill_loaded"
    | "tool_call"
    | "tool_result"
    | "observation"
    | "evidence"
    | "delegation_started"
    | "delegation_completed"
    | "retrieval_diagnostics"
    | "answer_quality_checked"
    | "final_answer"
    | "stop"
    | "error"

export type AgentTraceEvent = {
    id: string
    runId: string
    sequence: number
    type: AgentTraceEventType
    payload: Record<string, unknown>
    createdAt: number
}

export type AgentToolTrace = {
    id: string
    toolId: string
    /** 对模型暴露的公开名（兼容旧 assistant_step 表与 Router 的近期工具统计） */
    toolName: string
    namespace: string
    input: unknown
    /** 原始结果只进 Trace，不进 LLM Context（§17） */
    rawOutput?: unknown
    summary?: string
    ok: boolean
    errorCode?: AgentToolErrorCode
    durationMs: number
    retries: number
    evidenceIds: string[]
    permissionDecision: "allowed" | "denied"
    startedAt: number
}

export type AgentSkillTrace = {
    skillId: string
    loadedAt: number
    toolIds: string[]
    viaDependency?: boolean
}

export type AgentDelegationTrace = {
    taskId: string
    objective: string
    status: DelegationResult["status"]
    depth: number
    durationMs: number
    evidenceCount: number
    traceId: string
}

export type AgentLatencyMetrics = {
    ttftMs?: number
    totalMs?: number
    llmMs?: number
    toolMs?: number
    subAgentMs?: number
    retrievalMs?: number
    rerankMs?: number
}

export type AgentTrace = {
    runId: string
    conversationId: string
    userId: string
    model: string
    routingHint?: RoutingHint
    complexity: TaskComplexity
    steps: AgentTraceEvent[]
    toolCalls: AgentToolTrace[]
    skillLoads: AgentSkillTrace[]
    delegations: AgentDelegationTrace[]
    evidenceIds: string[]
    tokenUsage: AgentTokenUsage
    latency: AgentLatencyMetrics
    startedAt: number
    completedAt?: number
    totalLatencyMs?: number
    stopReason?: AgentStopReason
}

// ============================================================================
// Runtime 入参 / 出参（§3）
// ============================================================================

export type AgentRuntimeInput = {
    conversationId: string
    userId: string
    workspaceId?: string
    /** 已由 Context Manager 之外的层准备好的对话消息 */
    messages: unknown[]
    model: string
    abortSignal?: AbortSignal
}

export type AgentRuntimeResult = {
    runId: string
    answer: string
    state: AgentState
    trace: AgentTrace
}
