import type { AgentToolDefinition, ToolNamespace } from "./types"

/**
 * 统一工具注册表（§12）。
 *
 * 所有 Agent 可用工具都必须在此注册：Runtime、Skill、SubAgent 都只从这里取工具，
 * 禁止 scattered import 现拼工具集。
 */
export class AgentToolRegistry {
    private readonly byId = new Map<string, AgentToolDefinition>()
    /** 对模型暴露的 name → id，保持旧公开工具名兼容（§11） */
    private readonly byName = new Map<string, string>()

    register(definition: AgentToolDefinition): void {
        if (!definition.id.startsWith(`${definition.namespace}.`)) {
            throw new Error(`工具 id 必须以 namespace 开头：${definition.id}（namespace=${definition.namespace}）`)
        }
        const existingName = this.byName.get(definition.name)
        if (existingName && existingName !== definition.id) {
            throw new Error(`工具公开名冲突：${definition.name}（${existingName} vs ${definition.id}）`)
        }
        this.byId.set(definition.id, definition)
        this.byName.set(definition.name, definition.id)
    }

    registerMany(definitions: AgentToolDefinition[]): void {
        for (const definition of definitions) this.register(definition)
    }

    get(toolId: string): AgentToolDefinition | null {
        return this.byId.get(toolId) ?? this.byId.get(this.byName.get(toolId) ?? "") ?? null
    }

    require(toolId: string): AgentToolDefinition {
        const tool = this.get(toolId)
        if (!tool) throw new Error(`未注册的工具：${toolId}`)
        return tool
    }

    has(toolId: string): boolean {
        return this.get(toolId) != null
    }

    get ids(): string[] {
        return [...this.byId.keys()]
    }

    list(filter?: {
        namespace?: ToolNamespace
        core?: boolean
        sideEffect?: boolean
        allowedInSubAgent?: boolean
        isOperator?: boolean
    }): AgentToolDefinition[] {
        return [...this.byId.values()].filter((tool) => {
            if (filter?.namespace && tool.namespace !== filter.namespace) return false
            if (filter?.core != null && Boolean(tool.core) !== filter.core) return false
            if (filter?.sideEffect != null && tool.sideEffect !== filter.sideEffect) return false
            if (filter?.allowedInSubAgent != null
                && (tool.allowedInSubAgent ?? true) !== filter.allowedInSubAgent) return false
            if (filter?.isOperator === false && tool.requiresOperator) return false
            return true
        })
    }

    /** 主 Agent 默认核心工具集（§10）：控制在 5~10 个，其余靠 load_skill 解锁 */
    coreToolIds(options?: { isOperator?: boolean }): string[] {
        return this.list({ core: true, isOperator: options?.isOperator ?? false }).map((tool) => tool.id)
    }

    clear(): void {
        this.byId.clear()
        this.byName.clear()
    }
}

/** 进程内单例：模块加载时由 tools/register.ts 填充 */
export const agentToolRegistry = new AgentToolRegistry()

/** 高危工具判定（§47）：写副作用 + high 风险 */
export function isHighRiskTool(tool: AgentToolDefinition): boolean {
    return tool.riskLevel === "high" || (tool.sideEffect && tool.riskLevel !== "low")
}

/** 供 prompt 使用的工具描述行（§155） */
export function renderToolCatalogLine(tool: AgentToolDefinition): string {
    const marks: string[] = []
    if (tool.sideEffect) marks.push("有副作用")
    if (tool.requiresConfirmation) marks.push("需确认")
    const suffix = marks.length ? `（${marks.join("，")}）` : ""
    return `- ${tool.id}${suffix}：${tool.description}`
}
