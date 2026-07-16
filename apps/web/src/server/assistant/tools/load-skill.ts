import { z } from "zod"
import type { AssistantToolRegistration } from "../domain-types"
import { getMergedSkillBody, listOperatorSkillCatalog } from "../operator-skills"
import { CORE_SESSION_DOMAINS } from "../domain-types"

const loadSkillSchema = z.object({
    name: z.string().trim().min(1).max(64),
})

export const loadSkillTools: AssistantToolRegistration[] = [
    {
        name: "load_skill",
        domain: "system",
        risk: "read",
        description:
            "按需加载业务 playbook 全文。可用 name 见目录（含操作员 skill）。复杂业务步骤先 load_skill 再按 playbook 调工具。",
        inputSchema: loadSkillSchema,
        execute: async (ctx, input) => {
            const parsed = loadSkillSchema.parse(input)
            const user = { id: ctx.userId, systemRole: ctx.systemRole }
            const skill = await getMergedSkillBody(parsed.name, user)
            if (!skill) {
                const available = await listOperatorSkillCatalog(user, [
                    ...CORE_SESSION_DOMAINS,
                    "admin",
                ])
                return {
                    ok: false,
                    errorCode: "skill_not_found",
                    message: `未知 skill：${parsed.name}`,
                    available: available.map((item) => item.name),
                }
            }
            return {
                ok: true,
                name: skill.name,
                description: skill.description,
                instructions: skill.instructions,
                source: skill.source,
            }
        },
    },
]
