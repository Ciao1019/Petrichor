import { z } from "zod"
import type { AssistantToolRegistration } from "../domain-types"
import { mutateOperatorProfile, type OperatorMemoryMutateInput } from "../operator-memory"

const memoryManageSchema = z.object({
    action: z.enum(["add", "replace", "remove"]),
    target: z.enum(["user_profile", "agent_notes"]),
    text: z.string().optional(),
    old_text: z.string().optional(),
    new_text: z.string().optional(),
})

function toMutateInput(parsed: z.infer<typeof memoryManageSchema>): OperatorMemoryMutateInput | { error: string } {
    if (parsed.action === "add") {
        if (!parsed.text?.trim()) return { error: "add 需要 text" }
        return { action: "add", target: parsed.target, text: parsed.text }
    }
    if (parsed.action === "replace") {
        if (!parsed.old_text || parsed.new_text == null) return { error: "replace 需要 old_text 与 new_text" }
        return {
            action: "replace",
            target: parsed.target,
            old_text: parsed.old_text,
            new_text: parsed.new_text,
        }
    }
    if (!parsed.old_text) return { error: "remove 需要 old_text" }
    return { action: "remove", target: parsed.target, old_text: parsed.old_text }
}

export const memoryManageTools: AssistantToolRegistration[] = [
    {
        name: "memory_manage",
        domain: "system",
        risk: "write",
        requiresOperator: true,
        description:
            "维护操作员常驻短文记忆（用户画像 / 约定笔记）。写入只更新持久 profile，本线程冻结快照不变，新开线程后生效。action: add|replace|remove；target: user_profile|agent_notes。",
        inputSchema: memoryManageSchema,
        execute: async (ctx, input) => {
            const parsed = memoryManageSchema.parse(input)
            const mutateInput = toMutateInput(parsed)
            if ("error" in mutateInput) {
                return { ok: false, errorCode: "invalid_patch", message: mutateInput.error }
            }
            return await mutateOperatorProfile(
                { id: ctx.userId, systemRole: ctx.systemRole },
                mutateInput,
            )
        },
    },
]
