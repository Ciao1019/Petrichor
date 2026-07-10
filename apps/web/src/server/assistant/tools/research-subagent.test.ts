import { describe, expect, it } from "vitest"
import {
    buildSubagentStepPrefix,
    filterSubagentToolNames,
    resolveSpawnDepthPolicy,
    sanitizeResearchDomains,
    SPAWN_RESEARCH_SUBAGENT,
    SUBAGENT_ABSOLUTE_MAX_DEPTH,
    SUBAGENT_DEFAULT_MAX_DEPTH,
    spawnResearchInputSchema,
} from "./research-subagent"

describe("research subagent helpers", () => {
    it("sanitizeResearchDomains 剔除写域并去重", () => {
        expect(sanitizeResearchDomains(["knowledge", "knowledge", "admin" as never])).toEqual(["knowledge"])
        expect(sanitizeResearchDomains(["content_write"])).toEqual(["knowledge", "doc_library", "system"])
    })

    it("默认过滤掉再委派；allowRespawn 时保留", () => {
        expect(filterSubagentToolNames([
            "search_knowledge",
            SPAWN_RESEARCH_SUBAGENT,
            "save_answer_artifact",
            "show_citations",
        ])).toEqual(["search_knowledge", "show_citations"])

        expect(filterSubagentToolNames([
            "search_knowledge",
            SPAWN_RESEARCH_SUBAGENT,
            "show_citations",
        ], { allowRespawn: true })).toEqual([
            "search_knowledge",
            SPAWN_RESEARCH_SUBAGENT,
            "show_citations",
        ])
    })

    it("spawn 入参需要 goal 与 domains，并接受 depth/maxDepth", () => {
        expect(spawnResearchInputSchema.safeParse({ goal: "找 Mole", domains: ["knowledge"] }).success).toBe(true)
        expect(spawnResearchInputSchema.safeParse({
            goal: "找 Mole",
            domains: ["knowledge"],
            depth: 1,
            maxDepth: 1,
        }).success).toBe(true)
        expect(spawnResearchInputSchema.safeParse({ goal: "", domains: ["knowledge"] }).success).toBe(false)
        expect(spawnResearchInputSchema.safeParse({ goal: "x", domains: [] }).success).toBe(false)
        expect(spawnResearchInputSchema.safeParse({
            goal: "x",
            domains: ["knowledge"],
            maxDepth: 3,
        }).success).toBe(false)
    })
})

describe("resolveSpawnDepthPolicy", () => {
    it("主助手默认 depth=0、maxDepth=1", () => {
        expect(resolveSpawnDepthPolicy({}, {})).toEqual({
            depth: 0,
            maxDepth: SUBAGENT_DEFAULT_MAX_DEPTH,
        })
    })

    it("子代理 ctx 再 spawn 时 depth+1，并夹紧 maxDepth", () => {
        expect(resolveSpawnDepthPolicy(
            { spawnDepth: 0, spawnMaxDepth: 1 },
            {},
        )).toEqual({ depth: 1, maxDepth: 1 })

        expect(resolveSpawnDepthPolicy(
            {},
            { maxDepth: 9 },
        )).toEqual({ depth: 0, maxDepth: SUBAGENT_ABSOLUTE_MAX_DEPTH })
    })

    it("显式 depth 优先于 ctx 递推", () => {
        expect(resolveSpawnDepthPolicy(
            { spawnDepth: 0 },
            { depth: 0, maxDepth: 1 },
        )).toEqual({ depth: 0, maxDepth: 1 })
    })
})

describe("buildSubagentStepPrefix", () => {
    it("depth0 无后缀，更深带 /dN", () => {
        expect(buildSubagentStepPrefix(0)).toBe(SPAWN_RESEARCH_SUBAGENT)
        expect(buildSubagentStepPrefix(1)).toBe(`${SPAWN_RESEARCH_SUBAGENT}/d1`)
    })
})

describe("spawnResearchSubagent depth guard", () => {
    it("depth > maxDepth 时 soft-fail 且不依赖模型", async () => {
        const { spawnResearchSubagent } = await import("./research-subagent")
        const result = await spawnResearchSubagent(
            { userId: 1, threadId: 1, runId: 1, focus: null },
            { goal: "越界", domains: ["knowledge"], depth: 2, maxDepth: 1 },
        )
        expect(result).toMatchObject({
            ok: false,
            errorCode: "subagent_depth_exceeded",
            depth: 2,
            maxDepth: 1,
        })
    })
})
