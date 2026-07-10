import { describe, expect, it } from "vitest"
import {
    filterSubagentToolNames,
    sanitizeResearchDomains,
    SPAWN_RESEARCH_SUBAGENT,
    spawnResearchInputSchema,
} from "./research-subagent"

describe("research subagent helpers", () => {
    it("sanitizeResearchDomains 剔除写域并去重", () => {
        expect(sanitizeResearchDomains(["knowledge", "knowledge", "admin" as never])).toEqual(["knowledge"])
        expect(sanitizeResearchDomains(["content_write"])).toEqual(["knowledge", "doc_library", "system"])
    })

    it("filterSubagentToolNames 去掉委派与写工具", () => {
        expect(filterSubagentToolNames([
            "search_knowledge",
            SPAWN_RESEARCH_SUBAGENT,
            "save_answer_artifact",
            "show_citations",
        ])).toEqual(["search_knowledge", "show_citations"])
    })

    it("spawn 入参需要 goal 与 domains", () => {
        expect(spawnResearchInputSchema.safeParse({ goal: "找 Mole", domains: ["knowledge"] }).success).toBe(true)
        expect(spawnResearchInputSchema.safeParse({ goal: "", domains: ["knowledge"] }).success).toBe(false)
        expect(spawnResearchInputSchema.safeParse({ goal: "x", domains: [] }).success).toBe(false)
    })
})
