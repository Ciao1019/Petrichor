import { describe, expect, it, vi } from "vitest"

// 装配自检只关心元数据，不拉起鉴权/模型依赖
vi.mock("@/server/auth/current-user", () => ({ requireCurrentUser: vi.fn() }))
vi.mock("@/server/ai/generation", () => ({
    createChatLanguageModel: vi.fn(),
    callChatCompletion: vi.fn(),
}))

import { agentToolRegistry } from "../tool-registry"
import { agentSkillRegistry } from "../skill-registry"
import "./index"

/**
 * 工具装配自检（§12/§14/§155）：
 * 保证 Registry 与 Skill 定义不漂移，核心工具集受控，描述规范到位。
 */
describe("Agent 工具装配", () => {
    it("核心工具集受控在 5~10 个", () => {
        const core = agentToolRegistry.coreToolIds()
        expect(core.length).toBeGreaterThanOrEqual(5)
        expect(core.length).toBeLessThanOrEqual(10)
    })

    it("核心工具包含元工具与知识检索入口", () => {
        const core = agentToolRegistry.coreToolIds()
        expect(core).toContain("agent.load_skill")
        expect(core).toContain("agent.delegate")
        expect(core).toContain("knowledge.search")
        expect(core).toContain("knowledge.read")
    })

    it("所有工具 id 都带 namespace 前缀", () => {
        for (const id of agentToolRegistry.ids) {
            expect(id).toMatch(/^[a-z_]+\./)
        }
    })

    it("Skill 声明的工具都已实现", () => {
        for (const skill of agentSkillRegistry.list()) {
            for (const toolId of skill.toolIds) {
                expect(agentToolRegistry.has(toolId), `${skill.id} → ${toolId}`).toBe(true)
            }
        }
    })

    it("每个 Skill 至少有一个可用工具", () => {
        for (const skill of agentSkillRegistry.list()) {
            expect(skill.toolIds.length, skill.id).toBeGreaterThan(0)
        }
    })

    it("有副作用的工具不得默认暴露给子代理", () => {
        for (const tool of agentToolRegistry.list({ sideEffect: true })) {
            expect(tool.allowedInSubAgent ?? true, tool.id).toBe(false)
        }
    })

    it("管理类工具需要权限或操作员身份", () => {
        for (const tool of agentToolRegistry.list({ namespace: "admin" })) {
            expect(
                Boolean(tool.requiresOperator) || (tool.permissions?.length ?? 0) > 0,
                tool.id,
            ).toBe(true)
        }
    })

    it("核心工具描述说明了何时用与何时不用", () => {
        for (const tool of agentToolRegistry.list({ core: true })) {
            expect(tool.description, tool.id).toContain("何时用")
            expect(tool.description, tool.id).toContain("何时不用")
        }
    })

    it("公开工具名不重复", () => {
        const names = agentToolRegistry.list().map((tool) => tool.name)
        expect(new Set(names).size).toBe(names.length)
    })
})
