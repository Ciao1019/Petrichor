import { describe, expect, it } from "vitest"
import { SPAWN_RESEARCH_SUBAGENT } from "./research-subagent"
import {
    filterWriteSubagentToolNames,
    normalizeProposedWriteActions,
    SPAWN_WRITE_SUBAGENT,
    spawnWriteInputSchema,
} from "./write-subagent"

describe("write subagent helpers", () => {
    it("过滤掉写/危险/委派/确认工具", () => {
        expect(filterWriteSubagentToolNames([
            "search_knowledge",
            "create_article",
            "move_article",
            "delete_article",
            SPAWN_WRITE_SUBAGENT,
            SPAWN_RESEARCH_SUBAGENT,
            "request_user_confirmation",
            "show_citations",
        ])).toEqual(["search_knowledge", "show_citations"])
    })

    it("normalizeProposedWriteActions 只保留白名单并标注 risk", () => {
        expect(normalizeProposedWriteActions([
            { toolName: "create_article", input: { knowledgeBaseId: 1, title: "A" }, reason: "新建" },
            { toolName: "move_article", input: { articleId: 9, targetKnowledgeBaseId: 2 } },
            { toolName: "delete_article", input: { articleId: 2 } },
            { toolName: "delete_ai_provider", input: { providerId: 3 } },
            { toolName: "create_article", input: { knowledgeBaseId: 1, title: "A" } },
        ])).toEqual([
            {
                toolName: "create_article",
                input: { knowledgeBaseId: 1, title: "A" },
                reason: "新建",
                risk: "write",
            },
            {
                toolName: "move_article",
                input: { articleId: 9, targetKnowledgeBaseId: 2 },
                risk: "write",
            },
            {
                toolName: "delete_article",
                input: { articleId: 2 },
                risk: "dangerous",
            },
        ])
    })

    it("spawn 入参需要 goal", () => {
        expect(spawnWriteInputSchema.safeParse({ goal: "写一篇部署说明" }).success).toBe(true)
        expect(spawnWriteInputSchema.safeParse({ goal: "" }).success).toBe(false)
        expect(spawnWriteInputSchema.safeParse({
            goal: "删文",
            proposedActions: [{ toolName: "delete_article", input: { articleId: "1" } }],
        }).success).toBe(true)
    })

    it("常量名锁定", () => {
        expect(SPAWN_WRITE_SUBAGENT).toBe("spawn_write_subagent")
    })
})
