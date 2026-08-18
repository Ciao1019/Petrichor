import { skillNotFound } from "./errors"
import type { AgentEventEmitter } from "./events"
import type { PermissionResolver } from "./permissions"
import type { AgentSkillRegistry } from "./skill-registry"
import type { AgentStateStore } from "./state"
import type { AgentToolRegistry } from "./tool-registry"
import type { TraceCollector } from "./trace"
import type { AgentSkill, SkillLoadResult, ToolExecutionContext } from "./types"

/**
 * 动态 Skill Loader（§15）。
 *
 * 加载后：注册到当前 Run、注入 instructions、暴露该 Skill 的工具、自动加载依赖、
 * 做权限检查、写 Trace、不重复加载。
 * Router 无权阻止任何 Skill 加载。
 */
export type SkillLoaderDeps = {
    skills: AgentSkillRegistry
    tools: AgentToolRegistry
    permissions: PermissionResolver
    state: AgentStateStore
    trace: TraceCollector
    events?: AgentEventEmitter
}

export class SkillLoader {
    /** 本 Run 已注入 context 的 skill 正文 */
    private readonly instructions = new Map<string, string>()
    /** 本 Run 已解锁的工具 id */
    private readonly unlockedToolIds = new Set<string>()

    constructor(private readonly deps: SkillLoaderDeps) {}

    /** 已加载 skill 的可用工具集合（供 Runtime 组装每轮 activeTools） */
    get activeToolIds(): string[] {
        return [...this.unlockedToolIds]
    }

    get loadedInstructions(): Array<{ skillId: string; instructions: string }> {
        return [...this.instructions.entries()].map(([skillId, instructions]) => ({ skillId, instructions }))
    }

    async load(
        skillId: string,
        ctx: ToolExecutionContext,
        options?: { silent?: boolean },
    ): Promise<SkillLoadResult> {
        const target = this.deps.skills.get(skillId)
        if (!target) {
            const error = skillNotFound(skillId, this.deps.skills.ids)
            return {
                ok: false,
                skillId,
                loaded: [],
                alreadyLoaded: [],
                toolIds: [],
                error: error.toShape(),
                available: this.deps.skills.list().map((skill) => ({
                    id: skill.id,
                    description: skill.description,
                })),
            }
        }

        // 依赖优先加载（§15）
        const chain = this.deps.skills.resolveWithDependencies(skillId)
        const loaded: string[] = []
        const alreadyLoaded: string[] = []
        const toolIds = new Set<string>()

        for (const skill of chain) {
            if (this.deps.state.hasSkill(skill.id)) {
                alreadyLoaded.push(skill.id)
                for (const id of this.resolvableToolIds(skill)) toolIds.add(id)
                continue
            }

            // 权限不足时跳过该 skill：加载 Skill 不得扩大用户真实权限（§149）
            const allowed = await this.checkSkillPermission(skill, ctx)
            if (!allowed) {
                if (skill.id === skillId) {
                    return {
                        ok: false,
                        skillId,
                        loaded,
                        alreadyLoaded,
                        toolIds: [...toolIds],
                        error: {
                            code: "SKILL_PERMISSION_DENIED",
                            message: `当前账号无权使用能力：${skill.id}`,
                            retryable: false,
                        },
                    }
                }
                continue
            }

            this.deps.state.markSkillLoaded(skill.id)
            this.instructions.set(skill.id, skill.instructions)
            const skillTools = this.resolvableToolIds(skill)
            for (const id of skillTools) {
                toolIds.add(id)
                this.unlockedToolIds.add(id)
            }
            loaded.push(skill.id)

            this.deps.trace.recordSkillLoad({
                skillId: skill.id,
                loadedAt: Date.now(),
                toolIds: skillTools,
                ...(skill.id === skillId ? {} : { viaDependency: true }),
            })
            // 预加载是能力预热，不是 Agent 主动做的事，不该出现在用户可见的执行步骤里
            if (!options?.silent) {
                this.deps.events?.emit("skill_loaded", {
                    skillId: skill.id,
                    name: skill.name,
                    description: skill.description,
                    toolIds: skillTools,
                })
            }
        }

        return {
            ok: true,
            skillId,
            loaded,
            alreadyLoaded,
            instructions: target.instructions,
            toolIds: [...toolIds],
        }
    }

    /**
     * 预加载（Router hint 用）。
     * 失败静默：hint 出错不能影响主流程；同时不发 skill_loaded 事件，
     * 否则用户会看到一堆自己没要求过的"启用能力"步骤。
     */
    async preload(skillIds: string[], ctx: ToolExecutionContext): Promise<string[]> {
        const loaded: string[] = []
        for (const id of skillIds) {
            const result = await this.load(id, ctx, { silent: true })
            if (result.ok) loaded.push(...result.loaded)
        }
        return loaded
    }

    /** 只暴露 registry 里真实存在的工具，避免 skill 定义与工具实现漂移 */
    private resolvableToolIds(skill: AgentSkill): string[] {
        return skill.toolIds.filter((id) => this.deps.tools.has(id))
    }

    private async checkSkillPermission(skill: AgentSkill, ctx: ToolExecutionContext): Promise<boolean> {
        // Skill 自身没声明权限位时，用它的工具做代理判断：
        // 一个工具都用不了的 skill 加载了也没意义
        const toolIds = this.resolvableToolIds(skill)
        if (toolIds.length === 0) return skill.toolIds.length === 0

        let anyAllowed = false
        for (const toolId of toolIds) {
            const decision = await this.deps.permissions.canUseTool(ctx.userId, toolId, {
                userId: ctx.userId,
                systemRole: ctx.systemRole ?? null,
                delegationDepth: ctx.delegationDepth,
            })
            if (decision.allowed) {
                anyAllowed = true
                break
            }
        }
        return anyAllowed
    }
}
