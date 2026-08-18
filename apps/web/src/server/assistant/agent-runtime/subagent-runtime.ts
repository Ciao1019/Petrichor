import { SUBAGENT_DEFAULT_TIMEOUT_MS } from "./config"
import { AgentError, normalizeAgentError } from "./errors"
import { EvidenceStore } from "./evidence"
import type { AgentEventEmitter } from "./events"
import { newId } from "./ids"
import { LoopDetector } from "./loop-detector"
import { ObservationStore } from "./observation"
import { intersectToolScope, type PermissionResolver } from "./permissions"
import type { AgentSkillRegistry } from "./skill-registry"
import { AgentStateStore } from "./state"
import { ToolExecutor } from "./tool-executor"
import type { AgentToolRegistry } from "./tool-registry"
import type { TraceCollector } from "./trace"
import type {
    AgentEvidence,
    AgentToolDefinition,
    AgentToolTrace,
    DelegateTaskInput,
    DelegationResult,
    ToolExecutionContext,
} from "./types"

/**
 * SubAgent 运行时（§49/§52/§54/§55/§148）。
 *
 * 统一原 research-subagent / write-subagent / nested-agent 的调度层：
 * - 独立上下文，只注入 objective + 必要 context + 相关证据 + 授权工具；
 * - 工具范围是父级的子集，禁止提权；
 * - 必须返回结构化 Evidence，而不是一段没有来源的总结。
 */

export type NestedRunRequest = {
    agentId: string
    agentName: string
    instructions: string
    prompt: string
    /** 已解析成 Mastra 工具的定义列表 */
    tools: AgentToolDefinition[]
    maxSteps: number
    timeoutMs: number
    ctx: ToolExecutionContext
    executor: ToolExecutor
    abortSignal?: AbortSignal
}

export type NestedRunResult = {
    text: string
    toolCalls: number
    usage?: { input: number; output: number; total: number }
}

/** 由 mastra-bridge 提供的嵌套 Agent 执行器，避免 runtime 与 Mastra 强耦合 */
export type NestedAgentRunner = (request: NestedRunRequest) => Promise<NestedRunResult>

export type SubAgentRuntimeDeps = {
    tools: AgentToolRegistry
    skills: AgentSkillRegistry
    permissions: PermissionResolver
    trace: TraceCollector
    runNested: NestedAgentRunner
    events?: AgentEventEmitter
    /** 子代理的工具调用同样要写进既有 assistant_step 表 */
    onToolTrace?: (trace: AgentToolTrace) => void
}

/** 子代理默认禁止的能力：再委派与确认卡由主 Agent 负责 */
const SUBAGENT_BLOCKED_TOOL_IDS = new Set(["agent.delegate", "agent.request_confirmation"])

export class SubAgentRuntime {
    constructor(private readonly deps: SubAgentRuntimeDeps) {}

    async run(
        input: DelegateTaskInput,
        parentCtx: ToolExecutionContext,
        options: {
            depth: number
            /** 父级实际可用的工具 id，子代理只能取子集 */
            parentToolIds: string[]
            /** 需要带给子代理的证据（§55：只给相关的，不复制全量对话） */
            contextEvidence?: AgentEvidence[]
            timeoutMs?: number
            allowRespawn?: boolean
        },
    ): Promise<DelegationResult> {
        const taskId = newId("task")
        const traceId = newId("trace")
        const startedAt = Date.now()

        const toolIds = this.resolveToolScope(input, options.parentToolIds, options.allowRespawn === true)
        if (toolIds.length === 0) {
            const durationMs = Date.now() - startedAt
            this.deps.trace.recordDelegation({
                taskId,
                objective: input.objective,
                status: "failed",
                depth: options.depth,
                durationMs,
                evidenceCount: 0,
                traceId,
            })
            return {
                taskId,
                status: "failed",
                summary: "没有可用于该子任务的工具，已放弃委派，请由主 Agent 直接处理。",
                evidence: [],
                traceId,
                durationMs,
                errorCode: "SUBAGENT_FAILED",
            }
        }

        // 子代理拥有独立 State / Observation / Evidence / LoopDetector
        const state = new AgentStateStore({
            conversationId: parentCtx.conversationId,
            userId: String(parentCtx.userId),
            goal: input.objective,
            complexity: "multi_step",
        })
        const observations = new ObservationStore()
        const evidence = new EvidenceStore()
        const loopDetector = new LoopDetector()

        const executor = new ToolExecutor({
            registry: this.deps.tools,
            permissions: this.deps.permissions,
            observations,
            evidence,
            state,
            trace: this.deps.trace,
            loopDetector,
            allowedToolIds: toolIds,
            ...(this.deps.onToolTrace ? { onToolTrace: this.deps.onToolTrace } : {}),
        })

        const ctx: ToolExecutionContext = {
            ...parentCtx,
            delegationDepth: options.depth,
            state: state.current,
        }

        const tools = toolIds
            .map((id) => this.deps.tools.get(id))
            .filter((tool): tool is AgentToolDefinition => tool != null)

        this.deps.events?.emit("delegation_started", {
            taskId,
            objective: input.objective,
            depth: options.depth,
        })

        try {
            const result = await this.deps.runNested({
                agentId: `petrichor-subagent-${options.depth}`,
                agentName: "Petrichor SubAgent",
                instructions: buildSubAgentInstructions(input, tools, options.contextEvidence ?? []),
                prompt: input.objective,
                tools,
                maxSteps: input.maxToolCalls ?? 8,
                timeoutMs: options.timeoutMs ?? SUBAGENT_DEFAULT_TIMEOUT_MS,
                ctx,
                executor,
                ...(parentCtx.abortSignal ? { abortSignal: parentCtx.abortSignal } : {}),
            })

            const summary = result.text.trim()
            const collected = evidence.all
            // 子代理若只给了文字结论没有证据，把结论本身降级为一条 subagent 证据，
            // 保证主 Agent 至少能追溯到"这是子代理说的"
            const returned = collected.length > 0
                ? collected
                : summary
                    ? [
                        {
                            id: newId("ev"),
                            source: "subagent" as const,
                            title: input.objective.slice(0, 80),
                            content: summary,
                            createdAt: Date.now(),
                            confidence: 0.4,
                            metadata: { taskId },
                        },
                    ]
                    : []

            const durationMs = Date.now() - startedAt
            const status: DelegationResult["status"] = summary ? "completed" : "stopped"

            this.deps.trace.recordDelegation({
                taskId,
                objective: input.objective,
                status,
                depth: options.depth,
                durationMs,
                evidenceCount: returned.length,
                traceId,
            })
            this.deps.events?.emit("delegation_completed", {
                taskId,
                status,
                summary: summary || "子任务未产出结论",
                evidenceCount: returned.length,
                durationMs,
            })

            return {
                taskId,
                status,
                summary: summary || "子任务未产出可用结论",
                evidence: returned,
                traceId,
                toolCallCount: result.toolCalls,
                durationMs,
            }
        } catch (error) {
            const agentError = error instanceof AgentError ? error : normalizeAgentError(error, "SUBAGENT_FAILED")
            const durationMs = Date.now() - startedAt
            // 子代理挂了不能拖垮主 Agent（§141）：把已收集证据一并交回
            const partial = evidence.all

            this.deps.trace.recordDelegation({
                taskId,
                objective: input.objective,
                status: "failed",
                depth: options.depth,
                durationMs,
                evidenceCount: partial.length,
                traceId,
            })
            this.deps.events?.emit("delegation_failed", {
                taskId,
                message: "子任务未能完成，主流程继续",
                durationMs,
            })

            return {
                taskId,
                status: "failed",
                summary: `子任务失败：${agentError.message}`,
                evidence: partial,
                traceId,
                durationMs,
                errorCode: agentError.code,
            }
        }
    }

    /**
     * 工具范围求交（§52/§148）：请求 ∩ 父级有权使用 ∩ 允许子代理使用。
     *
     * 注意"父级有权使用"指的是权限层面的可用集合，而不是主 Agent 当前已解锁的工具：
     * 主 Agent 本来就可以自己 load_skill("research")，因此把 research 子任务委派出去
     * 不构成提权。真实权限仍由 ToolExecutor 的 PermissionResolver 逐次校验。
     */
    private resolveToolScope(
        input: DelegateTaskInput,
        parentToolIds: string[],
        allowRespawn: boolean,
    ): string[] {
        const fromSkills = new Set<string>()
        for (const skillId of input.skillIds ?? []) {
            for (const skill of this.deps.skills.resolveWithDependencies(skillId)) {
                for (const toolId of skill.toolIds) fromSkills.add(toolId)
            }
        }

        // 未指定能力时给一组保守的只读检索工具，而不是继承主 Agent 的全部工具
        const requested = input.allowedToolIds?.length
            ? input.allowedToolIds
            : fromSkills.size > 0
                ? [...fromSkills]
                : this.defaultReadOnlyToolIds(parentToolIds)

        return intersectToolScope(parentToolIds, requested, this.deps.tools.ids).filter((id) => {
            if (!allowRespawn && SUBAGENT_BLOCKED_TOOL_IDS.has(id)) return false
            const tool = this.deps.tools.get(id)
            if (!tool) return false
            // 默认不给子代理副作用工具，除非调用方显式点名
            if (tool.sideEffect && !input.allowedToolIds?.includes(id)) return false
            return tool.allowedInSubAgent !== false
        })
    }

    private static readonly READ_ONLY_NAMESPACES = new Set(["knowledge", "research", "graph", "document"])

    private defaultReadOnlyToolIds(parentToolIds: string[]): string[] {
        return parentToolIds.filter((id) => {
            const tool = this.deps.tools.get(id)
            if (!tool || tool.sideEffect) return false
            return SubAgentRuntime.READ_ONLY_NAMESPACES.has(tool.namespace)
        })
    }
}

export function buildSubAgentInstructions(
    input: DelegateTaskInput,
    tools: AgentToolDefinition[],
    contextEvidence: AgentEvidence[],
): string {
    const sections = [
        "你是 Petrichor 的研究子代理，只负责完成下面这一个明确子任务，然后把结论交回主 Agent。",
        "",
        "## 子任务目标",
        input.objective,
    ]

    if (input.context) {
        sections.push("", "## 背景", input.context)
    }

    if (contextEvidence.length > 0) {
        sections.push(
            "",
            "## 已有相关证据（来自主 Agent，可直接使用，不必重复检索）",
            contextEvidence
                .slice(0, 8)
                .map((evidence, index) => `[${index + 1}] ${evidence.title ?? "未命名"}\n${evidence.content.slice(0, 600)}`)
                .join("\n\n"),
        )
    }

    sections.push(
        "",
        "## 可用工具",
        tools.map((tool) => `- ${tool.id}：${tool.description}`).join("\n"),
        "",
        "## 要求",
        "- 只做这一个子任务，不要扩展范围，不要回答主 Agent 没问的问题。",
        "- 结论必须基于工具返回的内容，明确写出来源（标题 / 链接 / 节点）。",
        "- 检索不到就如实说明，不要编造。",
        "- 不要声称执行了任何写入、删除或配置变更。",
        input.expectedOutput ? `- 期望产出：${input.expectedOutput}` : "- 用中文给出简洁、可直接被引用的结论。",
    )

    return sections.join("\n")
}
