import { z } from "zod"
import { validationError } from "../errors"
import { defineTool } from "./adapter"
import type { AgentToolDefinition, DelegateTaskInput, PlanUpdateOp, SkillLoadResult } from "../types"

/**
 * agent.* 元工具（§15/§50）。
 *
 * 这些工具不访问业务数据，只驱动 Runtime 自身：加载能力、委派子任务、维护计划。
 * 它们必须常驻核心工具集，否则 Agent 无法自主扩展能力。
 */

const loadSkillSchema = z.object({
    skill: z.string().trim().min(1).max(64).describe("要加载的能力 id，例如 research / writer / graph"),
})

const delegateTaskSchema = z.object({
    objective: z.string().trim().min(1).max(2000).describe("子任务目标，必须是可独立完成的一件事"),
    context: z.string().trim().max(4000).optional().describe("子代理需要知道的背景"),
    skillIds: z.array(z.string().trim().min(1)).max(4).optional().describe("子代理需要的能力"),
    allowedToolIds: z.array(z.string().trim().min(1)).max(16).optional(),
    expectedOutput: z.string().trim().max(500).optional().describe("期望的产出形式"),
    maxToolCalls: z.number().int().min(1).max(12).optional(),
})

const delegateSchema = z.object({
    tasks: z.array(delegateTaskSchema).min(1).max(5).describe("彼此独立、可并行的子任务"),
})

const planStepSchema = z.object({
    goal: z.string().trim().min(1).max(300),
    dependsOn: z.array(z.string()).max(8).optional(),
})

const planOpSchema = z.discriminatedUnion("op", [
    z.object({ op: z.literal("set"), steps: z.array(planStepSchema).min(1).max(12) }),
    z.object({
        op: z.literal("add"),
        goal: z.string().trim().min(1).max(300),
        afterId: z.string().optional(),
        dependsOn: z.array(z.string()).max(8).optional(),
    }),
    z.object({
        op: z.literal("update"),
        id: z.string().min(1),
        goal: z.string().trim().min(1).max(300).optional(),
        status: z.enum(["pending", "running", "completed", "skipped", "failed"]).optional(),
        resultSummary: z.string().trim().max(500).optional(),
    }),
    z.object({ op: z.literal("remove"), id: z.string().min(1) }),
    z.object({ op: z.literal("reorder"), orderedIds: z.array(z.string().min(1)).min(2) }),
])

const updatePlanSchema = z.object({
    ops: z.array(planOpSchema).min(1).max(10),
})

export const agentMetaTools: AgentToolDefinition[] = [
    defineTool({
        id: "agent.load_skill",
        name: "load_skill",
        namespace: "agent",
        core: true,
        riskLevel: "low",
        sideEffect: false,
        allowedInSubAgent: false,
        description:
            "加载一项能力，获得它的操作说明与工具。"
            + "何时用：当前工具不足以完成目标时（例如需要查外部资料就加载 research，需要写长文就加载 writer）。"
            + "输入：skill（能力 id）。输出：该能力的操作说明与新增工具列表。"
            + "何时不用：已经加载过的能力不要重复加载；能用现有工具完成的任务不要加载。",
        inputSchema: loadSkillSchema,
        execute: async (ctx, raw) => {
            const input = loadSkillSchema.parse(raw)
            const services = ctx.services
            if (!services) throw validationError("当前上下文不支持加载能力")

            const result: SkillLoadResult = await services.loadSkill(input.skill)
            if (!result.ok) {
                return {
                    ok: false,
                    errorCode: result.error?.code ?? "SKILL_NOT_FOUND",
                    message: result.error?.message ?? `无法加载能力：${input.skill}`,
                    available: result.available ?? services.listSkills().filter((skill) => !skill.loaded),
                }
            }
            return {
                ok: true,
                skill: result.skillId,
                loaded: result.loaded,
                alreadyLoaded: result.alreadyLoaded,
                toolIds: result.toolIds,
                instructions: result.instructions,
                note: "新工具将在下一步生效，可直接按上面的说明继续。",
            }
        },
    }),

    defineTool({
        id: "agent.delegate",
        name: "delegate_task",
        namespace: "agent",
        core: true,
        riskLevel: "medium",
        sideEffect: false,
        allowedInSubAgent: false,
        description:
            "把彼此独立的子任务委派给子代理并行执行。"
            + "何时用：需要分别研究多个主题、或某个子任务需要独立上下文与较多步骤时。"
            + "输入：tasks（每项含 objective 与可选 skillIds/context）。输出：每个子任务的结论与结构化证据。"
            + "何时不用：一次搜索、一次读取、简单问答不要委派——直接自己做更快。",
        inputSchema: delegateSchema,
        execute: async (ctx, raw) => {
            const input = delegateSchema.parse(raw)
            const services = ctx.services
            if (!services) throw validationError("当前上下文不支持委派子任务")

            const tasks: DelegateTaskInput[] = input.tasks.map((task) => ({
                objective: task.objective,
                ...(task.context ? { context: task.context } : {}),
                ...(task.skillIds ? { skillIds: task.skillIds } : {}),
                ...(task.allowedToolIds ? { allowedToolIds: task.allowedToolIds } : {}),
                ...(task.expectedOutput ? { expectedOutput: task.expectedOutput } : {}),
                ...(task.maxToolCalls ? { maxToolCalls: task.maxToolCalls } : {}),
            }))

            const results = await services.delegate(tasks)
            return {
                ok: results.some((result) => result.status === "completed"),
                results: results.map((result) => ({
                    taskId: result.taskId,
                    status: result.status,
                    summary: result.summary,
                    evidenceCount: result.evidence.length,
                })),
            }
        },
        normalize: (output) => {
            const record = output as { results?: Array<{ status: string; summary: string; evidenceCount: number }> }
            const results = record?.results ?? []
            const done = results.filter((item) => item.status === "completed").length
            return {
                summary: `委派 ${results.length} 个子任务，完成 ${done} 个`,
                data: { results },
                ...(done < results.length ? { suggestedActions: ["handle_failed_subtask_inline"] } : {}),
            }
        },
    }),

    defineTool({
        id: "agent.update_plan",
        name: "update_plan",
        namespace: "agent",
        core: true,
        riskLevel: "low",
        sideEffect: false,
        allowedInSubAgent: false,
        description:
            "维护当前任务计划：新增/修改/删除/重排步骤，或把某步标记为完成、跳过、失败。"
            + "何时用：复杂任务执行过程中发现需要调整步骤时。"
            + "输入：ops（操作列表）。输出：更新后的完整计划。"
            + "何时不用：简单任务不需要计划，不要为了展示进度而创建计划。",
        inputSchema: updatePlanSchema,
        execute: async (ctx, raw) => {
            const input = updatePlanSchema.parse(raw)
            const services = ctx.services
            if (!services) throw validationError("当前上下文不支持修改计划")
            const plan = services.updatePlan(input.ops as PlanUpdateOp[])
            return { ok: true, plan }
        },
        normalize: (output) => {
            const plan = (output as { plan?: Array<{ status: string }> })?.plan ?? []
            const done = plan.filter((step) => step.status === "completed" || step.status === "skipped").length
            return {
                summary: `计划已更新（${done}/${plan.length} 步完成）`,
                data: { plan },
            }
        },
    }),
]
