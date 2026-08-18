import { describe, expect, it } from "vitest"
import { z } from "zod"
import { EvidenceStore } from "./evidence"
import { LoopDetector } from "./loop-detector"
import { ObservationStore } from "./observation"
import { DefaultPermissionResolver } from "./permissions"
import { AgentSkillRegistry, renderSkillCatalog } from "./skill-registry"
import { SkillLoader } from "./skill-loader"
import { AgentStateStore } from "./state"
import { AgentToolRegistry } from "./tool-registry"
import { TraceCollector } from "./trace"
import type { AgentToolDefinition, ToolExecutionContext } from "./types"

function tool(id: string, namespace: AgentToolDefinition["namespace"], extra?: Partial<AgentToolDefinition>): AgentToolDefinition {
    return {
        id,
        name: id.replace(".", "_"),
        namespace,
        description: id,
        inputSchema: z.object({}),
        riskLevel: "low",
        sideEffect: false,
        execute: async () => ({}),
        ...extra,
    }
}

function harness() {
    const tools = new AgentToolRegistry()
    tools.registerMany([
        tool("knowledge.search", "knowledge"),
        tool("knowledge.read", "knowledge"),
        tool("graph.search", "graph"),
        tool("admin.reset", "admin", { requiresOperator: true }),
    ])
    const skills = new AgentSkillRegistry()
    skills.registerMany([
        { id: "knowledge", name: "知识库", description: "检索知识库", instructions: "KNOWLEDGE_DOC", toolIds: ["knowledge.search", "knowledge.read"] },
        { id: "graph", name: "图谱", description: "图谱查询", instructions: "GRAPH_DOC", toolIds: ["graph.search"], dependencies: ["knowledge"] },
        { id: "admin", name: "管理", description: "管理操作", instructions: "ADMIN_DOC", toolIds: ["admin.reset"] },
        { id: "ghost", name: "幽灵", description: "未实现工具", instructions: "GHOST", toolIds: ["nope.x"] },
    ])
    const state = new AgentStateStore({ conversationId: "c", userId: "1", goal: "g" })
    const trace = new TraceCollector("r", "c", "1", "m")
    const loader = new SkillLoader({
        skills,
        tools,
        permissions: new DefaultPermissionResolver((id) => tools.get(id)),
        state,
        trace,
    })
    const ctx = (userId = 2): ToolExecutionContext => ({
        runId: "r",
        userId,
        conversationId: "c",
        delegationDepth: 0,
        state: state.current,
    })
    void new ObservationStore()
    void new EvidenceStore()
    void new LoopDetector()
    return { loader, state, trace, ctx, skills }
}

describe("SkillLoader", () => {
    it("加载后解锁工具并注入指令", async () => {
        const { loader, state } = harness()
        const result = await loader.load("knowledge", { runId: "r", userId: 2, conversationId: "c", delegationDepth: 0, state: state.current })

        expect(result.ok).toBe(true)
        expect(result.loaded).toEqual(["knowledge"])
        expect(result.instructions).toBe("KNOWLEDGE_DOC")
        expect(loader.activeToolIds.sort()).toEqual(["knowledge.read", "knowledge.search"])
        expect(state.current.loadedSkills).toEqual(["knowledge"])
    })

    it("依赖会先于目标技能加载", async () => {
        const { loader, ctx } = harness()
        const result = await loader.load("graph", ctx())
        expect(result.loaded).toEqual(["knowledge", "graph"])
        expect(loader.activeToolIds).toContain("knowledge.search")
        expect(loader.activeToolIds).toContain("graph.search")
    })

    it("重复加载不会重复注册", async () => {
        const { loader, ctx, trace } = harness()
        await loader.load("knowledge", ctx())
        const second = await loader.load("knowledge", ctx())
        expect(second.loaded).toEqual([])
        expect(second.alreadyLoaded).toEqual(["knowledge"])
        expect(trace.build().skillLoads).toHaveLength(1)
    })

    it("未知技能返回可用目录而不是抛错", async () => {
        const { loader, ctx } = harness()
        const result = await loader.load("nope", ctx())
        expect(result.ok).toBe(false)
        expect(result.error?.code).toBe("SKILL_NOT_FOUND")
        expect(result.available?.map((item) => item.id)).toContain("knowledge")
    })

    it("权限不足的技能拒绝加载，且不扩大用户真实权限", async () => {
        const { loader, ctx, state } = harness()
        const result = await loader.load("admin", ctx(2))
        expect(result.ok).toBe(false)
        expect(result.error?.code).toBe("SKILL_PERMISSION_DENIED")
        expect(state.current.loadedSkills).not.toContain("admin")
    })

    it("操作员可以加载管理技能", async () => {
        const { loader, ctx } = harness()
        const result = await loader.load("admin", ctx(1))
        expect(result.ok).toBe(true)
    })

    it("技能声明了未实现的工具时不会暴露空能力", async () => {
        const { loader, ctx } = harness()
        const result = await loader.load("ghost", ctx())
        expect(result.ok).toBe(false)
    })

    it("preload 失败静默，不影响主流程", async () => {
        const { loader, ctx } = harness()
        const loaded = await loader.preload(["nope", "knowledge"], ctx())
        expect(loaded).toEqual(["knowledge"])
    })
})

describe("renderSkillCatalog", () => {
    it("只输出一行描述，不含完整指令", () => {
        const catalog = renderSkillCatalog([
            { id: "research", name: "研究", description: "外部检索", instructions: "很长的正文".repeat(50), toolIds: [] },
        ])
        expect(catalog).toContain("- research: 外部检索")
        expect(catalog).not.toContain("很长的正文")
    })
})
