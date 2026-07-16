import { z } from "zod"
import type { AssistantToolRegistration } from "../domain-types"
import { assistantFocusSchema } from "../thread-logic"
import {
    spawnResearchSubagent,
    type SpawnResearchResult,
} from "./research-subagent"

export const SPAWN_RESEARCH_FANOUT = "spawn_research_fanout"
export const RESEARCH_FANOUT_MAX_TASKS = 3

const fanoutTaskSchema = z.object({
    goal: z.string().trim().min(1).max(2000),
    domains: z.array(z.enum(["knowledge", "doc_library", "system", "content_write", "admin"])).min(1).max(3),
    focus: assistantFocusSchema.optional().nullable(),
})

const fanoutSchema = z.object({
    tasks: z.array(fanoutTaskSchema).min(1).max(RESEARCH_FANOUT_MAX_TASKS),
})

export const spawnResearchFanoutInputSchema = fanoutSchema

export type SpawnResearchFanoutResult = {
    ok: boolean
    results: SpawnResearchResult[]
    usage: {
        tasks: number
        calls: number
        totalTokens: number
        succeeded: number
        failed: number
    }
    errorCode?: string | null
}

export function assertFanoutTaskCount(count: number): void {
    if (count < 1 || count > RESEARCH_FANOUT_MAX_TASKS) {
        throw new Error(`fanout tasks 数量必须在 1..${RESEARCH_FANOUT_MAX_TASKS}`)
    }
}

export async function spawnResearchFanout(
    ctx: Parameters<typeof spawnResearchSubagent>[0],
    raw: unknown,
): Promise<SpawnResearchFanoutResult> {
    const input = fanoutSchema.parse(raw ?? {})
    assertFanoutTaskCount(input.tasks.length)

    const results = await Promise.all(
        input.tasks.map(async (task) => await spawnResearchSubagent(ctx, {
            goal: task.goal,
            domains: task.domains,
            focus: task.focus,
            // fanout 工人不再嵌套，避免并行×深度爆炸
            depth: 0,
            maxDepth: 0,
        })),
    )

    const calls = results.reduce((sum, item) => sum + (item.usage?.calls ?? 0), 0)
    const totalTokens = results.reduce((sum, item) => sum + (item.usage?.totalTokens ?? 0), 0)
    const succeeded = results.filter((item) => item.ok).length
    const failed = results.length - succeeded
    const allAborted = results.length > 0
        && results.every((item) => item.errorCode === "aborted")

    return {
        ok: succeeded > 0,
        results,
        usage: {
            tasks: results.length,
            calls,
            totalTokens,
            succeeded,
            failed,
        },
        errorCode: allAborted
            ? "aborted"
            : succeeded > 0
                ? null
                : "fanout_all_failed",
    }
}

export const researchFanoutTools: AssistantToolRegistration[] = [
    {
        name: SPAWN_RESEARCH_FANOUT,
        domain: "system",
        risk: "read",
        description:
            `并行派发 1..${RESEARCH_FANOUT_MAX_TASKS} 个只读研究子代理。传入 tasks[{goal, domains}]；返回 results[] 供主助手汇总。不要用于写入；子任务不再嵌套委派。`,
        inputSchema: fanoutSchema,
        execute: async (ctx, input) => await spawnResearchFanout(ctx, input),
    },
]
