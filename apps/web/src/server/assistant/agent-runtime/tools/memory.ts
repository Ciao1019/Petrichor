import { z } from "zod"
import { mutateOperatorProfile } from "../../operator-memory"
import { PERMISSIONS } from "../permissions"
import { defineTool } from "./adapter"
import type { AgentToolDefinition, ToolExecutionContext, ToolNormalizerResult } from "../types"

/**
 * 长期记忆能力（§42/§43）。
 *
 * 明确区分「对话上下文」与「长期记忆」：对话里说过的内容不需要写进记忆。
 * 写入必须满足：用户明确要求保存，或长期有效且会影响后续协作。
 * 三个写操作都是副作用工具，且都经既有的操作员安全策略。
 */

const targetSchema = z.enum(["user_profile", "agent_notes"])
    .describe("user_profile=关于用户的长期事实；agent_notes=协作约定")

const writeSchema = z.object({
    target: targetSchema,
    text: z.string().trim().min(1).max(2_000).describe("要记住的内容，一句话说清"),
})

const updateSchema = z.object({
    target: targetSchema,
    oldText: z.string().trim().min(1).max(2_000).describe("要被替换的原文，必须与已存内容完全一致"),
    newText: z.string().trim().min(1).max(2_000),
})

const deleteSchema = z.object({
    target: targetSchema,
    oldText: z.string().trim().min(1).max(2_000).describe("要删除的原文，必须与已存内容完全一致"),
})

function memoryUser(ctx: ToolExecutionContext) {
    return { id: ctx.userId, systemRole: ctx.systemRole }
}

function memoryNormalizer(action: string) {
    return (output: unknown): ToolNormalizerResult => {
        const record = output as { ok?: boolean; errorCode?: string; userProfileChars?: number }
        if (record?.ok !== true) {
            return {
                summary: `记忆${action}失败：${record?.errorCode ?? "未知原因"}`,
                suggestedActions: record?.errorCode === "assistant_operator_only"
                    ? ["explain_permission_limit"]
                    : ["fix_arguments"],
            }
        }
        return {
            summary: `记忆已${action}`,
            data: { userProfileChars: record.userProfileChars },
        }
    }
}

export const memoryTools: AgentToolDefinition[] = [
    defineTool({
        id: "memory.write",
        name: "memory_write",
        namespace: "memory",
        riskLevel: "medium",
        sideEffect: true,
        allowedInSubAgent: false,
        permissions: [PERMISSIONS.memoryWrite],
        description:
            "写入一条长期记忆。"
            + "何时用：用户明确要求记住，或该信息长期有效且会影响后续协作。"
            + "输入：target + text。输出：写入结果。"
            + "何时不用：一次性信息、可从数据本身查到的事实、敏感凭据一律不要写；"
            + "当前对话里刚说过的内容也不需要写。",
        inputSchema: writeSchema,
        execute: async (ctx, raw) => {
            const input = writeSchema.parse(raw)
            return await mutateOperatorProfile(memoryUser(ctx), {
                action: "add",
                target: input.target,
                text: input.text,
            })
        },
        normalize: memoryNormalizer("写入"),
    }),

    defineTool({
        id: "memory.update",
        name: "memory_update",
        namespace: "memory",
        riskLevel: "medium",
        sideEffect: true,
        allowedInSubAgent: false,
        permissions: [PERMISSIONS.memoryWrite],
        description:
            "修改一条已存在的长期记忆。"
            + "何时用：已记住的事实发生变化时。"
            + "输入：target + oldText（须与已存内容完全一致）+ newText。输出：更新结果。"
            + "何时不用：不确定原文时先用 memory_search 确认，不要猜。",
        inputSchema: updateSchema,
        execute: async (ctx, raw) => {
            const input = updateSchema.parse(raw)
            return await mutateOperatorProfile(memoryUser(ctx), {
                action: "replace",
                target: input.target,
                old_text: input.oldText,
                new_text: input.newText,
            })
        },
        normalize: memoryNormalizer("更新"),
    }),

    defineTool({
        id: "memory.delete",
        name: "memory_delete",
        namespace: "memory",
        riskLevel: "medium",
        sideEffect: true,
        allowedInSubAgent: false,
        permissions: [PERMISSIONS.memoryWrite],
        description:
            "删除一条长期记忆。"
            + "何时用：用户要求忘记，或该记忆已经确定失效。"
            + "输入：target + oldText（须与已存内容完全一致）。输出：删除结果。"
            + "何时不用：不确定原文时先确认；不要因为一次对话里用不到就删。",
        inputSchema: deleteSchema,
        execute: async (ctx, raw) => {
            const input = deleteSchema.parse(raw)
            return await mutateOperatorProfile(memoryUser(ctx), {
                action: "remove",
                target: input.target,
                old_text: input.oldText,
            })
        },
        normalize: memoryNormalizer("删除"),
    }),
]
