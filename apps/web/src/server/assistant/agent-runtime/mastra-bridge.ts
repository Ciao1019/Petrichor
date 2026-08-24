import { Agent } from "@mastra/core/agent"
import { createTool } from "@mastra/core/tools"
import { PromptInjectionDetector, TokenLimiterProcessor } from "@mastra/core/processors"
import { needsJsonPromptInjectionForStructuredOutput } from "@/server/ai/provider-quirks"
import type { ToolExecutor, ToolRunOutcome } from "./tool-executor"
import type { AgentToolDefinition, ToolExecutionContext } from "./types"

/**
 * Mastra 适配层（§9/§101）。
 *
 * 底层 Tool Calling Loop 复用 Mastra，不重复造轮子；
 * Petrichor Runtime 只在外层补 State / Plan / Observation / Evidence / Skill / Delegation /
 * Context / StopPolicy / LoopDetection / Trace / Budget。
 *
 * 关键约束：Mastra 执行的每个工具都被包成"转发到 ToolExecutor"，
 * 因此不存在绕过执行器的调用路径（§13）。
 */

type MastraModel = ConstructorParameters<typeof Agent>[0]["model"]
type ProcessorModel = ConstructorParameters<typeof PromptInjectionDetector>[0]["model"]

export type SegmentStopSignal = {
    /** 由 StopPolicy / SkillLoader 触发，要求提前结束本段推理 */
    reason: string
}

export type SegmentRequest = {
    agentId: string
    agentName: string
    description?: string
    model: unknown
    instructions: string
    /** 已由 Context Manager 裁剪的模型消息；为空时用 prompt */
    messages?: unknown[]
    prompt?: string
    tools: AgentToolDefinition[]
    ctx: ToolExecutionContext
    executor: ToolExecutor
    maxSteps: number
    temperature?: number
    abortSignal?: AbortSignal
    onTextDelta?: (delta: string) => void
    /**
     * 已产出的文本被判定为"中间旁白"（后面还跟着工具调用）时触发。
     * 调用方据此重置答案缓冲，避免把"我来读取正文确认细节"这类过程话当成最终答案。
     */
    onAnswerReset?: () => void
    /** 段内每次工具执行完成后回调，用于 StopPolicy 即时裁决 */
    onToolOutcome?: (outcome: ToolRunOutcome) => void
    /** 注入 Prompt Injection 检测（§88），测试环境跳过 */
    injectionGuard?: { providerKey: string; modelId: string } | null
    contextTokenLimit?: number
}

export type SegmentResult = {
    text: string
    toolCallCount: number
    usage: { input: number; output: number; total: number }
    /** 段是否被提前中止，以及原因 */
    stopped: SegmentStopSignal | null
    aborted: boolean
    llmMs: number
}

/** 段级中止控制：load_skill 或 StopPolicy 触发时提前收束本段 */
export class SegmentController {
    private readonly controller = new AbortController()
    private stopSignal: SegmentStopSignal | null = null

    get signal(): AbortSignal {
        return this.controller.signal
    }

    get stopped(): SegmentStopSignal | null {
        return this.stopSignal
    }

    /**
     * 请求结束当前段并立即中止。
     *
     * 必须同步 abort：否则 Mastra 会带着旧的 activeTools 再发一轮模型请求，
     * 刚加载的技能工具在那一轮里仍然不可见，模型会调用到不存在的工具。
     * 中止不会丢信息——工具结果、观察与证据都已写入我们自己的 Store，
     * 下一段由 ContextManager 重新组装上下文。
     */
    request(reason: string): void {
        if (this.stopSignal) return
        this.stopSignal = { reason }
        this.controller.abort()
    }
}

/** 把 Agent 工具定义包成 Mastra 工具：执行体统一转发到 ToolExecutor */
export function buildMastraTools(
    tools: AgentToolDefinition[],
    ctx: ToolExecutionContext,
    executor: ToolExecutor,
    options?: { onOutcome?: (outcome: ToolRunOutcome) => void },
): Record<string, ReturnType<typeof createTool>> {
    const out: Record<string, ReturnType<typeof createTool>> = {}
    for (const tool of tools) {
        // createTool 的泛型会把 schema 推断成 never；工具形状在 Registry 侧已校验，这里统一收敛类型
        out[tool.name] = createTool({
            id: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            execute: async (input: unknown) => {
                const outcome = await executor.execute(tool.id, input, ctx)
                options?.onOutcome?.(outcome)
                return toModelResult(outcome)
            },
        } as never) as ReturnType<typeof createTool>
    }
    return out
}

/**
 * 回给模型的紧凑结果（§17）：只给摘要 + 结构化要点，不回灌原始大对象。
 * 原始结果已经落在 Trace 里，Debug UI 可查。
 */
export function toModelResult(outcome: ToolRunOutcome): unknown {
    if (!outcome.ok) {
        return {
            ok: false,
            errorCode: outcome.error?.code,
            message: outcome.error?.message,
            suggestedActions: outcome.observation.suggestedActions ?? [],
        }
    }
    return {
        ok: true,
        summary: outcome.observation.summary,
        ...(outcome.observation.data === undefined ? {} : { data: outcome.observation.data }),
        ...(outcome.evidence.length > 0
            ? { evidence: evidenceForModel(outcome) }
            : {}),
        ...(outcome.observation.suggestedActions?.length
            ? { suggestedActions: outcome.observation.suggestedActions }
            : {}),
    }
}

const MODEL_EVIDENCE_MAX_ITEMS = 12
/** 片段类证据（章节深读、网页片段）的合计预算 */
const MODEL_EVIDENCE_MAX_CHARS = 6_000
// Mastra 会把多次 tool result 累积在同一段消息里；单条过大会在第三次 read 时挤掉用户消息。
// 1,200 字足以覆盖一个章节的核心段落，也明显高于旧实现仅给模型的 400 字 excerpt。
const MODEL_EVIDENCE_ITEM_MAX_CHARS = 1_200
/**
 * 全文类证据（fullRead）单独计预算：这类工具对模型承诺"读全文"，再按片段裁到 1,200 字，
 * 模型会发现 summary 里的字数和拿到的正文对不上，判定内容被截断并绕去读源文档。
 * 这里的上限只是异常兜底（正常 Wiki 页面几百到几千字），触发时会显式写明还剩多少。
 */
const MODEL_FULL_READ_ITEM_MAX_CHARS = 20_000
const MODEL_FULL_READ_MAX_CHARS = 40_000

/** 给段内下一次 LLM 的是精选 Evidence，不是原始输出；同时设总预算，避免大批证据挤掉用户消息。 */
function evidenceForModel(outcome: ToolRunOutcome) {
    let snippetRemaining = MODEL_EVIDENCE_MAX_CHARS
    let fullReadRemaining = MODEL_FULL_READ_MAX_CHARS
    return outcome.evidence.slice(0, MODEL_EVIDENCE_MAX_ITEMS).map((item, index) => {
        const take = item.fullRead
            ? Math.min(item.content.length, MODEL_FULL_READ_ITEM_MAX_CHARS, fullReadRemaining)
            : Math.min(item.content.length, MODEL_EVIDENCE_ITEM_MAX_CHARS, snippetRemaining)
        if (item.fullRead) fullReadRemaining -= take
        else snippetRemaining -= take
        const content = take > 0 ? withTruncationNotice(item.content, take) : ""
        return {
            ref: outcome.evidenceCitationIndices[index] ?? index + 1,
            id: item.id,
            source: item.source,
            title: item.title,
            ...(content ? { content } : {}),
            ...(item.url ? { url: item.url } : {}),
            ...(item.metadata?.path ? { path: item.metadata.path } : {}),
        }
    })
}

/**
 * 截断必须显式告知：模型只有知道"还有多少没给"，才能判断是继续追读还是就此作答；
 * 静默截断会被它当成内容缺失，从而重复检索或改读源文档。
 */
function withTruncationNotice(content: string, take: number): string {
    if (take >= content.length) return content
    return `${content.slice(0, take)}\n\n[正文过长，本次仅给出前 ${take} 字，共 ${content.length} 字]`
}

/** 执行一段推理：一次 Mastra agent.stream，内部可含多次工具调用 */
export async function runAgentSegment(
    request: SegmentRequest,
    controller: SegmentController,
): Promise<SegmentResult> {
    const tools = buildMastraTools(request.tools, request.ctx, request.executor, {
        ...(request.onToolOutcome ? { onOutcome: request.onToolOutcome } : {}),
    })

    const agent = new Agent({
        id: request.agentId,
        name: request.agentName,
        description: request.description ?? "Petrichor agent runtime",
        model: request.model as MastraModel,
        instructions: request.instructions,
        tools,
        inputProcessors: buildInputProcessors(request),
    })

    const signal = mergeSignals(controller.signal, request.abortSignal)
    const startedAt = Date.now()
    let text = ""
    let toolCallCount = 0
    let aborted = false

    try {
        const input = (request.messages?.length ? request.messages : request.prompt ?? "") as never
        const result = await agent.stream(input, {
            maxSteps: request.maxSteps,
            modelSettings: { temperature: request.temperature ?? 0.2 },
            activeTools: Object.keys(tools),
            abortSignal: signal,
            hooks: {
                afterToolCall: async () => {
                    toolCallCount += 1
                },
            },
        } as never)

        // 用 fullStream 而不是 textStream：需要看见 tool-call 才能区分
        // "回答前的旁白" 与 "真正的最终答案"。textStream 会把两者混在一起。
        const reader = (result as unknown as { fullStream: ReadableStream<{ type: string; payload?: unknown }> })
            .fullStream.getReader()
        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                if (!value || typeof value !== "object") continue

                if (value.type === "text-delta") {
                    const delta = (value.payload as { text?: unknown })?.text
                    if (typeof delta === "string" && delta) {
                        text += delta
                        request.onTextDelta?.(delta)
                    }
                    continue
                }

                // 模型在这段文本之后又去调工具 → 刚才那段是过程话，不是答案
                if (value.type === "tool-call" && text) {
                    text = ""
                    request.onAnswerReset?.()
                }
            }
        } finally {
            reader.releaseLock()
        }

        const usage = await readUsage(result)
        return {
            text,
            toolCallCount,
            usage,
            stopped: controller.stopped,
            aborted: false,
            llmMs: Date.now() - startedAt,
        }
    } catch (error) {
        // 段被主动中止（换技能 / 触发停止策略）不是错误：已产出的文本仍然保留
        if (controller.stopped || isAbort(error)) {
            aborted = request.abortSignal?.aborted === true
            return {
                text,
                toolCallCount,
                usage: { input: 0, output: 0, total: 0 },
                stopped: controller.stopped,
                aborted,
                llmMs: Date.now() - startedAt,
            }
        }
        throw error
    }
}

function buildInputProcessors(request: SegmentRequest) {
    const limiter = new TokenLimiterProcessor({
        limit: request.contextTokenLimit ?? 100_000,
        trimMode: "contiguous",
    })
    if (process.env.VITEST || !request.injectionGuard) return [limiter]

    return [
        new PromptInjectionDetector({
            model: request.model as ProcessorModel,
            strategy: "block",
            threshold: 0.85,
            detectionTypes: ["injection", "jailbreak", "system-override"],
            lastMessageOnly: true,
            ...(needsJsonPromptInjectionForStructuredOutput(
                request.injectionGuard.providerKey,
                request.injectionGuard.modelId,
            )
                ? { structuredOutputOptions: { jsonPromptInjection: true } }
                : {}),
        }),
        limiter,
    ]
}

async function readUsage(result: unknown): Promise<{ input: number; output: number; total: number }> {
    try {
        const usage = await (result as { usage?: Promise<Record<string, unknown>> }).usage
        const input = readNumber(usage, ["inputTokens", "promptTokens", "input"])
        const output = readNumber(usage, ["outputTokens", "completionTokens", "output"])
        const total = readNumber(usage, ["totalTokens", "total"]) || input + output
        return { input, output, total }
    } catch {
        return { input: 0, output: 0, total: 0 }
    }
}

function readNumber(record: Record<string, unknown> | undefined, keys: string[]): number {
    if (!record) return 0
    for (const key of keys) {
        const value = record[key]
        if (typeof value === "number" && Number.isFinite(value)) return value
    }
    return 0
}

function isAbort(error: unknown): boolean {
    if (error instanceof Error) return error.name === "AbortError" || /abort/i.test(error.message)
    return false
}

/** 合并段控制信号与外部取消信号 */
export function mergeSignals(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
    if (!secondary) return primary
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (primary.aborted || secondary.aborted) controller.abort()
    primary.addEventListener("abort", abort, { once: true })
    secondary.addEventListener("abort", abort, { once: true })
    return controller.signal
}
