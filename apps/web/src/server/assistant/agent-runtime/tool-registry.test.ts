import { describe, expect, it } from "vitest"
import { z } from "zod"
import { AgentToolRegistry, isHighRiskTool, renderToolCatalogLine } from "./tool-registry"
import type { AgentToolDefinition } from "./types"

function tool(overrides: Partial<AgentToolDefinition> & Pick<AgentToolDefinition, "id" | "name" | "namespace">): AgentToolDefinition {
    return {
        description: "test tool",
        inputSchema: z.object({}),
        execute: async () => ({}),
        riskLevel: "low",
        sideEffect: false,
        ...overrides,
    }
}

describe("AgentToolRegistry", () => {
    it("按 id 与公开名双向查找", () => {
        const registry = new AgentToolRegistry()
        registry.register(tool({ id: "knowledge.search", name: "search_knowledge", namespace: "knowledge" }))

        expect(registry.get("knowledge.search")?.name).toBe("search_knowledge")
        expect(registry.get("search_knowledge")?.id).toBe("knowledge.search")
        expect(registry.has("knowledge.missing")).toBe(false)
    })

    it("id 必须以 namespace 开头", () => {
        const registry = new AgentToolRegistry()
        expect(() => registry.register(tool({ id: "search", name: "search", namespace: "knowledge" })))
            .toThrow(/namespace/)
    })

    it("公开名冲突时抛错，避免两把工具抢同一个模型入口", () => {
        const registry = new AgentToolRegistry()
        registry.register(tool({ id: "knowledge.search", name: "search", namespace: "knowledge" }))
        expect(() => registry.register(tool({ id: "document.search", name: "search", namespace: "document" })))
            .toThrow(/冲突/)
    })

    it("core 工具集只包含标记为 core 的工具，且默认隐藏操作员工具", () => {
        const registry = new AgentToolRegistry()
        registry.register(tool({ id: "knowledge.search", name: "a", namespace: "knowledge", core: true }))
        registry.register(tool({ id: "knowledge.read", name: "b", namespace: "knowledge" }))
        registry.register(tool({ id: "admin.x", name: "c", namespace: "admin", core: true, requiresOperator: true }))

        expect(registry.coreToolIds()).toEqual(["knowledge.search"])
        expect(registry.coreToolIds({ isOperator: true })).toContain("admin.x")
    })

    it("按 namespace / 副作用 / 子代理可用性过滤", () => {
        const registry = new AgentToolRegistry()
        registry.register(tool({ id: "document.create", name: "a", namespace: "document", sideEffect: true, allowedInSubAgent: false }))
        registry.register(tool({ id: "document.read", name: "b", namespace: "document" }))

        expect(registry.list({ namespace: "document" })).toHaveLength(2)
        expect(registry.list({ sideEffect: true }).map((t) => t.id)).toEqual(["document.create"])
        expect(registry.list({ allowedInSubAgent: true }).map((t) => t.id)).toEqual(["document.read"])
    })
})

describe("工具元数据渲染", () => {
    it("高风险判定覆盖 high 与有副作用的 medium", () => {
        expect(isHighRiskTool(tool({ id: "a.x", name: "x", namespace: "admin", riskLevel: "high" }))).toBe(true)
        expect(isHighRiskTool(tool({ id: "a.y", name: "y", namespace: "admin", riskLevel: "medium", sideEffect: true }))).toBe(true)
        expect(isHighRiskTool(tool({ id: "a.z", name: "z", namespace: "admin", riskLevel: "low", sideEffect: true }))).toBe(false)
    })

    it("目录行标注副作用与确认要求", () => {
        const line = renderToolCatalogLine(tool({
            id: "document.share",
            name: "share",
            namespace: "document",
            sideEffect: true,
            requiresConfirmation: true,
            description: "分享文章",
        }))
        expect(line).toContain("有副作用")
        expect(line).toContain("需确认")
    })
})
