import { and, eq } from "drizzle-orm"
import { getDb } from "@/server/db/client"
import { assistantOperatorSkills } from "@/server/db/schema"
import type { AgentDomainId } from "./domain-types"
import {
    isAssistantOperator,
    type AssistantOperatorUser,
} from "./operator-gate"
import {
    ASSISTANT_SKILLS,
    getAssistantSkillBody,
    listAssistantSkillCatalog,
    type AssistantSkillDefinition,
} from "./skills"

/**
 * 操作员 skill 的读取路径，供 chat-handler 装载目录、load-skill 取全文。
 *
 * 注意：写入路径（skill_manage 工具、待审批队列、进化合入）已随「操作员记忆与进化」
 * 面板一并移除，因此 petrichor_assistant_operator_skill 目前只读不写，
 * 实际行为等价于「只有内置 skill」。表与读取逻辑保留，便于日后恢复自定义 skill。
 */

export type OperatorSkillCatalogItem = {
    name: string
    description: string
    source: "builtin" | "operator"
}

export async function listOperatorSkillCatalog(
    user: AssistantOperatorUser,
    domains: AgentDomainId[],
): Promise<OperatorSkillCatalogItem[]> {
    const builtin = listAssistantSkillCatalog(domains).map((item) => ({
        ...item,
        source: "builtin" as const,
    }))
    if (!isAssistantOperator(user)) return builtin

    const rows = await getDb()
        .select({
            name: assistantOperatorSkills.name,
            description: assistantOperatorSkills.description,
        })
        .from(assistantOperatorSkills)
        .where(and(
            eq(assistantOperatorSkills.userId, user.id),
            eq(assistantOperatorSkills.status, "active"),
        ))

    const byName = new Map<string, OperatorSkillCatalogItem>()
    for (const item of builtin) byName.set(item.name, item)
    for (const row of rows) {
        byName.set(row.name, {
            name: row.name,
            description: row.description,
            source: "operator",
        })
    }
    return [...byName.values()]
}

export async function getMergedSkillBody(
    name: string,
    user: AssistantOperatorUser,
): Promise<{ name: string; description: string; instructions: string; source: "builtin" | "operator" } | null> {
    if (isAssistantOperator(user)) {
        const [row] = await getDb()
            .select()
            .from(assistantOperatorSkills)
            .where(and(
                eq(assistantOperatorSkills.userId, user.id),
                eq(assistantOperatorSkills.name, name),
                eq(assistantOperatorSkills.status, "active"),
            ))
            .limit(1)
        if (row) {
            return {
                name: row.name,
                description: row.description,
                instructions: row.bodyMd,
                source: "operator",
            }
        }
    }
    const builtin = getAssistantSkillBody(name)
    if (!builtin) return null
    return {
        name: builtin.name,
        description: builtin.description,
        instructions: builtin.instructions,
        source: "builtin",
    }
}

export function listBuiltinSkillNames(): string[] {
    return ASSISTANT_SKILLS.map((skill: AssistantSkillDefinition) => skill.name)
}
