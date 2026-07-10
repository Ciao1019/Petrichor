import { beforeEach, describe, expect, it, vi } from "vitest"

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock("./research-subagent", async () => {
    const actual = await vi.importActual<typeof import("./research-subagent")>("./research-subagent")
    return {
        ...actual,
        spawnResearchSubagent: spawnMock,
    }
})

import {
    assertFanoutTaskCount,
    RESEARCH_FANOUT_MAX_TASKS,
    SPAWN_RESEARCH_FANOUT,
    spawnResearchFanout,
    spawnResearchFanoutInputSchema,
} from "./research-fanout"

describe("research fanout helpers", () => {
    beforeEach(() => {
        spawnMock.mockReset()
    })

    it("tasks 必须 1..3", () => {
        expect(spawnResearchFanoutInputSchema.safeParse({ tasks: [] }).success).toBe(false)
        expect(spawnResearchFanoutInputSchema.safeParse({
            tasks: [
                { goal: "a", domains: ["knowledge"] },
                { goal: "b", domains: ["knowledge"] },
                { goal: "c", domains: ["knowledge"] },
                { goal: "d", domains: ["knowledge"] },
            ],
        }).success).toBe(false)
        expect(spawnResearchFanoutInputSchema.safeParse({
            tasks: [{ goal: "a", domains: ["knowledge"] }],
        }).success).toBe(true)
        expect(() => assertFanoutTaskCount(0)).toThrow()
        expect(() => assertFanoutTaskCount(RESEARCH_FANOUT_MAX_TASKS + 1)).toThrow()
    })

    it("并行调用 spawnResearchSubagent 且 maxDepth=0", async () => {
        spawnMock
            .mockResolvedValueOnce({
                ok: true,
                summary: "A",
                usage: { calls: 2, totalTokens: 10 },
            })
            .mockResolvedValueOnce({
                ok: false,
                summary: "B failed",
                usage: { calls: 1, totalTokens: 3 },
                errorCode: "tool_error",
            })

        const result = await spawnResearchFanout(
            { userId: 1, threadId: 2, runId: 3, focus: null },
            {
                tasks: [
                    { goal: "任务A", domains: ["knowledge"] },
                    { goal: "任务B", domains: ["doc_library"] },
                ],
            },
        )

        expect(spawnMock).toHaveBeenCalledTimes(2)
        expect(spawnMock).toHaveBeenNthCalledWith(
            1,
            expect.anything(),
            expect.objectContaining({ goal: "任务A", depth: 0, maxDepth: 0 }),
        )
        expect(result.ok).toBe(true)
        expect(result.results).toHaveLength(2)
        expect(result.usage).toEqual({
            tasks: 2,
            calls: 3,
            totalTokens: 13,
            succeeded: 1,
            failed: 1,
        })
        expect(SPAWN_RESEARCH_FANOUT).toBe("spawn_research_fanout")
    })

    it("全部失败时 ok=false", async () => {
        spawnMock.mockResolvedValue({
            ok: false,
            summary: "x",
            usage: { calls: 0, totalTokens: 0 },
        })
        const result = await spawnResearchFanout(
            { userId: 1, threadId: 2, runId: 3, focus: null },
            { tasks: [{ goal: "x", domains: ["system"] }] },
        )
        expect(result.ok).toBe(false)
        expect(result.errorCode).toBe("fanout_all_failed")
    })
})
