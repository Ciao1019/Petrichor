import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/server/auth/current-user", () => ({ requireCurrentUser: vi.fn() }))
vi.mock("@/server/ai/generation", () => ({ createChatLanguageModel: vi.fn() }))

import { buildAssistantSystemPrompt } from "../chat-handler"
import type { AssistantToolContext } from "../domain-types"
import {
    clearAssistantToolRegistryForTests,
    loadToolsForDomains,
} from "../tool-registry"
import { readonlyAssistantTools, registerReadonlyAssistantTools, registerAllAssistantTools, allAssistantTools } from "."

const ctx: AssistantToolContext = {
    userId: 1,
    threadId: 2,
    runId: 3,
    focus: null,
}

const LOCKED_TOOL_NAMES = [
    "list_knowledge_bases",
    "search_knowledge",
    "read_knowledge_node",
    "list_doc_libraries",
    "search_documents",
    "read_document",
    "list_system_overview",
    "show_progress",
    "show_citations",
    "show_data_table",
    "save_answer_artifact",
    "upsert_plan",
    "spawn_research_subagent",
    "spawn_research_fanout",
].sort()

describe("readonly assistant tool registration", () => {
    beforeEach(() => {
        clearAssistantToolRegistryForTests()
        registerReadonlyAssistantTools()
    })

    it("注册工具集合与契约 4.3 恰好相等", () => {
        expect(readonlyAssistantTools.map((tool) => tool.name).sort()).toEqual(LOCKED_TOOL_NAMES)
        expect(Object.keys(loadToolsForDomains(["knowledge", "doc_library", "system"], ctx)).sort())
            .toEqual(LOCKED_TOOL_NAMES)
    })

    it("按域装载子集，并保证只有 save_answer_artifact 为 write", () => {
        expect(Object.keys(loadToolsForDomains(["knowledge", "system"], ctx)).sort()).toEqual([
            "list_knowledge_bases",
            "list_system_overview",
            "read_knowledge_node",
            "save_answer_artifact",
            "search_knowledge",
            "show_citations",
            "show_data_table",
            "show_progress",
            "spawn_research_fanout",
            "spawn_research_subagent",
            "upsert_plan",
        ])
        expect(readonlyAssistantTools.filter((tool) => tool.risk === "write").map((tool) => tool.name))
            .toEqual(["save_answer_artifact"])
        expect(readonlyAssistantTools.some((tool) => tool.domain === "content_write" || tool.domain === "admin"))
            .toBe(false)
    })
})

describe("assistant domain-aware system prompt", () => {
    it("knowledge+system 提示先检索再阅读并调用引用工具", () => {
        const prompt = buildAssistantSystemPrompt(["knowledge", "system"])
        expect(prompt).toContain("search_knowledge")
        expect(prompt).toContain("read_knowledge_node")
        expect(prompt).toContain("show_citations")
        expect(prompt).toContain("不要编造")
        expect(prompt).toContain("media.src")
        expect(prompt).toContain("s4key:")
        expect(prompt).toContain("站内上传无法展示")
    })

    it("doc_library+system 提示支持检索、翻页和引用", () => {
        const prompt = buildAssistantSystemPrompt(["doc_library", "system"])
        expect(prompt).toContain("search_documents")
        expect(prompt).toContain("read_document")
        expect(prompt).toContain("fromIndex")
        expect(prompt).toContain("show_citations")
    })

    it("纯 system 元问题不注入知识库或文档库检索说明", () => {
        const prompt = buildAssistantSystemPrompt(["system"])
        expect(prompt).toContain("list_system_overview")
        expect(prompt).toContain("spawn_research_subagent")
        expect(prompt).toContain("spawn_research_fanout")
        expect(prompt).not.toContain("search_knowledge")
        expect(prompt).not.toContain("search_documents")
    })

    it("content_write 提示含确认纪律", () => {
        const prompt = buildAssistantSystemPrompt(["content_write", "system"])
        expect(prompt).toContain("request_user_confirmation")
        expect(prompt).toContain("create_article")
        expect(prompt).toContain("delete_article")
        expect(prompt).toContain("spawn_write_subagent")
        expect(prompt).toContain("proposedActions")
    })
})

describe("content_write tool registration", () => {
    beforeEach(() => {
        clearAssistantToolRegistryForTests()
        registerAllAssistantTools()
    })

    it("content_write 装载含确认与写工具，不含危险工具名", () => {
        const names = Object.keys(loadToolsForDomains(["content_write"], ctx)).sort()
        expect(names).toEqual([
            "create_article",
            "create_article_share",
            "request_user_confirmation",
            "spawn_write_subagent",
            "update_article",
        ])
        expect(allAssistantTools.filter((tool) => tool.risk === "dangerous" && tool.domain === "content_write").map((t) => t.name).sort()).toEqual([
            "delete_article",
            "delete_document",
            "revoke_article_share",
        ])
    })
})
