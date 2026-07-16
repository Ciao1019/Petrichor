import { and, desc, eq, sql } from "drizzle-orm"
import { generateObject, type LanguageModel } from "ai"
import { z } from "zod"
import { createChatLanguageModel } from "@/server/ai/generation"
import { getDb } from "@/server/db/client"
import {
    assistantOperatorEvolutionProposals,
    assistantOperatorProfiles,
} from "@/server/db/schema"
import { badRequest, conflict, notFound } from "@/server/http/response"
import {
    assertAssistantOperator,
    type AssistantOperatorUser,
} from "./operator-gate"
import { mutateOperatorProfile } from "./operator-memory"
import { getMergedSkillBody, upsertOperatorSkillDirect } from "./operator-skills"

const busyUsers = new Set<number>()

export type EvolutionTargetType = "skill" | "user_profile" | "agent_notes"

export async function listEvolutionProposals(
    user: AssistantOperatorUser,
    status?: "pending" | "accepted" | "rejected",
) {
    assertAssistantOperator(user)
    const rows = status
        ? await getDb()
            .select()
            .from(assistantOperatorEvolutionProposals)
            .where(and(
                eq(assistantOperatorEvolutionProposals.userId, user.id),
                eq(assistantOperatorEvolutionProposals.status, status),
            ))
            .orderBy(desc(assistantOperatorEvolutionProposals.createdAt))
            .limit(50)
        : await getDb()
            .select()
            .from(assistantOperatorEvolutionProposals)
            .where(eq(assistantOperatorEvolutionProposals.userId, user.id))
            .orderBy(desc(assistantOperatorEvolutionProposals.createdAt))
            .limit(50)
    return rows.map((row) => ({
        id: String(row.id),
        targetType: row.targetType,
        targetName: row.targetName,
        beforeMd: row.beforeMd,
        afterMd: row.afterMd,
        rationaleMd: row.rationaleMd,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
    }))
}

export async function runEvolutionProposal(input: {
    user: AssistantOperatorUser
    targetType: EvolutionTargetType
    targetName?: string | null
    hint?: string | null
}) {
    assertAssistantOperator(input.user)
    if (busyUsers.has(input.user.id)) {
        throw conflict("evolution_busy")
    }
    busyUsers.add(input.user.id)
    try {
        const before = await loadEvolutionTarget(input.user, input.targetType, input.targetName)
        if (!before) throw badRequest("invalid_target")

        const traces = await loadRecentStepTraces(input.user.id)
        const { model } = await createChatLanguageModel({ userId: input.user.id })
        const generated = await generateEvolutionDraft({
            model: model as LanguageModel,
            targetType: input.targetType,
            targetName: input.targetName ?? null,
            beforeMd: before.body,
            hint: input.hint ?? null,
            traces,
        })

        const [row] = await getDb()
            .insert(assistantOperatorEvolutionProposals)
            .values({
                userId: input.user.id,
                targetType: input.targetType,
                targetName: input.targetName ?? null,
                beforeMd: before.body,
                afterMd: generated.afterMd,
                rationaleMd: generated.rationaleMd,
                status: "pending",
                createdAt: new Date(),
            })
            .returning({ id: assistantOperatorEvolutionProposals.id })

        return { proposalId: String(row!.id) }
    } finally {
        busyUsers.delete(input.user.id)
    }
}

async function loadEvolutionTarget(
    user: AssistantOperatorUser,
    targetType: EvolutionTargetType,
    targetName?: string | null,
) {
    if (targetType === "skill") {
        if (!targetName?.trim()) return null
        const skill = await getMergedSkillBody(targetName.trim(), user)
        if (!skill) return null
        return { body: skill.instructions, description: skill.description }
    }
    const [profile] = await getDb()
        .select()
        .from(assistantOperatorProfiles)
        .where(eq(assistantOperatorProfiles.userId, user.id))
        .limit(1)
    if (targetType === "user_profile") {
        return { body: profile?.userProfileMd ?? "", description: "用户画像" }
    }
    return { body: profile?.agentNotesMd ?? "", description: "约定与笔记" }
}

async function loadRecentStepTraces(userId: number): Promise<string> {
    try {
        const rows = await getDb().execute(sql`
            select s.tool_name, s.error_code, left(coalesce(s.input_json, ''), 200) as input_preview
            from petrichor_assistant_step s
            join petrichor_assistant_run r on r.id = s.run_id
            join petrichor_assistant_thread t on t.id = r.thread_id
            where t.user_id = ${userId}
            order by s.id desc
            limit 20
        `)
        const lines = [...(rows as unknown as Array<Record<string, unknown>>)]
            .map((row) => `- ${row.tool_name}${row.error_code ? ` err=${row.error_code}` : ""} ${row.input_preview ?? ""}`)
        return lines.join("\n").slice(0, 3000) || "（暂无近期步骤）"
    } catch {
        return "（暂无近期步骤）"
    }
}

async function generateEvolutionDraft(input: {
    model: LanguageModel
    targetType: string
    targetName: string | null
    beforeMd: string
    hint: string | null
    traces: string
}) {
    try {
        const result = await generateObject({
            model: input.model,
            schema: z.object({
                afterMd: z.string().min(1),
                rationaleMd: z.string().min(1),
            }),
            prompt: [
                "你是助手流程优化器。根据当前正文与近期工具轨迹，提出改进后的全文。",
                `目标类型: ${input.targetType}`,
                `目标名: ${input.targetName ?? "-"}`,
                `用户提示: ${input.hint ?? "无"}`,
                "当前正文:",
                input.beforeMd.slice(0, 6000) || "（空）",
                "近期轨迹:",
                input.traces,
                "要求: afterMd 是完整替换正文；rationaleMd 用中文说明为何更好。不要编造密钥。",
            ].join("\n\n"),
        })
        return {
            afterMd: result.object.afterMd.trim(),
            rationaleMd: result.object.rationaleMd.trim(),
        }
    } catch (error) {
        console.error("[assistant] evolution generate failed", error)
        return {
            afterMd: input.beforeMd.trim()
                ? `${input.beforeMd.trim()}\n\n<!-- evolution-fallback: 模型生成失败，请手工改写 -->`
                : "# 待完善\n\n<!-- evolution-fallback -->",
            rationaleMd: "模型生成失败，已放入带标记的草稿供人工编辑后接受或拒绝。",
        }
    }
}

export async function resolveEvolutionProposal(
    user: AssistantOperatorUser,
    proposalId: number,
    decision: "accept" | "reject",
) {
    assertAssistantOperator(user)
    const [row] = await getDb()
        .select()
        .from(assistantOperatorEvolutionProposals)
        .where(and(
            eq(assistantOperatorEvolutionProposals.id, proposalId),
            eq(assistantOperatorEvolutionProposals.userId, user.id),
        ))
        .limit(1)
    if (!row) throw notFound("proposal_not_found")
    if (row.status !== "pending") throw conflict("proposal_not_open")

    const now = new Date()
    if (decision === "reject") {
        await getDb()
            .update(assistantOperatorEvolutionProposals)
            .set({ status: "rejected", resolvedAt: now })
            .where(eq(assistantOperatorEvolutionProposals.id, row.id))
        return { ok: true as const, status: "rejected" as const }
    }

    if (row.targetType === "skill") {
        const name = row.targetName?.trim()
        if (!name) throw badRequest("invalid_target")
        await upsertOperatorSkillDirect({
            userId: user.id,
            name,
            description: `evolved:${name}`,
            bodyMd: row.afterMd,
        })
    } else if (row.targetType === "user_profile" || row.targetType === "agent_notes") {
        const target = row.targetType === "user_profile" ? "user_profile" as const : "agent_notes" as const
        const [profile] = await getDb()
            .select()
            .from(assistantOperatorProfiles)
            .where(eq(assistantOperatorProfiles.userId, user.id))
            .limit(1)
        const current = target === "user_profile"
            ? (profile?.userProfileMd ?? "")
            : (profile?.agentNotesMd ?? "")
        if (current) {
            await mutateOperatorProfile(user, {
                action: "replace",
                target,
                old_text: current,
                new_text: row.afterMd,
            })
        } else if (row.afterMd.trim()) {
            await mutateOperatorProfile(user, {
                action: "add",
                target,
                text: row.afterMd,
            })
        }
    } else {
        throw badRequest("invalid_target")
    }

    await getDb()
        .update(assistantOperatorEvolutionProposals)
        .set({ status: "accepted", resolvedAt: now })
        .where(eq(assistantOperatorEvolutionProposals.id, row.id))
    return { ok: true as const, status: "accepted" as const }
}
