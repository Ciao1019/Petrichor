import { describe, expect, it, vi } from "vitest"
import type { LanguageModel } from "ai"
import {
    classifyIntentWithLlm,
    dedupeIntentRouteParts,
    domainsEqual,
    formatIntentRouteLabel,
    INTENT_LLM_CONFIDENCE_THRESHOLD,
    INTENT_ROUTE_PART_TYPE,
    needsIntentLlm,
    routeAssistantIntentWithLlm,
    toIntentRoutePartData,
} from "./intent-llm"
import { withAuxiliaryDomains } from "./intent-router"

vi.mock("ai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>()
    return {
        ...actual,
        generateObject: vi.fn(),
    }
})

import { generateObject } from "ai"

const generateObjectMock = vi.mocked(generateObject)

describe("intent-llm", () => {
    it("needsIntentLlm：低置信或 admin 才为 true；纯 content_write 高置信不触发", () => {
        expect(needsIntentLlm({ domains: ["system"], confidence: 0.3 })).toBe(true)
        expect(needsIntentLlm({ domains: ["system"], confidence: INTENT_LLM_CONFIDENCE_THRESHOLD })).toBe(false)
        expect(needsIntentLlm({ domains: ["content_write", "knowledge"], confidence: 0.8 })).toBe(false)
        expect(needsIntentLlm({ domains: ["admin", "content_write"], confidence: 0.8 })).toBe(true)
    })

    it("formatIntentRouteLabel 含中文域与来源", () => {
        const label = formatIntentRouteLabel({
            domains: ["knowledge", "system"],
            source: "llm",
            confidence: 0.72,
        })
        expect(label).toContain("知识库")
        expect(label).toContain("系统")
        expect(label).toContain("智能识别")
        expect(label).toContain("72%")
    })

    it("toIntentRoutePartData running / done", () => {
        expect(toIntentRoutePartData({
            domains: ["system"],
            confidence: 0.3,
            source: "rules",
        }, "running")).toEqual({ status: "running", label: "正在识别意图…" })

        const done = toIntentRoutePartData({
            domains: ["knowledge", "system"],
            confidence: 0.8,
            rationale: "知识库问答",
            source: "llm",
        }, "done")
        expect(done.status).toBe("done")
        expect(done.source).toBe("llm")
        expect(done.domains).toEqual(["knowledge", "system"])
        expect(done.rationale).toBe("知识库问答")
        expect(done.label).toContain("智能识别")
    })

    it("domainsEqual 按序比较", () => {
        expect(domainsEqual(["a" as never, "b" as never], ["a" as never, "b" as never])).toBe(true)
        expect(domainsEqual(["knowledge", "system"], ["system", "knowledge"])).toBe(false)
    })

    it("dedupeIntentRouteParts 只保留最后一条", () => {
        const parts = [
            { type: INTENT_ROUTE_PART_TYPE, id: "intent-route", data: { status: "done", label: "旧" } },
            { type: "text", text: "你好" },
            { type: INTENT_ROUTE_PART_TYPE, id: "intent-route", data: { status: "done", label: "新" } },
        ]
        expect(dedupeIntentRouteParts(parts)).toEqual([
            { type: "text", text: "你好" },
            { type: INTENT_ROUTE_PART_TYPE, id: "intent-route", data: { status: "done", label: "新" } },
        ])
    })

    it("classifyIntentWithLlm 输出后补辅助域", async () => {
        generateObjectMock.mockResolvedValueOnce({
            object: {
                domains: ["knowledge"],
                confidence: 0.7,
                rationale: "用户在问知识库内容",
            },
            toJsonResponse: undefined,
        } as never)

        const result = await classifyIntentWithLlm({
            userText: "这篇文章讲什么",
            focus: { knowledgeBaseId: "1" },
            recentToolNames: [],
            rules: { domains: ["system", "knowledge", "doc_library"], confidence: 0.3 },
            model: {} as LanguageModel,
        })

        expect(result.source).toBe("llm")
        expect(result.domains).toEqual(withAuxiliaryDomains(["knowledge"]))
        expect(result.domains).toContain("system")
        expect(result.rationale).toBe("用户在问知识库内容")
    })

    it("高置信 content_write 不调用 generateObject", async () => {
        generateObjectMock.mockClear()
        const result = await routeAssistantIntentWithLlm({
            userText: "帮我删除这篇文章",
            focus: null,
            recentToolNames: [],
            model: {} as LanguageModel,
            rulesRoute: {
                domains: ["content_write", "knowledge", "system"],
                confidence: 0.8,
                rationale: "text:content_write",
            },
        })
        expect(generateObjectMock).not.toHaveBeenCalled()
        expect(result.source).toBe("rules")
        expect(result.domains).toContain("content_write")
    })

    it("LLM 失败且无 admin 时回退规则结果", async () => {
        generateObjectMock.mockRejectedValueOnce(new Error("boom"))
        const result = await routeAssistantIntentWithLlm({
            userText: "你好",
            focus: null,
            recentToolNames: [],
            model: {} as LanguageModel,
        })
        expect(result.source).toBe("rules")
        expect(result.domains).toEqual(["system", "knowledge", "doc_library"])
        expect(result.confidence).toBeLessThan(INTENT_LLM_CONFIDENCE_THRESHOLD)
    })

    it("LLM 失败且规则含 admin 时保留 admin", async () => {
        generateObjectMock.mockRejectedValueOnce(new Error("boom"))
        const result = await routeAssistantIntentWithLlm({
            userText: "看一下我的模型配置",
            focus: null,
            recentToolNames: [],
            model: {} as LanguageModel,
            rulesRoute: {
                domains: ["admin", "content_write"],
                confidence: 0.8,
                rationale: "text:admin",
            },
        })
        expect(result.source).toBe("rules")
        expect(result.domains).toContain("admin")
        expect(result.rationale).toContain("admin-domain-kept-on-llm-failure")
    })

    it("规则命中 admin 时 LLM 不得剥掉", async () => {
        generateObjectMock.mockResolvedValueOnce({
            object: {
                domains: ["knowledge"],
                confidence: 0.9,
                rationale: "只是在问知识库",
            },
            toJsonResponse: undefined,
        } as never)
        const result = await routeAssistantIntentWithLlm({
            userText: "看一下我的模型配置",
            focus: null,
            recentToolNames: [],
            model: {} as LanguageModel,
            rulesRoute: {
                domains: ["admin", "content_write"],
                confidence: 0.8,
                rationale: "text:admin",
            },
        })
        expect(result.domains).toContain("admin")
        expect(result.rationale).toContain("admin-domain-kept-from-rules")
    })

    it("传入 rulesRoute 时低置信会调 LLM", async () => {
        generateObjectMock.mockResolvedValueOnce({
            object: {
                domains: ["doc_library"],
                confidence: 0.66,
                rationale: "在问文档内容",
            },
            toJsonResponse: undefined,
        } as never)

        const result = await routeAssistantIntentWithLlm({
            userText: "继续",
            focus: null,
            recentToolNames: [],
            model: {} as LanguageModel,
            rulesRoute: {
                domains: ["system", "knowledge", "doc_library"],
                confidence: 0.3,
                rationale: "no-signal:default-read-domains",
            },
        })
        expect(generateObjectMock).toHaveBeenCalled()
        expect(result.source).toBe("llm")
        expect(result.domains).toEqual(["doc_library", "system"])
    })
})
