import { z } from "zod"
import type { AssistantToolRegistration } from "../domain-types"
import { manageOperatorSkill, type SkillManageInput } from "../operator-skills"

const schema = z.object({
    action: z.enum(["create", "patch", "edit", "delete"]),
    name: z.string().trim().min(1).max(64),
    content: z.string().optional(),
    old_string: z.string().optional(),
    new_string: z.string().optional(),
})

function toInput(parsed: z.infer<typeof schema>): SkillManageInput | { error: string } {
    if (parsed.action === "create") {
        if (!parsed.content?.trim()) return { error: "create 需要 content" }
        return { action: "create", name: parsed.name, content: parsed.content }
    }
    if (parsed.action === "edit") {
        if (!parsed.content?.trim()) return { error: "edit 需要 content" }
        return { action: "edit", name: parsed.name, content: parsed.content }
    }
    if (parsed.action === "delete") {
        return { action: "delete", name: parsed.name }
    }
    if (!parsed.old_string || parsed.new_string == null) {
        return { error: "patch 需要 old_string 与 new_string" }
    }
    return {
        action: "patch",
        name: parsed.name,
        old_string: parsed.old_string,
        new_string: parsed.new_string,
    }
}

export const skillManageTools: AssistantToolRegistration[] = [
    {
        name: "skill_manage",
        domain: "system",
        risk: "write",
        requiresOperator: true,
        description:
            "管理操作员程序性 skill。create/edit/delete 会进入待审批；patch 小改可直接生效。name 建议小写连字符。",
        inputSchema: schema,
        execute: async (ctx, input) => {
            const parsed = schema.parse(input)
            const manageInput = toInput(parsed)
            if ("error" in manageInput) {
                return { ok: false, errorCode: "invalid_patch", message: manageInput.error }
            }
            return await manageOperatorSkill(
                { id: ctx.userId, systemRole: ctx.systemRole },
                manageInput,
            )
        },
    },
]
