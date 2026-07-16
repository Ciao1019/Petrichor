import { and, eq } from "drizzle-orm"
import { getDb } from "@/server/db/client"
import { assistantOperatorProfiles, assistantThreads } from "@/server/db/schema"
import {
    assertAssistantOperator,
    isAssistantOperator,
    type AssistantOperatorUser,
} from "./operator-gate"

export const OPERATOR_USER_PROFILE_MAX_CHARS = 1375
export const OPERATOR_AGENT_NOTES_MAX_CHARS = 2200
export const OPERATOR_MEMORY_TOTAL_MAX_CHARS = 3575

export const OPERATOR_MEMORY_PROMPT_TITLE = "操作员常驻记忆（本线程冻结快照）"

export type OperatorMemoryTarget = "user_profile" | "agent_notes"

export type OperatorMemorySnapshot = {
    userProfileMd: string
    agentNotesMd: string
    frozenAt: string
}

export type OperatorMemoryMutateInput =
    | { action: "add"; target: OperatorMemoryTarget; text: string }
    | { action: "replace"; target: OperatorMemoryTarget; old_text: string; new_text: string }
    | { action: "remove"; target: OperatorMemoryTarget; old_text: string }

export type OperatorMemoryMutateResult =
    | {
        ok: true
        userProfileChars: number
        agentNotesChars: number
        applied: "profile_only"
    }
    | {
        ok: false
        errorCode: "assistant_operator_only" | "memory_limit_exceeded" | "invalid_patch"
    }

export function checkOperatorMemoryLimits(userProfileMd: string, agentNotesMd: string): boolean {
    if (userProfileMd.length > OPERATOR_USER_PROFILE_MAX_CHARS) return false
    if (agentNotesMd.length > OPERATOR_AGENT_NOTES_MAX_CHARS) return false
    if (userProfileMd.length + agentNotesMd.length > OPERATOR_MEMORY_TOTAL_MAX_CHARS) return false
    return true
}

/** 纯函数：对两块短文应用一次 mutate；失败返回 errorCode。 */
export function applyOperatorMemoryMutation(
    userProfileMd: string,
    agentNotesMd: string,
    input: OperatorMemoryMutateInput,
): { ok: true; userProfileMd: string; agentNotesMd: string } | { ok: false; errorCode: "invalid_patch" | "memory_limit_exceeded" } {
    let nextProfile = userProfileMd
    let nextNotes = agentNotesMd
    const targetIsProfile = input.target === "user_profile"
    const current = targetIsProfile ? nextProfile : nextNotes

    if (input.action === "add") {
        const text = input.text.trim()
        if (!text) return { ok: false, errorCode: "invalid_patch" }
        const next = current.trim() ? `${current.trimEnd()}\n${text}` : text
        if (targetIsProfile) nextProfile = next
        else nextNotes = next
    } else if (input.action === "replace") {
        if (!input.old_text || !current.includes(input.old_text)) {
            return { ok: false, errorCode: "invalid_patch" }
        }
        const next = current.replace(input.old_text, input.new_text)
        if (targetIsProfile) nextProfile = next
        else nextNotes = next
    } else {
        if (!input.old_text || !current.includes(input.old_text)) {
            return { ok: false, errorCode: "invalid_patch" }
        }
        const next = current.replace(input.old_text, "")
        if (targetIsProfile) nextProfile = next
        else nextNotes = next
    }

    if (!checkOperatorMemoryLimits(nextProfile, nextNotes)) {
        return { ok: false, errorCode: "memory_limit_exceeded" }
    }
    return { ok: true, userProfileMd: nextProfile, agentNotesMd: nextNotes }
}

export function formatOperatorMemoryPromptSection(snapshot: OperatorMemorySnapshot): string {
    return [
        OPERATOR_MEMORY_PROMPT_TITLE,
        "",
        "## 用户画像",
        snapshot.userProfileMd.trim() || "（空）",
        "",
        "## 约定与笔记",
        snapshot.agentNotesMd.trim() || "（空）",
    ].join("\n")
}

export function parseOperatorMemorySnapshot(raw: string | null | undefined): OperatorMemorySnapshot | null {
    if (!raw?.trim()) return null
    try {
        const parsed = JSON.parse(raw) as Partial<OperatorMemorySnapshot>
        if (typeof parsed.userProfileMd !== "string" || typeof parsed.agentNotesMd !== "string") {
            return null
        }
        return {
            userProfileMd: parsed.userProfileMd,
            agentNotesMd: parsed.agentNotesMd,
            frozenAt: typeof parsed.frozenAt === "string" ? parsed.frozenAt : new Date(0).toISOString(),
        }
    } catch {
        return null
    }
}

async function readOperatorProfile(userId: number): Promise<{ userProfileMd: string; agentNotesMd: string }> {
    const [row] = await getDb()
        .select()
        .from(assistantOperatorProfiles)
        .where(eq(assistantOperatorProfiles.userId, userId))
        .limit(1)
    return {
        userProfileMd: row?.userProfileMd ?? "",
        agentNotesMd: row?.agentNotesMd ?? "",
    }
}

/**
 * 非操作员 → null。
 * 线程无快照时从 profile 固化后返回格式化段；已有快照则只用快照。
 */
export async function loadOperatorMemoryPromptSection(
    user: AssistantOperatorUser,
    threadId: number,
): Promise<string | null> {
    if (!isAssistantOperator(user)) return null

    const db = getDb()
    const [thread] = await db
        .select({
            id: assistantThreads.id,
            userId: assistantThreads.userId,
            snapshotJson: assistantThreads.operatorMemorySnapshotJson,
        })
        .from(assistantThreads)
        .where(and(eq(assistantThreads.id, threadId), eq(assistantThreads.userId, user.id)))
        .limit(1)
    if (!thread) return null

    const existing = parseOperatorMemorySnapshot(thread.snapshotJson)
    if (existing) {
        return formatOperatorMemoryPromptSection(existing)
    }

    const profile = await readOperatorProfile(user.id)
    const snapshot: OperatorMemorySnapshot = {
        userProfileMd: profile.userProfileMd,
        agentNotesMd: profile.agentNotesMd,
        frozenAt: new Date().toISOString(),
    }
    await db
        .update(assistantThreads)
        .set({
            operatorMemorySnapshotJson: JSON.stringify(snapshot),
            updatedAt: new Date(),
        })
        .where(and(eq(assistantThreads.id, threadId), eq(assistantThreads.userId, user.id)))

    return formatOperatorMemoryPromptSection(snapshot)
}

export async function mutateOperatorProfile(
    user: AssistantOperatorUser,
    input: OperatorMemoryMutateInput,
): Promise<OperatorMemoryMutateResult> {
    if (!isAssistantOperator(user)) {
        return { ok: false, errorCode: "assistant_operator_only" }
    }

    const profile = await readOperatorProfile(user.id)
    const applied = applyOperatorMemoryMutation(profile.userProfileMd, profile.agentNotesMd, input)
    if (!applied.ok) {
        return { ok: false, errorCode: applied.errorCode }
    }

    const now = new Date()
    await getDb()
        .insert(assistantOperatorProfiles)
        .values({
            userId: user.id,
            userProfileMd: applied.userProfileMd,
            agentNotesMd: applied.agentNotesMd,
            updatedAt: now,
        })
        .onConflictDoUpdate({
            target: assistantOperatorProfiles.userId,
            set: {
                userProfileMd: applied.userProfileMd,
                agentNotesMd: applied.agentNotesMd,
                updatedAt: now,
            },
        })

    return {
        ok: true,
        userProfileChars: applied.userProfileMd.length,
        agentNotesChars: applied.agentNotesMd.length,
        applied: "profile_only",
    }
}

/** HTTP 写路径用：非操作员直接 403 */
export function requireOperatorForMemoryWrite(user: AssistantOperatorUser): void {
    assertAssistantOperator(user)
}
