import { and, eq, isNull } from "drizzle-orm"
import { getDb } from "@/server/db/client"
import { assistantThreads } from "@/server/db/schema"

export const DANGER_ALLOWLIST_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 永不进入会话 allowlist 的破坏性工具（每次仍需确认卡）。
 * 对齐计划：delete_* / revoke_* / set_public_qa_enabled。
 */
export const DESTRUCTIVE_CRITICAL_TOOL_NAMES = new Set([
    "delete_article",
    "delete_document",
    "delete_ai_provider",
    "revoke_article_share",
    "revoke_agent_api_key",
    "set_public_qa_enabled",
])

export type DangerAllowlistState = {
    toolNames: string[]
    updatedAt: string
}

export function isDestructiveCriticalTool(toolName: string): boolean {
    return DESTRUCTIVE_CRITICAL_TOOL_NAMES.has(toolName)
}

export function parseDangerAllowlistJson(raw: string | null | undefined): DangerAllowlistState | null {
    if (!raw?.trim()) return null
    try {
        const parsed = JSON.parse(raw) as unknown
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
        const record = parsed as { toolNames?: unknown; updatedAt?: unknown }
        if (!Array.isArray(record.toolNames) || typeof record.updatedAt !== "string") return null
        const toolNames = record.toolNames.filter((item): item is string => typeof item === "string" && item.length > 0)
        return { toolNames, updatedAt: record.updatedAt }
    } catch {
        return null
    }
}

export function isAllowlistExpired(state: DangerAllowlistState, now = Date.now()): boolean {
    const updatedAt = Date.parse(state.updatedAt)
    if (!Number.isFinite(updatedAt)) return true
    return now - updatedAt > DANGER_ALLOWLIST_TTL_MS
}

/** 读取线程 allowlist；过期则清空并返回空。 */
export async function getThreadDangerAllowlist(input: {
    threadId: number
    userId: number
}): Promise<Set<string>> {
    const [thread] = await getDb()
        .select({ dangerAllowlistJson: assistantThreads.dangerAllowlistJson })
        .from(assistantThreads)
        .where(and(
            eq(assistantThreads.id, input.threadId),
            eq(assistantThreads.userId, input.userId),
            isNull(assistantThreads.deletedAt),
        ))
        .limit(1)

    const state = parseDangerAllowlistJson(thread?.dangerAllowlistJson)
    if (!state) return new Set()
    if (isAllowlistExpired(state)) {
        await clearThreadDangerAllowlist(input)
        return new Set()
    }
    return new Set(state.toolNames)
}

export async function isToolInThreadDangerAllowlist(input: {
    threadId: number
    userId: number
    toolName: string
}): Promise<boolean> {
    if (isDestructiveCriticalTool(input.toolName)) return false
    const names = await getThreadDangerAllowlist(input)
    return names.has(input.toolName)
}

export async function addToolToThreadDangerAllowlist(input: {
    threadId: number
    userId: number
    toolName: string
}): Promise<void> {
    if (isDestructiveCriticalTool(input.toolName)) return
    const existing = await getThreadDangerAllowlist(input)
    existing.add(input.toolName)
    const next: DangerAllowlistState = {
        toolNames: [...existing].sort(),
        updatedAt: new Date().toISOString(),
    }
    await getDb()
        .update(assistantThreads)
        .set({
            dangerAllowlistJson: JSON.stringify(next),
            updatedAt: new Date(),
        })
        .where(and(
            eq(assistantThreads.id, input.threadId),
            eq(assistantThreads.userId, input.userId),
            isNull(assistantThreads.deletedAt),
        ))
}

export async function clearThreadDangerAllowlist(input: {
    threadId: number
    userId: number
}): Promise<void> {
    await getDb()
        .update(assistantThreads)
        .set({
            dangerAllowlistJson: null,
            updatedAt: new Date(),
        })
        .where(and(
            eq(assistantThreads.id, input.threadId),
            eq(assistantThreads.userId, input.userId),
        ))
}
