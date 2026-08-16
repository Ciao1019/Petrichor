import { z } from "zod"
import type { AssistantToolContext, AssistantToolRegistration } from "./domain-types"
import { getAssistantToolRegistration } from "./tool-registry"
import { issueAssistantConfirmation } from "./confirmation-store"
import {
    isToolInThreadDangerAllowlist,
} from "./confirmation-allowlist"

/** 仅保留已实现危险工具对应的逻辑名 */
export const DANGEROUS_ACTION_WHITELIST = [
    "article.delete",
    "document.delete",
    "share.revoke",
    "ai_provider.delete",
    "ai_credential.update",
    "agent_api_key.revoke",
    "public_qa.set_enabled",
] as const

export type DangerousActionName = (typeof DANGEROUS_ACTION_WHITELIST)[number]

/** 本条 content_write / admin 危险工具名 → 契约白名单逻辑名 */
export const DANGEROUS_TOOL_WHITELIST: Record<string, DangerousActionName> = {
    delete_article: "article.delete",
    revoke_article_share: "share.revoke",
    delete_document: "document.delete",
    delete_ai_provider: "ai_provider.delete",
    update_ai_credential: "ai_credential.update",
    revoke_agent_api_key: "agent_api_key.revoke",
    set_public_qa_enabled: "public_qa.set_enabled",
}

export const confirmationActionSchema = z.object({
    toolName: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
})

export const requestUserConfirmationSchema = z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    variant: z.enum(["default", "destructive"]).optional(),
    confirmLabel: z.string().optional(),
    cancelLabel: z.string().optional(),
    action: confirmationActionSchema,
    risk: z.literal("dangerous"),
})

export const confirmationResultSchema = z.object({
    confirmed: z.boolean(),
    confirmationId: z.string().min(1),
    executionOutcome: z.unknown().optional(),
    cancelled: z.boolean().optional(),
    /** 确认时勾选「本会话允许同类操作」 */
    allowForThread: z.boolean().optional(),
})

export type RequestUserConfirmationInput = z.infer<typeof requestUserConfirmationSchema>

export function isDangerousToolName(toolName: string): boolean {
    return Object.prototype.hasOwnProperty.call(DANGEROUS_TOOL_WHITELIST, toolName)
}

export function assertConfirmationAction(action: { toolName: string; input: Record<string, unknown> }) {
    const mapped = DANGEROUS_TOOL_WHITELIST[action.toolName]
    if (!mapped) {
        throw new Error(`不允许确认执行未知危险工具：${action.toolName}`)
    }
    const registration = getAssistantToolRegistration(action.toolName)
    if (!registration || registration.risk !== "dangerous") {
        throw new Error(`危险工具未注册：${action.toolName}`)
    }
    return registration
}

export async function executeConfirmedDangerousAction(
    ctx: AssistantToolContext,
    action: { toolName: string; input: Record<string, unknown> },
): Promise<unknown> {
    const registration = assertConfirmationAction(action)
    return await registration.execute({ ...ctx, __confirmExec: true } as AssistantToolContext, action.input)
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    return value as Record<string, unknown>
}

function readToolName(part: Record<string, unknown>): string {
    if (typeof part.toolName === "string") return part.toolName
    if (typeof part.type === "string" && part.type.startsWith("tool-") && part.type !== "tool-call" && part.type !== "tool-invocation") {
        return part.type.slice("tool-".length)
    }
    const invocation = asRecord(part.toolInvocation)
    if (invocation && typeof invocation.toolName === "string") return invocation.toolName
    return ""
}

function readToolArgs(part: Record<string, unknown>): unknown {
    if (part.args != null) return part.args
    if (part.input != null) return part.input
    const invocation = asRecord(part.toolInvocation)
    return invocation?.args ?? invocation?.input
}

function readToolResult(part: Record<string, unknown>): unknown {
    if (part.result != null) return part.result
    if (part.output != null) return part.output
    const invocation = asRecord(part.toolInvocation)
    return invocation?.result ?? invocation?.output
}

/**
 * 从 UIMessage 列表中找出待执行的确认回传（已 confirmed 且尚未带 executionOutcome）。
 * 仅提取 confirmationId；真正的 action 必须以服务端票据为准。
 */
export function findPendingConfirmationExecution(messages: unknown[]): {
    confirmationId: string
    allowForThread: boolean
} | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = asRecord(messages[index])
        if (!message || message.role !== "assistant") continue
        const parts = Array.isArray(message.parts) ? message.parts : []
        for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
            const part = asRecord(parts[partIndex])
            if (!part) continue
            if (readToolName(part) !== "request_user_confirmation") continue

            const parsedResult = confirmationResultSchema.safeParse(readToolResult(part))
            if (!parsedResult.success || !parsedResult.data.confirmed) continue
            if (parsedResult.data.executionOutcome !== undefined) continue

            const parsedArgs = requestUserConfirmationSchema.safeParse(readToolArgs(part))
            if (!parsedArgs.success) continue
            if (parsedArgs.data.id !== parsedResult.data.confirmationId) continue

            return {
                confirmationId: parsedResult.data.confirmationId,
                allowForThread: parsedResult.data.allowForThread === true,
            }
        }
    }
    return null
}

/** 把执行结果写回对应 tool part，供模型继续叙述。 */
export function patchConfirmationExecutionOutcome(
    messages: unknown[],
    confirmationId: string,
    outcome: unknown,
): unknown[] {
    return messages.map((message) => {
        const record = asRecord(message)
        if (!record || record.role !== "assistant" || !Array.isArray(record.parts)) return message
        const parts = record.parts.map((rawPart) => {
            const part = asRecord(rawPart)
            if (!part || readToolName(part) !== "request_user_confirmation") return rawPart
            const result = asRecord(readToolResult(part))
            if (!result || result.confirmationId !== confirmationId) return rawPart
            const nextResult = { ...result, executionOutcome: outcome }
            if ("result" in part) return { ...part, result: nextResult }
            if ("output" in part) return { ...part, output: nextResult }
            return { ...part, result: nextResult }
        })
        return { ...record, parts }
    })
}

export function buildRequestUserConfirmationTool(): AssistantToolRegistration {
    return {
        name: "request_user_confirmation",
        domain: "content_write",
        risk: "read",
        description:
            "对危险操作发起用户确认卡。不要直接调用 delete_* / revoke_*；把目标工具名与参数放进 action，等用户确认后由运行时执行。",
        inputSchema: requestUserConfirmationSchema,
        execute: async (ctx, input) => {
            const parsed = requestUserConfirmationSchema.parse(input)
            assertConfirmationAction(parsed.action)

            // 会话 allowlist 命中且非 critical → 同轮直接执行，免确认卡
            const allowlisted = await isToolInThreadDangerAllowlist({
                threadId: ctx.threadId,
                userId: ctx.userId,
                toolName: parsed.action.toolName,
            })
            if (allowlisted) {
                const outcome = await executeConfirmedDangerousAction(ctx, parsed.action)
                return {
                    ...parsed,
                    autoApproved: true,
                    confirmed: true,
                    confirmationId: parsed.id,
                    executionOutcome: outcome,
                }
            }

            await issueAssistantConfirmation({
                confirmationKey: parsed.id,
                userId: ctx.userId,
                threadId: ctx.threadId,
                toolName: parsed.action.toolName,
                actionInput: parsed.action.input,
            })
            return parsed
        },
    }
}
