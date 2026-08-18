import { isAssistantOperator } from "../operator-gate"
import type { AgentToolDefinition, ToolExecutionContext } from "./types"

/**
 * 统一权限解析（§48/§148/§149）。
 *
 * 三条硬约束：
 * 1. Main Agent 与 SubAgent 都必须过这一层，禁止绕过；
 * 2. SubAgent 权限只能是 Main Agent 的子集，委派不能提权；
 * 3. 加载 Skill 只扩大"模型可见能力"，不改变用户真实权限。
 */

export type PermissionContext = {
    userId: number
    systemRole?: string | null
    /** 0 = Main Agent，>0 = SubAgent */
    delegationDepth: number
    /** 委派时由上层裁剪的工具白名单；SubAgent 只能在其中取子集 */
    allowedToolIds?: string[]
    workspaceId?: string
}

export type PermissionDecision = {
    allowed: boolean
    reason?: string
}

export interface PermissionResolver {
    canUseTool(userId: number, toolId: string, context: PermissionContext): Promise<PermissionDecision>
}

/** 已知权限位；工具通过 ToolDefinition.permissions 声明所需权限 */
export const PERMISSIONS = {
    operator: "assistant.operator",
    admin: "assistant.admin",
    write: "assistant.write",
    memoryWrite: "assistant.memory.write",
} as const

export class DefaultPermissionResolver implements PermissionResolver {
    constructor(private readonly getTool: (toolId: string) => AgentToolDefinition | null) {}

    async canUseTool(
        userId: number,
        toolId: string,
        context: PermissionContext,
    ): Promise<PermissionDecision> {
        const tool = this.getTool(toolId)
        if (!tool) return deny(`未注册的工具：${toolId}`)

        // SubAgent 只能用被显式授予的工具，且必须是 allowedInSubAgent（§52/§148）
        if (context.delegationDepth > 0) {
            if (tool.allowedInSubAgent === false) {
                return deny(`工具 ${toolId} 不允许在子代理中使用`)
            }
            if (context.allowedToolIds && !context.allowedToolIds.includes(toolId)) {
                return deny(`工具 ${toolId} 不在本次委派的授权范围内`)
            }
        }

        const isOperator = isAssistantOperator({ id: userId, systemRole: context.systemRole })
        if (tool.requiresOperator && !isOperator) {
            return deny(`工具 ${toolId} 仅限操作员使用`)
        }

        for (const permission of tool.permissions ?? []) {
            const decision = checkPermission(permission, { isOperator })
            if (!decision.allowed) return decision
        }

        return ALLOW
    }
}

const ALLOW: PermissionDecision = { allowed: true }

function deny(reason: string): PermissionDecision {
    return { allowed: false, reason }
}

function checkPermission(permission: string, ctx: { isOperator: boolean }): PermissionDecision {
    switch (permission) {
        case PERMISSIONS.operator:
        case PERMISSIONS.admin:
            return ctx.isOperator ? ALLOW : deny(`缺少权限：${permission}`)
        // write / memoryWrite 由具体业务 handler 再做资源级校验，这里只拦明显越权
        case PERMISSIONS.write:
        case PERMISSIONS.memoryWrite:
            return ALLOW
        default:
            return ALLOW
    }
}

/**
 * 委派工具白名单求交（§148）：子代理请求的工具 ∩ 父级实际可用工具。
 * 父级没有的工具，子代理一定拿不到。
 */
export function intersectToolScope(
    parentAllowed: string[] | undefined,
    requested: string[] | undefined,
    registryToolIds: string[],
): string[] {
    const parentSet = parentAllowed ? new Set(parentAllowed) : new Set(registryToolIds)
    if (!requested?.length) return [...parentSet]
    return requested.filter((id) => parentSet.has(id))
}

export function permissionContextFrom(ctx: ToolExecutionContext, allowedToolIds?: string[]): PermissionContext {
    return {
        userId: ctx.userId,
        systemRole: ctx.systemRole ?? null,
        delegationDepth: ctx.delegationDepth,
        ...(allowedToolIds ? { allowedToolIds } : {}),
        ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
    }
}
