import { and, desc, eq } from "drizzle-orm"
import { getDb } from "@/server/db/client"
import {
    assistantOperatorSkillPendings,
    assistantOperatorSkills,
} from "@/server/db/schema"
import { conflict, notFound } from "@/server/http/response"
import type { AgentDomainId } from "./domain-types"
import {
    assertAssistantOperator,
    isAssistantOperator,
    type AssistantOperatorUser,
} from "./operator-gate"
import {
    ASSISTANT_SKILLS,
    getAssistantSkillBody,
    listAssistantSkillCatalog,
    type AssistantSkillDefinition,
} from "./skills"

export type OperatorSkillCatalogItem = {
    name: string
    description: string
    source: "builtin" | "operator"
}

function conflictError(message: string): never {
    throw conflict(message)
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

function parseSkillFrontmatter(content: string): { description: string; body: string } {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
    if (!match) {
        return { description: content.trim().slice(0, 120) || "操作员 skill", body: content }
    }
    const yaml = match[1] ?? ""
    const body = (match[2] ?? "").trim()
    const descLine = yaml.split("\n").find((line) => line.startsWith("description:"))
    const description = descLine
        ? descLine.replace(/^description:\s*/, "").replace(/^["']|["']$/g, "").trim()
        : body.slice(0, 120) || "操作员 skill"
    return { description: description || "操作员 skill", body: body || content }
}

export type SkillManageInput =
    | { action: "create"; name: string; content: string }
    | { action: "edit"; name: string; content: string }
    | { action: "delete"; name: string }
    | { action: "patch"; name: string; old_string: string; new_string: string }

export async function manageOperatorSkill(
    user: AssistantOperatorUser,
    input: SkillManageInput,
): Promise<
    | { ok: true; pendingId: string; requiresApproval: true }
    | { ok: true; requiresApproval: false; version: number }
    | { ok: false; errorCode: string; message?: string }
> {
    if (!isAssistantOperator(user)) {
        return { ok: false, errorCode: "assistant_operator_only" }
    }

    if (input.action === "patch") {
        const [row] = await getDb()
            .select()
            .from(assistantOperatorSkills)
            .where(and(
                eq(assistantOperatorSkills.userId, user.id),
                eq(assistantOperatorSkills.name, input.name),
                eq(assistantOperatorSkills.status, "active"),
            ))
            .limit(1)
        if (!row) {
            const builtin = getAssistantSkillBody(input.name)
            if (!builtin) {
                return { ok: false, errorCode: "skill_patch_miss", message: "skill 不存在" }
            }
            // patch 内置：当作 create pending with patched body
            if (!builtin.instructions.includes(input.old_string)) {
                return { ok: false, errorCode: "skill_patch_miss" }
            }
            const after = builtin.instructions.replace(input.old_string, input.new_string)
            const pendingId = await createSkillPending(user.id, {
                skillName: input.name,
                action: "create",
                beforeMd: builtin.instructions,
                afterMd: after,
                description: builtin.description,
                gist: `基于内置 ${input.name} 的 patch → 待审批创建`,
            })
            return { ok: true, pendingId: String(pendingId), requiresApproval: true }
        }
        if (!row.bodyMd.includes(input.old_string)) {
            return { ok: false, errorCode: "skill_patch_miss" }
        }
        const nextBody = row.bodyMd.replace(input.old_string, input.new_string)
        const nextVersion = row.version + 1
        await getDb()
            .update(assistantOperatorSkills)
            .set({ bodyMd: nextBody, version: nextVersion, updatedAt: new Date() })
            .where(eq(assistantOperatorSkills.id, row.id))
        return { ok: true, requiresApproval: false, version: nextVersion }
    }

    if (input.action === "create") {
        const parsed = parseSkillFrontmatter(input.content)
        const pendingId = await createSkillPending(user.id, {
            skillName: input.name,
            action: "create",
            beforeMd: null,
            afterMd: parsed.body,
            description: parsed.description,
            gist: `创建 skill ${input.name}`,
        })
        return { ok: true, pendingId: String(pendingId), requiresApproval: true }
    }

    if (input.action === "edit") {
        const existing = await getActiveOrBuiltinBody(user.id, input.name)
        if (!existing) return { ok: false, errorCode: "skill_patch_miss", message: "skill 不存在" }
        const parsed = parseSkillFrontmatter(input.content)
        const pendingId = await createSkillPending(user.id, {
            skillName: input.name,
            action: "edit",
            beforeMd: existing.body,
            afterMd: parsed.body,
            description: parsed.description,
            gist: `大改 skill ${input.name}`,
        })
        return { ok: true, pendingId: String(pendingId), requiresApproval: true }
    }

    // delete
    const existing = await getActiveOrBuiltinBody(user.id, input.name)
    if (!existing || existing.source === "builtin") {
        return { ok: false, errorCode: "skill_patch_miss", message: "只能删除操作员 skill" }
    }
    const pendingId = await createSkillPending(user.id, {
        skillName: input.name,
        action: "delete",
        beforeMd: existing.body,
        afterMd: null,
        description: existing.description,
        gist: `删除 skill ${input.name}`,
    })
    return { ok: true, pendingId: String(pendingId), requiresApproval: true }
}

async function getActiveOrBuiltinBody(userId: number, name: string) {
    const [row] = await getDb()
        .select()
        .from(assistantOperatorSkills)
        .where(and(
            eq(assistantOperatorSkills.userId, userId),
            eq(assistantOperatorSkills.name, name),
            eq(assistantOperatorSkills.status, "active"),
        ))
        .limit(1)
    if (row) {
        return { body: row.bodyMd, description: row.description, source: "operator" as const }
    }
    const builtin = getAssistantSkillBody(name)
    if (!builtin) return null
    return { body: builtin.instructions, description: builtin.description, source: "builtin" as const }
}

async function createSkillPending(userId: number, input: {
    skillName: string
    action: string
    beforeMd: string | null
    afterMd: string | null
    description: string | null
    gist: string
}) {
    const [row] = await getDb()
        .insert(assistantOperatorSkillPendings)
        .values({
            userId,
            skillName: input.skillName,
            action: input.action,
            beforeMd: input.beforeMd,
            afterMd: input.afterMd,
            description: input.description,
            gist: input.gist,
            status: "pending",
            createdAt: new Date(),
        })
        .returning({ id: assistantOperatorSkillPendings.id })
    return row!.id
}

export async function listSkillPendings(user: AssistantOperatorUser) {
    assertAssistantOperator(user)
    const rows = await getDb()
        .select()
        .from(assistantOperatorSkillPendings)
        .where(and(
            eq(assistantOperatorSkillPendings.userId, user.id),
            eq(assistantOperatorSkillPendings.status, "pending"),
        ))
        .orderBy(desc(assistantOperatorSkillPendings.createdAt))
        .limit(50)
    return rows.map((row) => ({
        id: String(row.id),
        skillName: row.skillName,
        action: row.action,
        gist: row.gist,
        description: row.description,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
    }))
}

export async function resolveSkillPending(
    user: AssistantOperatorUser,
    pendingId: number,
    decision: "approve" | "reject",
) {
    assertAssistantOperator(user)
    const [row] = await getDb()
        .select()
        .from(assistantOperatorSkillPendings)
        .where(and(
            eq(assistantOperatorSkillPendings.id, pendingId),
            eq(assistantOperatorSkillPendings.userId, user.id),
        ))
        .limit(1)
    if (!row) throw notFound("pending_not_found")
    if (row.status !== "pending") conflictError("pending_not_open")

    const now = new Date()
    if (decision === "reject") {
        await getDb()
            .update(assistantOperatorSkillPendings)
            .set({ status: "rejected", resolvedAt: now })
            .where(eq(assistantOperatorSkillPendings.id, row.id))
        return { ok: true as const, status: "rejected" as const }
    }

    if (row.action === "create" || row.action === "edit") {
        const description = row.description?.trim() || row.gist
        const body = row.afterMd ?? ""
        const [existing] = await getDb()
            .select()
            .from(assistantOperatorSkills)
            .where(and(
                eq(assistantOperatorSkills.userId, user.id),
                eq(assistantOperatorSkills.name, row.skillName),
            ))
            .limit(1)
        if (existing) {
            await getDb()
                .update(assistantOperatorSkills)
                .set({
                    description,
                    bodyMd: body,
                    version: existing.version + 1,
                    status: "active",
                    updatedAt: now,
                })
                .where(eq(assistantOperatorSkills.id, existing.id))
        } else {
            await getDb()
                .insert(assistantOperatorSkills)
                .values({
                    userId: user.id,
                    name: row.skillName,
                    description,
                    bodyMd: body,
                    version: 1,
                    status: "active",
                    updatedAt: now,
                })
        }
    } else if (row.action === "delete") {
        await getDb()
            .update(assistantOperatorSkills)
            .set({ status: "archived", updatedAt: now })
            .where(and(
                eq(assistantOperatorSkills.userId, user.id),
                eq(assistantOperatorSkills.name, row.skillName),
            ))
    }

    await getDb()
        .update(assistantOperatorSkillPendings)
        .set({ status: "approved", resolvedAt: now })
        .where(eq(assistantOperatorSkillPendings.id, row.id))
    return { ok: true as const, status: "approved" as const }
}

/** 进化合入：直接写 active skill，跳过 pending */
export async function upsertOperatorSkillDirect(input: {
    userId: number
    name: string
    description: string
    bodyMd: string
}) {
    const now = new Date()
    const [existing] = await getDb()
        .select()
        .from(assistantOperatorSkills)
        .where(and(
            eq(assistantOperatorSkills.userId, input.userId),
            eq(assistantOperatorSkills.name, input.name),
        ))
        .limit(1)
    if (existing) {
        await getDb()
            .update(assistantOperatorSkills)
            .set({
                description: input.description,
                bodyMd: input.bodyMd,
                version: existing.version + 1,
                status: "active",
                updatedAt: now,
            })
            .where(eq(assistantOperatorSkills.id, existing.id))
        return existing.version + 1
    }
    await getDb()
        .insert(assistantOperatorSkills)
        .values({
            userId: input.userId,
            name: input.name,
            description: input.description,
            bodyMd: input.bodyMd,
            version: 1,
            status: "active",
            updatedAt: now,
        })
    return 1
}

export function listBuiltinSkillNames(): string[] {
    return ASSISTANT_SKILLS.map((skill: AssistantSkillDefinition) => skill.name)
}
