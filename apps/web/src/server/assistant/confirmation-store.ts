import { and, eq } from "drizzle-orm"
import { getDb } from "@/server/db/client"
import { assistantConfirmations } from "@/server/db/schema"
import { badRequest } from "@/server/http/response"

export type StoredConfirmationAction = {
    toolName: string
    input: Record<string, unknown>
}

/** 签发危险确认票据；同 key 已存在则覆盖为新的 pending（模型重提确认）。 */
export async function issueAssistantConfirmation(input: {
    confirmationKey: string
    userId: number
    threadId: number
    toolName: string
    actionInput: Record<string, unknown>
}): Promise<void> {
    const now = new Date()
    const inputJson = JSON.stringify(input.actionInput)
    await getDb()
        .insert(assistantConfirmations)
        .values({
            confirmationKey: input.confirmationKey,
            threadId: input.threadId,
            userId: input.userId,
            toolName: input.toolName,
            inputJson,
            status: "pending",
            consumedAt: null,
            createdAt: now,
            updatedAt: now,
        })
        .onConflictDoUpdate({
            target: [assistantConfirmations.confirmationKey],
            set: {
                threadId: input.threadId,
                userId: input.userId,
                toolName: input.toolName,
                inputJson,
                status: "pending",
                consumedAt: null,
                updatedAt: now,
            },
        })
}

/**
 * 原子消费确认票据。成功返回服务端存的 action；已消费/不存在/归属不符则抛错。
 * 不信任客户端传入的 toolName/input。
 */
export async function consumeAssistantConfirmation(input: {
    confirmationKey: string
    userId: number
    threadId: number
}): Promise<StoredConfirmationAction> {
    const now = new Date()
    const rows = await getDb()
        .update(assistantConfirmations)
        .set({
            status: "consumed",
            consumedAt: now,
            updatedAt: now,
        })
        .where(and(
            eq(assistantConfirmations.confirmationKey, input.confirmationKey),
            eq(assistantConfirmations.userId, input.userId),
            eq(assistantConfirmations.threadId, input.threadId),
            eq(assistantConfirmations.status, "pending"),
        ))
        .returning({
            toolName: assistantConfirmations.toolName,
            inputJson: assistantConfirmations.inputJson,
        })

    const row = rows[0]
    if (!row) {
        throw badRequest("确认已失效或不可用（可能已执行、伪造或归属不符）")
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(row.inputJson)
    } catch {
        throw badRequest("确认票据参数损坏")
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw badRequest("确认票据参数无效")
    }
    return {
        toolName: row.toolName,
        input: parsed as Record<string, unknown>,
    }
}
