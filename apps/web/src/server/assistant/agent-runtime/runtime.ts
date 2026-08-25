import { BudgetTracker } from "./budget"
import { assessAnswerQuality, dedupeRepeatedAnswer } from "./answer-quality"
import { readAgentFeatureFlags, resolveContextBudget, resolveStopPolicy } from "./config"
import { ContextManager, type ConversationSummary } from "./context-manager"
import { DelegationManager } from "./delegation"
import { AgentError, normalizeAgentError } from "./errors"
import { evaluateRun, type AgentRunEval } from "./eval"
import { EvidenceStore } from "./evidence"
import { AgentEventEmitter, type AgentEventSink } from "./events"
import { buildFinalAnswerPlan } from "./final-answer"
import { newRunId } from "./ids"
import { LoopDetector } from "./loop-detector"
import { runAgentSegment, SegmentController } from "./mastra-bridge"
import { ObservationStore } from "./observation"
import { DefaultPermissionResolver, type PermissionResolver } from "./permissions"
import { allowsDelegation, detectComplexity, shouldCreatePlan } from "./planner"
import { agentSkillRegistry, type AgentSkillRegistry } from "./skill-registry"
import { SkillLoader } from "./skill-loader"
import { AgentStateStore } from "./state"
import { StopPolicy } from "./stop-policy"
import { SubAgentRuntime, type NestedAgentRunner } from "./subagent-runtime"
import { agentToolRegistry, type AgentToolRegistry } from "./tool-registry"
import { ToolExecutor, type ToolRunOutcome } from "./tool-executor"
import { TraceCollector } from "./trace"
import {
    annotateNormalQaWikiMentions,
    collectWikiMentionTargets,
    mergeWikiMentionTargets,
    type WikiMentionTarget,
} from "./wiki-mentions"
import type {
    AgentRuntimeServices,
    AgentState,
    AgentStopReason,
    AgentToolDefinition,
    AgentToolTrace,
    AgentTrace,
    DelegateTaskInput,
    DelegationResult,
    PlanUpdateOp,
    RoutingHint,
    SkillLoadResult,
    TaskComplexity,
    ToolExecutionContext,
} from "./types"

/**
 * Petrichor Agent Runtime（§3/§9/§157）。
 *
 * 主循环：Reason → Select Action → Execute → Observe → Update State → Reflect →
 * Finish / Continue / Delegate / Re-plan。
 *
 * 底层工具调用循环复用 Mastra（见 mastra-bridge）；本文件只负责编排与收敛，
 * 具体能力都在各自模块里，避免 runtime.ts 变成巨型文件（§111）。
 */

export type AgentRunRequest = {
    conversationId: string
    userId: number
    /** DB 侧 assistant run id，用于步骤落库与审计 */
    dbRunId?: number
    threadId?: number
    workspaceId?: string
    systemRole?: string | null
    focus?: unknown
    /** 问答模式：wiki 时优先走 Wiki 检索工具，并以 [[pageKey|标题]] 内联引用 */
    qaMode?: "normal" | "wiki"
    /** 普通问答流式输出前加载真实 Wiki 实体/概念词典；由 HTTP 入口按用户与 focus 注入。 */
    loadWikiMentionTargets?: () => Promise<WikiMentionTarget[]>
    goal: string
    /** 已裁剪的模型消息 */
    messages?: unknown[]
    model: unknown
    modelName: string
    /** HTTP 请求进入时间，用于让 TTFT/总延迟覆盖鉴权、上下文构建等前置阶段 */
    startedAt?: number
    conversationSummary?: ConversationSummary | null
    /** buildContextPack 复用的持久摘要与相关历史片段 */
    conversationBackground?: string | null
    routingHint?: RoutingHint | null
    turnCount?: number
    abortSignal?: AbortSignal
    injectionGuard?: { providerKey: string; modelId: string } | null
    isOperator?: boolean
    /** 副作用工具确认策略 */
    confirmSideEffect?: (tool: AgentToolDefinition, input: unknown) => Promise<boolean>
    onEvent?: AgentEventSink
    contextTokenLimit?: number
    /** 工具执行落 Trace 后的回调；chat-handler 用它写既有 assistant_step 表（§108） */
    onToolTrace?: (trace: AgentToolTrace) => void
}

export type AgentRunResult = {
    runId: string
    answer: string
    state: AgentState
    trace: AgentTrace
    evaluation: AgentRunEval
}

export type AgentRuntimeDeps = {
    tools?: AgentToolRegistry
    skills?: AgentSkillRegistry
    permissions?: PermissionResolver
    /** 嵌套 Agent 执行器；默认走 Mastra */
    runNested?: NestedAgentRunner
}

/** 一次 Run 内最多重启多少段推理，防止 skill 反复加载导致空转 */
const MAX_SEGMENTS = 8

/**
 * Router 提示的最低可用置信度。
 * 规则路由在完全无信号时会兜底返回「全部读域 + 0.3」，那不是判断，是默认值，
 * 拿它预热能力只会平白把工具集撑大、把复杂度抬高。
 */
const ROUTER_HINT_MIN_CONFIDENCE = 0.5

const SIMPLE_KNOWLEDGE_PATTERN = /(?:是什么|什么意思|是干什么(?:的)?|有(?:哪些|什么)(?:主要|核心)?功能|怎么用|如何使用|使用方法|用途|作用|介绍|概述|说明|教程|原理|区别)/i
const SCOPED_KNOWLEDGE_FACT_PATTERN = /(?:是否|能否|能不能|支不支持|支持(?:什么|哪些)?|在哪里|哪个|多少)/i
const NON_KNOWLEDGE_ACTION_PATTERN = /(?:创建|新建|修改|更新|删除|移动|发布|分享|保存|导出|写一篇|生成一篇|改写|翻译|发邮件|联网|外部资料|网页搜索|历史对话|记住)/i
const SYSTEM_OVERVIEW_PATTERN = /(?:(?:有多少|多少|几个|数量|清单|列出).{0,12}(?:知识库|文档库|文章|文档|对话)|(?:知识库|文档库|文章|文档|对话).{0,12}(?:有多少|多少|几个|数量|清单))/i
const PROMPT_INJECTION_PATTERN = /(?:忽略.{0,16}(?:以上|之前|系统|开发者)(?:指令|提示)|(?:ignore|disregard).{0,24}(?:previous|system|developer).{0,12}(?:instruction|prompt)|system\s*prompt|developer\s*message|jailbreak|越狱)/i

/**
 * Wiki 问答模式（参考 Tencent/WeKnora 的 Wiki 检索策略）：
 * 先看概览掌握全貌 → 多关键词搜索定位页面（带命中片段）→ 读页面全文并沿关联页面多跳；
 * 回答正文必须用 [[pageKey|标题]] 内联引用用到的页面，前端会把它们渲染成
 * 带手绘波浪线的可点击链接，读者点开即可查看页面内容。
 */
const WIKI_QA_MODE_GUIDANCE = [
    "## Wiki 问答模式",
    "当前是「Wiki 问答」：优先依据知识库的 Wiki 页面回答，而不是原始分片。",
    "检索策略：",
    "1. 回答内容型问题前，先用 wiki_overview 掌握全貌（主题与知识页 / 源文档页两组目录）。",
    "2. 定位页面用 search_wiki_pages：queries 一次传多个关键词（同义概念、别名词一起搜），从 pageKey、摘要与命中片段判断相关性；不要只用单个宽泛词。",
    "3. 对最相关页面调用 read_wiki_page_detail 读全文；返回里的 links/inLinks 是关联页面（带摘要），相关就继续读，形成多跳推理。若 Wiki 页面信息不足需要读源文档补充，回答时仍要引用对应的 Wiki 页面。",
    "4. 【引用格式（最重要）】答案正文中凡是来自某个 Wiki 页面的信息，必须用 [[pageKey|原文中的词语]] 包住正文里的首次提及，例如：[[concept-mole|Mole]] 是一款开源清理工具。严禁写成“Mole 是一款工具 [[concept-mole|Mole]]”这种句末重复标题；pageKey 必须来自检索结果，严禁编造。",
    "5. 不要输出 [1]、[2] 这类数字角标来标注 Wiki 来源——本模式一律用 [[..]] 内联引用，前端会渲染成可点击的波浪线链接；同一页面多次提及时首次引用即可。",
    "6. 严禁编造或使用 Wiki 之外的知识；检索不到就如实说明，不要杜撰。",
].join("\n")

/**
 * 高频简单知识问答快车道。
 *
 * 它只负责决定是否可以先做一次只读检索；真正未命中时仍回到完整 Agentic Loop。
 * 明显的写操作、外部研究和提示注入文本都不进入该路径。
 */
export function shouldUseSimpleKnowledgeFastPath(input: {
    goal: string
    complexity: TaskComplexity
    focus?: unknown
    routingHint?: RoutingHint | null
}): boolean {
    const goal = input.goal.trim()
    if (input.complexity !== "simple" || !goal || goal.length > 160) return false
    if (NON_KNOWLEDGE_ACTION_PATTERN.test(goal)
        || SYSTEM_OVERVIEW_PATTERN.test(goal)
        || PROMPT_INJECTION_PATTERN.test(goal)) return false

    if (SIMPLE_KNOWLEDGE_PATTERN.test(goal)) return true

    const focus = input.focus as { knowledgeBaseId?: unknown; articleId?: unknown } | null | undefined
    const hasKnowledgeScope = Boolean(focus?.knowledgeBaseId != null
        || focus?.articleId != null
        || ((input.routingHint?.confidence ?? 0) >= 0.7
            && input.routingHint?.domains.includes("knowledge")))
    return hasKnowledgeScope && SCOPED_KNOWLEDGE_FACT_PATTERN.test(goal)
}

export class PetrichorAgentRuntime {
    private readonly tools: AgentToolRegistry
    private readonly skills: AgentSkillRegistry
    private readonly permissions: PermissionResolver
    private readonly runNested: NestedAgentRunner | undefined

    constructor(deps: AgentRuntimeDeps = {}) {
        this.tools = deps.tools ?? agentToolRegistry
        this.skills = deps.skills ?? agentSkillRegistry
        this.permissions = deps.permissions
            ?? new DefaultPermissionResolver((toolId) => this.tools.get(toolId))
        this.runNested = deps.runNested
    }

    async run(request: AgentRunRequest): Promise<AgentRunResult> {
        const runId = newRunId()
        const flags = readAgentFeatureFlags()
        const startedAt = request.startedAt ?? Date.now()

        // ---------------------------------------------------------- 基础设施
        const events = new AgentEventEmitter(runId, request.onEvent)
        const trace = new TraceCollector(
            runId,
            request.conversationId,
            String(request.userId),
            request.modelName,
            startedAt,
        )
        trace.event("run_started", { goal: request.goal })
        events.emit("agent_started", {
            goal: request.goal,
            model: request.modelName,
            conversationId: request.conversationId,
        })

        // Router 只作提示，且失败不影响主流程（§5/§84/§128）
        const routingHint = flags.softRouter ? request.routingHint ?? null : null
        if (routingHint) trace.setRoutingHint(routingHint)
        // 低置信度提示（规则路由无信号时会兜底返回全部读域）只留作 Trace/Eval，
        // 不用来预热能力、也不参与复杂度判定——否则每个问题都会被判成"跨多个域"
        const actionableHint = routingHint && routingHint.confidence >= ROUTER_HINT_MIN_CONFIDENCE
            ? routingHint
            : null

        // ------------------------------------------------------------ 复杂度
        const complexityDecision = detectComplexity({
            goal: request.goal,
            routingHint: actionableHint,
            ...(request.turnCount != null ? { turnCount: request.turnCount } : {}),
            hasFocus: Boolean(request.focus),
        })
        const complexity = complexityDecision.complexity
        trace.setComplexity(complexity, complexityDecision.reason)
        events.emit("complexity_detected", {
            complexity,
            ...(routingHint ? { routingHint } : {}),
            reason: complexityDecision.reason,
        })

        // ------------------------------------------------------------ 状态层
        const state = new AgentStateStore({
            runId,
            conversationId: request.conversationId,
            userId: String(request.userId),
            goal: request.goal,
            complexity,
        })
        const observations = new ObservationStore()
        const evidence = new EvidenceStore()
        const budget = new BudgetTracker(complexity, { now: startedAt })
        const stopConfig = resolveStopPolicy(complexity)
        const loopDetector = new LoopDetector({ noProgressThreshold: stopConfig.maxNoProgressIterations + 1 })
        const stopPolicy = new StopPolicy(stopConfig, budget, loopDetector)
        const contextManager = new ContextManager(resolveContextBudget(request.contextTokenLimit))

        // 普通问答在开始流式输出前先把真实 Wiki 实体/概念词典交给前端。
        // 前端据此在 Markdown 渲染阶段原位补波浪线，不需要等回答结束后清空重画。
        let catalogWikiMentionTargets: WikiMentionTarget[] = []
        if (request.qaMode !== "wiki" && request.loadWikiMentionTargets) {
            try {
                catalogWikiMentionTargets = await request.loadWikiMentionTargets()
                events.emit("wiki_mention_targets", { targets: catalogWikiMentionTargets })
            } catch (error) {
                trace.event("observation", {
                    strategy: "wiki_mention_catalog",
                    degraded: error instanceof Error ? error.message : String(error),
                })
            }
        }

        const executor = new ToolExecutor({
            registry: this.tools,
            permissions: this.permissions,
            observations,
            evidence,
            state,
            trace,
            loopDetector,
            events,
            ...(request.confirmSideEffect ? { confirmSideEffect: request.confirmSideEffect } : {}),
            ...(request.onToolTrace ? { onToolTrace: request.onToolTrace } : {}),
            clampTimeout: (desired) => budget.clampToolTimeout(desired),
        })

        const skillLoader = new SkillLoader({
            skills: this.skills,
            tools: this.tools,
            permissions: this.permissions,
            state,
            trace,
            events,
        })

        const subAgents = new SubAgentRuntime({
            tools: this.tools,
            skills: this.skills,
            permissions: this.permissions,
            trace,
            events,
            ...(request.onToolTrace ? { onToolTrace: request.onToolTrace } : {}),
            runNested: this.runNested ?? this.defaultNestedRunner(request),
        })

        const delegation = new DelegationManager({
            subAgents,
            state,
            evidence,
            stopPolicy,
            budget,
            events,
            // 委派授权范围取"用户有权使用"的全集：主 Agent 本可自行加载这些能力，委派不构成提权
            getParentToolIds: () => this.delegatableToolIds(request.isOperator === true),
            selectContextEvidence: () => evidence.topN(6),
        })

        // -------------------------------------------------------- 段级控制器
        let segmentController = new SegmentController()
        let stopReason: AgentStopReason | undefined
        let stopDetail: string | undefined

        const services: AgentRuntimeServices = {
            loadSkill: async (skillId: string): Promise<SkillLoadResult> => {
                if (!flags.dynamicSkills) {
                    return {
                        ok: false,
                        skillId,
                        loaded: [],
                        alreadyLoaded: [],
                        toolIds: [],
                        error: { code: "SKILL_NOT_FOUND", message: "动态技能已关闭", retryable: false },
                    }
                }
                const result = await skillLoader.load(skillId, buildCtx())
                // 新工具只在下一段生效，因此加载成功后立即请求换段
                if (result.ok && result.loaded.length > 0) {
                    segmentController.request(`skill_loaded:${skillId}`)
                }
                return result
            },
            listSkills: () =>
                this.skills.list().map((skill) => ({
                    id: skill.id,
                    name: skill.name,
                    description: skill.description,
                    loaded: state.hasSkill(skill.id),
                })),
            delegate: async (inputs: DelegateTaskInput[]): Promise<DelegationResult[]> => {
                if (!flags.delegation || !allowsDelegation(complexity)) {
                    return inputs.map((input) => ({
                        taskId: "",
                        status: "failed" as const,
                        summary: `当前任务不适合委派（复杂度 ${complexity}），请直接处理：${input.objective}`,
                        evidence: [],
                        traceId: "",
                    }))
                }
                return await delegation.delegateMany(inputs, buildCtx())
            },
            getPlan: () => state.current.plan,
            updatePlan: (ops: PlanUpdateOp[]) => {
                const changed = applyPlanOps(state, ops)
                trace.event("plan_updated", { steps: state.current.plan })
                events.emit("plan_updated", { steps: state.current.plan, changed })
                return state.current.plan
            },
            requestSegmentRestart: (reason: string) => segmentController.request(reason),
            remainingToolCalls: () => stopPolicy.remainingToolCalls(state.current),
        }

        const buildCtx = (): ToolExecutionContext => ({
            runId,
            userId: request.userId,
            conversationId: request.conversationId,
            ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
            ...(request.focus !== undefined ? { focus: request.focus } : {}),
            ...(request.qaMode === "wiki" ? { qaMode: "wiki" as const } : {}),
            systemRole: request.systemRole ?? null,
            delegationDepth: 0,
            state: state.current,
            ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
            ...(request.dbRunId != null ? { dbRunId: request.dbRunId } : {}),
            ...(request.threadId != null ? { threadId: request.threadId } : {}),
            services,
        })

        // ------------------------------------------------------------ 预加载
        // Router hint 只用于预加载，命中与否都不影响 Agent 后续自主加载（§5/§15）
        if (flags.dynamicSkills && actionableHint?.domains.length) {
            await skillLoader.preload(mapDomainsToSkills(actionableHint.domains, this.skills.ids), buildCtx())
        }

        // ------------------------------------------------ 简单知识问答快车道
        // 定义/功能/用法类问题不需要让模型先后决定 search 与 read_many。
        // 先通过统一 ToolExecutor 执行一次只读复合检索；命中后只保留一轮无工具生成，
        // 未命中或读取失败则原样回到完整 Agentic Loop。
        // Wiki 模式不走快车道：它面向分片/章节，而 Wiki 模式要求页面级检索与 [[..]] 引用。
        let simpleKnowledgeFastPath = false
        if (request.qaMode !== "wiki"
            && !request.abortSignal?.aborted
            && this.tools.has("knowledge.lookup")
            && shouldUseSimpleKnowledgeFastPath({
                goal: request.goal,
                complexity,
                focus: request.focus,
                routingHint,
            })) {
            const outcome = await executor.execute("knowledge.lookup", { query: request.goal }, buildCtx())
            simpleKnowledgeFastPath = outcome.ok && outcome.evidence.length > 0
            trace.event("observation", {
                strategy: "simple_knowledge_fast_path",
                hit: simpleKnowledgeFastPath,
                evidenceCount: outcome.evidence.length,
            })
        }

        // ------------------------------------------------------------ 计划
        if (shouldCreatePlan(complexity)) {
            const steps = state.setPlan(draftPlan(request.goal))
            trace.event("plan_created", { steps })
            events.emit("plan_created", { steps })
        }

        // ------------------------------------------------------ 主 Agentic Loop
        let answer = ""
        let segments = 0
        let fatal: AgentError | null = null

        try {
            while (segments < MAX_SEGMENTS) {
                if (request.abortSignal?.aborted) {
                    stopReason = "cancelled"
                    break
                }

                const before = stopPolicy.evaluateBeforeIteration(state.current)
                if (before.stop) {
                    stopReason = before.reason
                    stopDetail = before.detail
                    break
                }

                segments += 1
                state.incrementIteration()
                segmentController = new SegmentController()

                const tools = simpleKnowledgeFastPath
                    ? []
                    : this.resolveActiveTools(skillLoader, complexity, request.isOperator === true, request.qaMode)
                const built = contextManager.build({
                    state: state.current,
                    observations,
                    evidence,
                    skillInstructions: skillLoader.loadedInstructions,
                    skillCatalog: this.skills.list(),
                    tools,
                    recentMessages: request.messages ?? [],
                    conversationSummary: request.conversationSummary ?? null,
                    conversationBackground: request.conversationBackground ?? null,
                    routingHint: actionableHint,
                    ...(request.qaMode === "wiki" ? { modeGuidance: WIKI_QA_MODE_GUIDANCE, qaMode: "wiki" as const } : {}),
                    remainingToolCalls: stopPolicy.remainingToolCalls(state.current),
                })

                let answerStarted = false
                const segment = await runAgentSegment(
                    {
                        agentId: "petrichor-agent",
                        agentName: "Petrichor Agent",
                        model: request.model,
                        instructions: built.instructions,
                        ...(request.messages?.length
                            ? { messages: contextManager.trimConversation(request.messages) }
                            : { prompt: request.goal }),
                        tools,
                        ctx: buildCtx(),
                        executor,
                        maxSteps: simpleKnowledgeFastPath
                            ? 1
                            : Math.max(1, stopPolicy.remainingToolCalls(state.current) || 1),
                        ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
                        // 快车道已经排除了明显注入文本，且这一段没有任何工具/副作用能力；
                        // 不再额外调用一次 LLM 注入分类器，否则安全检查本身会成为主要延迟。
                        injectionGuard: simpleKnowledgeFastPath ? null : request.injectionGuard ?? null,
                        ...(request.contextTokenLimit ? { contextTokenLimit: request.contextTokenLimit } : {}),
                        onTextDelta: (delta) => {
                            if (!answerStarted) {
                                answerStarted = true
                                // 新的一段作答开始；不带 replace，前端会保留上一段
                                events.emit("final_answer_started", {})
                                trace.markFirstToken()
                            }
                            events.emit("final_answer_delta", { delta })
                        },
                        onAnswerReset: () => {
                            // 刚才那段是"我来读一下正文"这类过程话，后面还有工具调用。
                            // 服务端只把最后一段当作最终答案（见 mastra-bridge），前端也必须
                            // 丢弃已经流出的过程话；否则 Run 结束前它会被归档进可见正文。
                            if (!answerStarted) return
                            answerStarted = false
                            events.emit("final_answer_started", { replace: true })
                        },
                        onToolOutcome: (outcome: ToolRunOutcome) => {
                            const decision = stopPolicy.evaluateAfterToolCall(state.current)
                            if (decision.stop) {
                                stopReason = decision.reason
                                stopDetail = decision.detail
                                segmentController.request(`stop_policy:${decision.reason}`)
                            }
                            void outcome
                        },
                    },
                    segmentController,
                )

                state.addTokenUsage(segment.usage)
                trace.addTokenUsage(segment.usage)
                trace.addLlmLatency(segment.llmMs)

                if (segment.aborted) {
                    stopReason = "cancelled"
                    answer = segment.text.trim() || answer
                    break
                }

                // 段正常结束且产出文本 → 该文本就是答案
                if (!segment.stopped) {
                    answer = segment.text.trim()
                    if (answer) {
                        stopReason ??= "goal_completed"
                        break
                    }
                    // 没有文本也没有中止：模型无话可说，进入强制收敛
                    stopReason ??= "enough_evidence"
                    break
                }

                // 因停止策略中止 → 不再继续循环，进入强制收敛
                if (segment.stopped.reason.startsWith("stop_policy:")) break

                // 因加载技能中止 → 带着新能力继续下一段
                answer = ""
            }

            if (segments >= MAX_SEGMENTS && !answer) {
                stopReason ??= "max_iterations"
                stopDetail ??= `已达最大推理段数 ${MAX_SEGMENTS}`
            }

            // --------------------------------------------- 已作答但内容明显草率
            // 主 Agent 在同一 Mastra 段内完成工具调用后可以直接输出答案；过去只要非空就交付，
            // 导致“读了多个章节，最后只压成一句话”。质量门只在证据丰富且回答明显不足时重写，
            // 正常答案和用户明确要求简短的场景都不会增加一次 LLM 调用。
            if (answer && evidence.size > 0 && (stopReason === "goal_completed" || stopReason === "enough_evidence")) {
                const quality = assessAnswerQuality({
                    goal: request.goal,
                    answer,
                    evidence: evidence.all,
                })
                trace.event("answer_quality_checked", {
                    adequate: quality.adequate,
                    depth: quality.depth,
                    answerChars: quality.answerChars,
                    contentUnits: quality.contentUnits,
                    evidenceChars: quality.evidenceChars,
                    reasons: quality.reasons,
                })
                if (!quality.adequate) {
                    const originalAnswer = answer
                    const rewritten = await this.synthesizeFinalAnswer({
                        request,
                        state,
                        evidence,
                        observations,
                        ...(stopReason ? { stopReason } : {}),
                        events,
                        trace,
                        replacePrevious: true,
                    })
                    answer = rewritten.trim() || originalAnswer
                }
            }

            // --------------------------------------------------- 强制收敛作答
            if (!answer && stopReason !== "cancelled") {
                answer = await this.synthesizeFinalAnswer({
                    request,
                    state,
                    evidence,
                    observations,
                    ...(stopReason ? { stopReason } : {}),
                    events,
                    trace,
                })
            }
        } catch (error) {
            fatal = error instanceof AgentError ? error : normalizeAgentError(error, "TOOL_EXECUTION_ERROR")
            stopReason = fatal.code === "TOOL_ABORTED" ? "cancelled" : "fatal_error"
            trace.event("error", { code: fatal.code, message: fatal.message })
        }

        if (answer) answer = dedupeRepeatedAnswer(answer)

        // 普通问答的 [n] 来源角标与 Wiki 实体波浪线是两套语义：前者证明结论，
        // 后者只是可点击的知识导航。最终完成前用本轮真实检索结果做一次确定性补标，
        // 同时修复旧提示词曾生成的句末“[[pageKey|标题]]”伪角标。
        if (answer && request.qaMode !== "wiki" && stopReason !== "cancelled") {
            const retrievedTargets = collectWikiMentionTargets(
                evidence.all,
                observations.all,
                (item) => evidence.citationIndex(item.id),
            )
            const wikiTargets = mergeWikiMentionTargets(catalogWikiMentionTargets, retrievedTargets)
            const catalogAnnotated = annotateNormalQaWikiMentions(answer, catalogWikiMentionTargets)
            const annotated = annotateNormalQaWikiMentions(answer, wikiTargets)
            // 只有本轮检索结果真的改变渲染文本时才更新词典，例如补上 citationIndex
            // 将旧式句末 Wiki 伪角标恢复成 [n]；常规回答结束时不做无效的二次渲染。
            if (annotated !== catalogAnnotated) {
                events.emit("wiki_mention_targets", { targets: wikiTargets })
            }
            if (annotated !== answer) answer = annotated
        }

        // ------------------------------------------------------------- 收尾
        const metrics = {
            durationMs: Date.now() - startedAt,
            toolCalls: state.current.toolCallCount,
            evidenceCount: evidence.size,
            subAgentCount: budget.subAgentCount,
            iterations: state.current.iteration,
        }

        if (stopReason === "cancelled") {
            state.finish("cancelled", "cancelled")
            events.emit("agent_cancelled", { metrics })
        } else if (fatal) {
            state.finish("failed", stopReason ?? "fatal_error")
            events.emit("agent_error", { message: "执行过程中出现问题", errorCode: fatal.code })
        } else if (stopReason && stopReason !== "goal_completed" && stopReason !== "enough_evidence") {
            state.finish("stopped", stopReason)
            events.emit("agent_stopped", {
                stopReason,
                message: stopDetail ?? "任务已停止",
                metrics,
            })
        } else {
            state.finish("completed", stopReason ?? "goal_completed")
        }

        if (answer) events.emit("final_answer_completed", { text: answer })
        events.emit("agent_completed", {
            status: state.current.status,
            ...(state.current.stopReason ? { stopReason: state.current.stopReason } : {}),
            metrics,
        })

        trace.recordEvidenceIds(evidence.all.map((item) => item.id))
        trace.event("final_answer", { length: answer.length })
        trace.finish(state.current.stopReason)

        const finalState = state.snapshot()
        const finalTrace = trace.build()

        return {
            runId,
            answer,
            state: finalState,
            trace: finalTrace,
            evaluation: evaluateRun({ state: finalState, trace: finalTrace, answer }),
        }
    }

    /** 当前可用工具：核心工具 ∪ 已加载技能解锁的工具（§10） */
    private resolveActiveTools(
        skillLoader: SkillLoader,
        complexity: TaskComplexity,
        isOperator: boolean,
        qaMode?: "normal" | "wiki",
    ): AgentToolDefinition[] {
        if (complexity === "direct") return []
        const ids = new Set([...this.tools.coreToolIds({ isOperator }), ...skillLoader.activeToolIds])
        if (qaMode === "wiki") {
            // Wiki 模式按需解锁带 wiki 标签的工具，不占用常态核心工具名额（§10）
            for (const tool of this.tools.list({ namespace: "knowledge" })) {
                if (tool.tags?.includes("wiki")) ids.add(tool.id)
            }
        }
        return [...ids]
            .map((id) => this.tools.get(id))
            .filter((tool): tool is AgentToolDefinition => {
                if (!tool) return false
                if (tool.requiresOperator && !isOperator) return false
                return true
            })
    }

    /** 可委派给子代理的工具全集：排除元工具与明确禁止子代理使用的工具 */
    private delegatableToolIds(isOperator: boolean): string[] {
        return this.tools
            .list({ isOperator })
            .filter((tool) => (tool.allowedInSubAgent ?? true) && tool.namespace !== "agent")
            .map((tool) => tool.id)
    }

    /** 强制收敛：无工具的一次生成，只基于证据作答（§102） */
    private async synthesizeFinalAnswer(input: {
        request: AgentRunRequest
        state: AgentStateStore
        evidence: EvidenceStore
        observations: ObservationStore
        stopReason?: AgentStopReason
        events: AgentEventEmitter
        trace: TraceCollector
        /** 同一个问题重答一遍：前端要丢弃上一版，而不是追加到它后面 */
        replacePrevious?: boolean
    }): Promise<string> {
        // 强制收敛也要遵守 Wiki 模式的引用规范（[[pageKey|标题]] 替代 [n] 角标）
        const plan = buildFinalAnswerPlan({
            state: input.state.current,
            evidence: input.evidence,
            observations: input.observations,
            ...(input.stopReason ? { stopReason: input.stopReason } : {}),
            ...(input.request.qaMode === "wiki" ? { wikiMode: true } : {}),
        })

        const controller = new SegmentController()
        let started = false
        const segment = await runAgentSegment(
            {
                agentId: "petrichor-agent-final",
                agentName: "Petrichor Agent",
                model: input.request.model,
                instructions: plan.instructions,
                prompt: input.request.goal,
                tools: [],
                ctx: {
                    runId: input.state.current.runId,
                    userId: input.request.userId,
                    conversationId: input.request.conversationId,
                    delegationDepth: 0,
                    state: input.state.current,
                },
                executor: null as never,
                maxSteps: 1,
                ...(input.request.abortSignal ? { abortSignal: input.request.abortSignal } : {}),
                injectionGuard: null,
                onTextDelta: (delta) => {
                    if (!started) {
                        started = true
                        // 质量重写要覆盖掉上一版答案；强制收敛只是接着往下说
                        input.events.emit("final_answer_started", {
                            ...(input.replacePrevious ? { replace: true } : {}),
                        })
                        input.trace.markFirstToken()
                    }
                    input.events.emit("final_answer_delta", { delta })
                },
            },
            controller,
        )

        input.state.addTokenUsage(segment.usage)
        input.trace.addTokenUsage(segment.usage)
        input.trace.addLlmLatency(segment.llmMs)
        return segment.text.trim()
    }

    /** 默认嵌套执行器：同样走 Mastra，但工具集受限、上下文隔离 */
    private defaultNestedRunner(request: AgentRunRequest): NestedAgentRunner {
        return async (nested) => {
            const controller = new SegmentController()
            const segment = await runAgentSegment(
                {
                    agentId: nested.agentId,
                    agentName: nested.agentName,
                    model: request.model,
                    instructions: nested.instructions,
                    prompt: nested.prompt,
                    tools: nested.tools,
                    ctx: nested.ctx,
                    executor: nested.executor,
                    maxSteps: nested.maxSteps,
                    ...(nested.abortSignal ? { abortSignal: nested.abortSignal } : {}),
                    injectionGuard: null,
                },
                controller,
            )
            return {
                text: segment.text,
                toolCalls: segment.toolCallCount,
                usage: segment.usage,
            }
        }
    }
}

/** 域名 → 技能预加载映射（仅提示用途） */
export function mapDomainsToSkills(domains: string[], availableSkillIds: string[]): string[] {
    const alias: Record<string, string> = {
        knowledge: "knowledge",
        doc_library: "documents",
        document: "documents",
        documents: "documents",
        system: "system",
        content_write: "writer",
        write: "writer",
        writer: "writer",
        admin: "admin",
        research: "research",
        graph: "graph",
        memory: "memory",
    }
    const out = new Set<string>()
    for (const domain of domains) {
        const skillId = alias[domain]
        if (skillId && availableSkillIds.includes(skillId)) out.add(skillId)
    }
    return [...out]
}

/** 复杂任务的初始计划草案：只给骨架，Agent 会按观察不断改写（§7） */
export function draftPlan(goal: string): Array<{ goal: string }> {
    return [
        { goal: `明确「${truncate(goal, 40)}」需要哪些信息` },
        { goal: "检索并阅读相关资料" },
        { goal: "核对信息是否足够、是否存在冲突" },
        { goal: "综合形成结论" },
    ]
}

function truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max)}…` : value
}

export function applyPlanOps(state: AgentStateStore, ops: PlanUpdateOp[]): string[] {
    const changed: string[] = []
    for (const op of ops) {
        switch (op.op) {
            case "set": {
                const steps = state.setPlan(op.steps)
                changed.push(...steps.map((step) => step.id))
                break
            }
            case "add": {
                const step = state.addPlanStep({
                    goal: op.goal,
                    ...(op.afterId ? { afterId: op.afterId } : {}),
                    ...(op.dependsOn ? { dependsOn: op.dependsOn } : {}),
                })
                changed.push(step.id)
                break
            }
            case "update": {
                const step = state.updatePlanStep(op.id, {
                    ...(op.goal != null ? { goal: op.goal } : {}),
                    ...(op.status != null ? { status: op.status } : {}),
                    ...(op.resultSummary != null ? { resultSummary: op.resultSummary } : {}),
                })
                if (step) changed.push(step.id)
                break
            }
            case "remove": {
                if (state.removePlanStep(op.id)) changed.push(op.id)
                break
            }
            case "reorder": {
                state.reorderPlan(op.orderedIds)
                changed.push(...op.orderedIds)
                break
            }
        }
    }
    return changed
}

/** 进程内默认实例 */
export const petrichorAgentRuntime = new PetrichorAgentRuntime()
