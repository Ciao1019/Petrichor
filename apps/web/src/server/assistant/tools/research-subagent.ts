import { z } from "zod"
import { badRequest } from "@/server/http/response"
import type { AgentDomainId, AssistantFocus, AssistantToolContext, AssistantToolRegistration } from "../domain-types"
import { assistantFocusSchema } from "../thread-logic"
import {
    asNestedRecord,
    readNestedTotalTokens,
    runNestedAgentGenerate,
} from "./nested-agent"

export const SUBAGENT_MAX_STEPS = 6
export const SUBAGENT_TIMEOUT_MS = 90_000
export const SPAWN_RESEARCH_SUBAGENT = "spawn_research_subagent"
/** 契约 4.4：默认只允许一层再委派 */
export const SUBAGENT_DEFAULT_MAX_DEPTH = 1
/** 契约锁定硬上限 */
export const SUBAGENT_ABSOLUTE_MAX_DEPTH = 2

const READ_ONLY_DOMAINS = new Set<AgentDomainId>(["knowledge", "doc_library", "system"])

/** 子代理默认禁止：再委派（可由 allowRespawn 放开）、写产物、改计划、确认卡 */
const BLOCKED_SUBAGENT_TOOLS = new Set([
    SPAWN_RESEARCH_SUBAGENT,
    "spawn_research_fanout",
    "spawn_write_subagent",
    "save_answer_artifact",
    "upsert_plan",
    "request_user_confirmation",
    "create_article",
    "update_article",
    "create_article_share",
    "move_article",
    "bind_ai_model",
    "list_ai_models",
    "list_agent_api_keys",
    "get_public_qa_setting",
])

const spawnSchema = z.object({
    goal: z.string().trim().min(1).max(2000),
    domains: z.array(z.enum(["knowledge", "doc_library", "system", "content_write", "admin"])).min(1).max(3),
    focus: assistantFocusSchema.optional().nullable(),
    depth: z.number().int().min(0).max(SUBAGENT_ABSOLUTE_MAX_DEPTH).optional(),
    maxDepth: z.number().int().min(0).max(SUBAGENT_ABSOLUTE_MAX_DEPTH).optional(),
})

export const spawnResearchInputSchema = spawnSchema

export type SpawnResearchResult = {
    ok: boolean
    summary: string
    citations?: Array<{ title: string; href?: string; domain?: string; snippet?: string }>
    usage?: { calls: number; totalTokens: number }
    steps?: Array<{ toolName: string; ok: boolean; errorCode?: string | null }>
    depth?: number
    maxDepth?: number
    errorCode?: string | null
}

export type SpawnDepthPolicy = {
    depth: number
    maxDepth: number
}

export function resolveSpawnDepthPolicy(
    ctx: Pick<AssistantToolContext, "spawnDepth" | "spawnMaxDepth">,
    input: { depth?: number; maxDepth?: number },
): SpawnDepthPolicy {
    const maxDepth = Math.min(
        input.maxDepth ?? ctx.spawnMaxDepth ?? SUBAGENT_DEFAULT_MAX_DEPTH,
        SUBAGENT_ABSOLUTE_MAX_DEPTH,
    )
    const depth = typeof input.depth === "number"
        ? input.depth
        : typeof ctx.spawnDepth === "number"
            ? ctx.spawnDepth + 1
            : 0
    return { depth, maxDepth }
}

export function sanitizeResearchDomains(domains: string[]): AgentDomainId[] {
    const next = [...new Set(
        domains.filter((d): d is AgentDomainId => READ_ONLY_DOMAINS.has(d as AgentDomainId)),
    )]
    if (next.length === 0) return ["knowledge", "doc_library", "system"]
    return next
}

export function filterSubagentToolNames(
    toolNames: string[],
    options?: { allowRespawn?: boolean },
): string[] {
    return toolNames.filter((name) => {
        if (name === SPAWN_RESEARCH_SUBAGENT) return Boolean(options?.allowRespawn)
        return !BLOCKED_SUBAGENT_TOOLS.has(name)
    })
}

export function buildSubagentStepPrefix(depth: number): string {
    return depth > 0
        ? `${SPAWN_RESEARCH_SUBAGENT}/d${depth}`
        : SPAWN_RESEARCH_SUBAGENT
}

function buildSubagentInstructions(goal: string, depth: number, maxDepth: number): string {
    const lines = [
        "你是 Petrichor 站内只读研究子代理。只通过工具检索与阅读，汇总给主助手。",
        "禁止声称已写入、删除或改配置；没有的工具不要假装调用。",
        "优先 search → read；最终用中文给出简洁结论，并尽量调用 show_citations（href 必须来自工具结果）。",
        `本轮目标：${goal}`,
        `委派深度：depth=${depth}，maxDepth=${maxDepth}。`,
    ]
    if (depth < maxDepth) {
        lines.push("若目标可再拆成独立只读子任务，可再次调用 spawn_research_subagent；不要无意义嵌套。")
    } else {
        lines.push("已达再委派上限，不要尝试再次 spawn_research_subagent。")
    }
    return lines.join("\n")
}

export async function spawnResearchSubagent(
    ctx: AssistantToolContext,
    raw: unknown,
): Promise<SpawnResearchResult> {
    const input = spawnSchema.parse(raw ?? {})
    if (input.domains.some((d) => d === "content_write" || d === "admin")) {
        throw badRequest("子代理 domains 仅允许 knowledge / doc_library / system")
    }
    const { depth, maxDepth } = resolveSpawnDepthPolicy(ctx, input)
    if (depth > maxDepth) {
        return {
            ok: false,
            summary: `子代理深度超限：depth=${depth} > maxDepth=${maxDepth}，请由上层汇总或降低嵌套。`,
            usage: { calls: 0, totalTokens: 0 },
            depth,
            maxDepth,
            errorCode: "subagent_depth_exceeded",
        }
    }

    const domains = sanitizeResearchDomains(input.domains)
    const focus = (input.focus ?? ctx.focus) as AssistantFocus | null
    const allowRespawn = depth < maxDepth
    const stepPrefix = buildSubagentStepPrefix(depth)

    const subCtx: AssistantToolContext = {
        userId: ctx.userId,
        threadId: ctx.threadId,
        runId: ctx.runId,
        focus,
        spawnDepth: depth,
        spawnMaxDepth: maxDepth,
    }

    try {
        const { output, toolCalls, steps } = await runNestedAgentGenerate({
            ctx: subCtx,
            agentId: "petrichor-research-subagent",
            agentName: "Petrichor Research Subagent",
            description: "Read-only research subagent for knowledge and document libraries.",
            instructions: buildSubagentInstructions(input.goal, depth, maxDepth),
            domains,
            filterToolNames: (names) => filterSubagentToolNames(names, { allowRespawn }),
            prompt: input.goal,
            maxSteps: SUBAGENT_MAX_STEPS,
            timeoutMs: SUBAGENT_TIMEOUT_MS,
            stepPrefix,
            timeoutErrorTag: "subagent_timeout",
            signal: ctx.abortSignal,
        })

        const summary = typeof output.text === "string" ? output.text.trim() : ""
        const citations = extractCitations(output) ?? []
        const totalTokens = readNestedTotalTokens(output)

        return {
            ok: Boolean(summary),
            summary: summary || "子代理未产出可读结论",
            ...(citations.length > 0 ? { citations } : {}),
            usage: { calls: toolCalls, totalTokens },
            steps,
            depth,
            maxDepth,
            errorCode: summary ? null : "empty_summary",
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const aborted = message.includes("aborted")
            || (error instanceof Error && error.name === "AbortError")
            || ctx.abortSignal?.aborted
        const errorCode = aborted
            ? "aborted"
            : message.includes("subagent_timeout")
                ? "tool_timeout"
                : "tool_error"
        return {
            ok: false,
            summary: aborted ? "子代理已取消" : `子代理失败：${message}`,
            usage: { calls: 0, totalTokens: 0 },
            depth,
            maxDepth,
            errorCode,
        }
    }
}

function extractCitations(output: { toolResults?: unknown }): SpawnResearchResult["citations"] {
    const results = Array.isArray(output.toolResults) ? output.toolResults : []
    const citations: NonNullable<SpawnResearchResult["citations"]> = []
    for (const item of results) {
        const record = asNestedRecord(item)
        const toolName = typeof record?.toolName === "string"
            ? record.toolName
            : typeof record?.name === "string"
                ? record.name
                : ""
        if (toolName !== "show_citations") continue
        const payload = asNestedRecord(record?.result) ?? asNestedRecord(record?.output) ?? record
        const list = Array.isArray(payload?.citations) ? payload.citations : []
        for (const citation of list) {
            const row = asNestedRecord(citation)
            if (!row || typeof row.title !== "string") continue
            citations.push({
                title: row.title,
                ...(typeof row.href === "string" ? { href: row.href } : {}),
                ...(typeof row.domain === "string" ? { domain: row.domain } : {}),
                ...(typeof row.snippet === "string" ? { snippet: row.snippet } : {}),
            })
        }
    }
    return citations
}

export const researchSubagentTools: AssistantToolRegistration[] = [
    {
        name: SPAWN_RESEARCH_SUBAGENT,
        domain: "system",
        risk: "read",
        description:
            "派生子代理做只读深度检索（可跨知识库/文档库）。传入 goal 与 domains（仅 knowledge/doc_library/system）；可选 depth/maxDepth（默认 maxDepth=1，允许一层再委派，硬上限 2）。返回 summary 与可选 citations；主助手据此作答，勿重复编造来源。",
        inputSchema: spawnSchema,
        execute: async (ctx, input) => await spawnResearchSubagent(ctx, input),
    },
]
