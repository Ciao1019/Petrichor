import { z } from "zod"
import type { AssistantToolRegistration } from "../domain-types"
import { getAssistantSkillBody, listAssistantSkillCatalog } from "../skills"

const loadSkillSchema = z.object({
    name: z.string().trim().min(1).max(64),
})

export const loadSkillTools: AssistantToolRegistration[] = [
    {
        name: "load_skill",
        domain: "system",
        risk: "read",
        description:
            "按需加载业务 playbook 全文。可用 name：knowledge-qa / doc-library-qa / article-write / admin-ops。复杂业务步骤先 load_skill 再按 playbook 调工具。",
        inputSchema: loadSkillSchema,
        execute: async (_ctx, input) => {
            const parsed = loadSkillSchema.parse(input)
            const skill = getAssistantSkillBody(parsed.name)
            if (!skill) {
                return {
                    ok: false,
                    errorCode: "skill_not_found",
                    message: `未知 skill：${parsed.name}`,
                    available: listAssistantSkillCatalog([
                        "knowledge",
                        "doc_library",
                        "content_write",
                        "admin",
                        "system",
                    ]).map((item) => item.name),
                }
            }
            return {
                ok: true,
                name: skill.name,
                description: skill.description,
                instructions: skill.instructions,
            }
        },
    },
]
