import { beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"
import type { AssistantToolContext, AssistantToolRegistration } from "./domain-types"
import {
    clearAssistantToolRegistryForTests,
    getAssistantToolDomain,
    loadToolsForDomains,
    registerAssistantTools,
} from "./tool-registry"

const ctx: AssistantToolContext = { userId: 1, threadId: 2, runId: 3, focus: null }

function makeRegistration(overrides: Partial<AssistantToolRegistration> = {}): AssistantToolRegistration {
    return {
        name: "list_knowledge_bases",
        domain: "knowledge",
        risk: "read",
        description: "测试用",
        inputSchema: z.object({}),
        execute: async () => ({ ok: true }),
        ...overrides,
    }
}

beforeEach(() => {
    clearAssistantToolRegistryForTests()
})

describe("loadToolsForDomains", () => {
    it("空注册表对任意域返回空集", () => {
        expect(loadToolsForDomains(["system", "knowledge", "doc_library"], ctx)).toEqual({})
    })

    it("按域过滤，只装载命中域的工具", () => {
        registerAssistantTools([
            makeRegistration({ name: "list_knowledge_bases", domain: "knowledge" }),
            makeRegistration({ name: "list_system_overview", domain: "system" }),
        ])
        const tools = loadToolsForDomains(["knowledge"], ctx)
        expect(Object.keys(tools)).toEqual(["list_knowledge_bases"])
    })

    it("execute 绑定请求期 ctx", async () => {
        let seenCtx: AssistantToolContext | null = null
        registerAssistantTools([
            makeRegistration({
                execute: async (executeCtx, input) => {
                    seenCtx = executeCtx
                    return input
                },
            }),
        ])
        const tools = loadToolsForDomains(["knowledge"], ctx)
        const loaded = tools.list_knowledge_bases!
        await loaded.execute?.({} as never, { toolCallId: "t1", messages: [], context: undefined } as never)
        expect(seenCtx).toBe(ctx)
    })
})

describe("registerAssistantTools", () => {
    it("同一次调用内同名抛错", () => {
        expect(() => registerAssistantTools([makeRegistration(), makeRegistration()])).toThrow(/重名/)
    })

    it("跨次调用同名覆盖（HMR：tools 模块重载后对象引用会变）", () => {
        registerAssistantTools([makeRegistration({ description: "旧" })])
        expect(() => registerAssistantTools([makeRegistration({ description: "新" })])).not.toThrow()
        expect(getAssistantToolDomain("list_knowledge_bases")).toBe("knowledge")
    })

    it("同一引用重复注册幂等", () => {
        const registration = makeRegistration()
        registerAssistantTools([registration])
        expect(() => registerAssistantTools([registration])).not.toThrow()
    })
})

describe("getAssistantToolDomain", () => {
    it("返回已注册工具的域，未注册返回 null", () => {
        registerAssistantTools([makeRegistration({ name: "search_documents", domain: "doc_library" })])
        expect(getAssistantToolDomain("search_documents")).toBe("doc_library")
        expect(getAssistantToolDomain("unknown_tool")).toBeNull()
    })
})
