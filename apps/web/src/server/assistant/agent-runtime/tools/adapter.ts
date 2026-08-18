import type { AssistantFocus, AssistantToolContext, AssistantToolRegistration } from "../../domain-types"
import { getAssistantToolRegistration } from "../../tool-registry"
import type { AgentToolDefinition, ToolExecutionContext, ToolNormalizer } from "../types"

/**
 * 旧 Assistant 工具 → 新 Agent Registry 的适配（§109）。
 *
 * 只迁移"元数据 + 归一化"，工具实现继续复用既有 execute，
 * 因此不存在两套并行实现。
 */

export function toAssistantContext(ctx: ToolExecutionContext): AssistantToolContext {
    return {
        userId: ctx.userId,
        threadId: ctx.threadId ?? 0,
        runId: ctx.dbRunId ?? 0,
        focus: (ctx.focus ?? null) as AssistantFocus | null,
        systemRole: ctx.systemRole ?? null,
        ...(ctx.delegationDepth > 0 ? { spawnDepth: ctx.delegationDepth } : {}),
        ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
    }
}

export type AdaptOptions = Omit<AgentToolDefinition, "id" | "name" | "description" | "inputSchema" | "execute"> & {
    id: string
    /** 覆盖对模型暴露的描述；不传沿用旧描述 */
    description?: string
    normalize?: ToolNormalizer
}

/** 按旧工具名取注册项并包装成新的 ToolDefinition */
export function adaptAssistantTool(legacyName: string, options: AdaptOptions): AgentToolDefinition {
    const legacy = getAssistantToolRegistration(legacyName)
    if (!legacy) {
        throw new Error(`适配失败：未注册的旧工具 ${legacyName}`)
    }
    return fromRegistration(legacy, options)
}

export function fromRegistration(
    legacy: AssistantToolRegistration,
    options: AdaptOptions,
): AgentToolDefinition {
    return {
        id: options.id,
        name: legacy.name,
        namespace: options.namespace,
        description: options.description ?? legacy.description,
        inputSchema: legacy.inputSchema,
        riskLevel: options.riskLevel,
        sideEffect: options.sideEffect,
        ...(options.permissions ? { permissions: options.permissions } : {}),
        ...(options.requiresConfirmation != null ? { requiresConfirmation: options.requiresConfirmation } : {}),
        ...(options.allowedInSubAgent != null ? { allowedInSubAgent: options.allowedInSubAgent } : {}),
        ...(legacy.requiresOperator ? { requiresOperator: true } : {}),
        ...(options.core != null ? { core: options.core } : {}),
        ...(options.tags ? { tags: options.tags } : {}),
        ...(options.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.maxRetries != null ? { maxRetries: options.maxRetries } : {}),
        ...(options.normalize ? { normalize: options.normalize } : {}),
        execute: async (ctx, input) => await legacy.execute(toAssistantContext(ctx), input),
    }
}

/** 直接定义新工具（没有旧实现可复用时） */
export function defineTool(definition: AgentToolDefinition): AgentToolDefinition {
    return definition
}

export function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
}

export function readArray(value: unknown, ...keys: string[]): unknown[] {
    const record = asRecord(value)
    if (!record) return Array.isArray(value) ? value : []
    for (const key of keys) {
        const item = record[key]
        if (Array.isArray(item)) return item
    }
    return []
}

export function readString(value: unknown, ...keys: string[]): string | undefined {
    const record = asRecord(value)
    if (!record) return undefined
    for (const key of keys) {
        const item = record[key]
        if (typeof item === "string" && item.trim()) return item.trim()
    }
    return undefined
}
