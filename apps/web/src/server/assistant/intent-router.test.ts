import { beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { routeAssistantIntent } from "./intent-router"
import { clearAssistantToolRegistryForTests, registerAssistantTools } from "./tool-registry"

beforeEach(() => {
    clearAssistantToolRegistryForTests()
})

describe("routeAssistantIntent", () => {
    it("无信号时返回默认三读域", async () => {
        const result = await routeAssistantIntent({ userText: "你好", focus: null, recentToolNames: [] })
        expect(result.domains).toEqual(["system", "knowledge", "doc_library"])
        expect(result.confidence).toBeLessThan(0.5)
    })

    it("写操作意图必须包含 content_write", async () => {
        const result = await routeAssistantIntent({
            userText: "帮我删除这篇文章",
            focus: null,
            recentToolNames: [],
        })
        expect(result.domains).toContain("content_write")
        expect(result.domains).toContain("knowledge")
        expect(result.domains[0]).toBe("content_write")
    })

    it("迁移/移到 也命中 content_write", async () => {
        const migrate = await routeAssistantIntent({
            userText: "把文章 3、4 给我迁移到 Agent 框架这个知识库里边吧",
            focus: null,
            recentToolNames: [],
        })
        expect(migrate.domains).toContain("content_write")
        expect(migrate.domains).toContain("knowledge")

        const moveArticle = await routeAssistantIntent({
            userText: "move_article 不是吗",
            focus: null,
            recentToolNames: [],
        })
        expect(moveArticle.domains).toContain("content_write")
    })

    it("content_write 不再粘性；admin 粘性仍保留", async () => {
        const writeOnly = await routeAssistantIntent({
            userText: "对的",
            focus: null,
            recentToolNames: [],
            recentIntentDomains: ["content_write", "knowledge", "system"],
        })
        expect(writeOnly.domains).not.toContain("content_write")
        expect(writeOnly.rationale).not.toMatch(/sticky/)

        const adminSticky = await routeAssistantIntent({
            userText: "对的",
            focus: null,
            recentToolNames: [],
            recentIntentDomains: ["admin", "content_write"],
        })
        expect(adminSticky.domains).toContain("admin")
        expect(adminSticky.rationale).toMatch(/sticky:admin|sticky-admin/)
    })

    it("纯问答无粘性时不挂写域", async () => {
        const result = await routeAssistantIntent({
            userText: "分享一下这篇文章主要讲了什么",
            focus: { knowledgeBaseId: "1" },
            recentToolNames: [],
        })
        expect(result.domains).not.toContain("content_write")
        expect(result.domains).toContain("knowledge")
    })

    it("管理面意图包含 admin，并辅助装载 content_write", async () => {
        const result = await routeAssistantIntent({
            userText: "看一下我的模型配置",
            focus: null,
            recentToolNames: [],
        })
        expect(result.domains).toContain("admin")
        expect(result.domains).toContain("content_write")
    })

    it("focus 影响排序：同一问题在不同焦点下首位域不同", async () => {
        const userText = "这里面主要讲了什么"
        const kbResult = await routeAssistantIntent({
            userText,
            focus: { knowledgeBaseId: "1" },
            recentToolNames: [],
        })
        const docResult = await routeAssistantIntent({
            userText,
            focus: { libraryId: "2" },
            recentToolNames: [],
        })
        expect(kbResult.domains).toEqual(["knowledge", "system"])
        expect(docResult.domains).toEqual(["doc_library", "system"])
    })

    it("纯 system 元问题不反向追加 knowledge/doc_library", async () => {
        const result = await routeAssistantIntent({
            userText: "系统现在是否就绪",
            focus: null,
            recentToolNames: [],
        })
        expect(result.domains).toEqual(["system"])
    })

    it("recentToolNames 通过注册表回查延续上一轮的域", async () => {
        registerAssistantTools([{
            name: "search_documents",
            domain: "doc_library",
            risk: "read",
            description: "测试用",
            inputSchema: z.object({}),
            execute: async () => null,
        }])
        const result = await routeAssistantIntent({
            userText: "继续",
            focus: null,
            recentToolNames: ["search_documents"],
        })
        expect(result.domains).toEqual(["doc_library", "system"])
    })

    it("多信号命中时主域不超过上限，并仍可补辅助域", async () => {
        const result = await routeAssistantIntent({
            userText: "删除知识库文章并看一下我的模型配置和文档 pdf",
            focus: null,
            recentToolNames: [],
        })
        const unique = new Set(result.domains)
        expect(unique.size).toBe(result.domains.length)
        expect(result.domains.length).toBeLessThanOrEqual(4)
        expect(result.domains).toContain("content_write")
    })

    it("confidence 落在 0..1 区间", async () => {
        const result = await routeAssistantIntent({
            userText: "删除知识库里的文档并更新模型配置统计",
            focus: { knowledgeBaseId: "1", libraryId: "2" },
            recentToolNames: [],
        })
        expect(result.confidence).toBeGreaterThan(0)
        expect(result.confidence).toBeLessThanOrEqual(1)
    })
})
