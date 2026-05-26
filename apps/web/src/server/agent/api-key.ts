import { createHash, randomBytes } from "node:crypto"
import { and, eq, gt, isNull, or } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { z } from "zod"
import { getDb } from "@/server/db/client"
import { agentApiKeys, type AgentApiKeyRecord } from "@/server/db/schema"
import { badRequest, forbidden, unauthorized } from "@/server/http/response"

export const AGENT_API_KEY_SCOPES = [
    "article:write",
    "article:delete",
    "doc:read",
    "qa:read",
    "share:write",
    "ai:write",
] as const

export type AgentApiKeyScope = typeof AGENT_API_KEY_SCOPES[number]

export type AgentAuthContext = {
    apiKey: AgentApiKeyRecord
    scopes: AgentApiKeyScope[]
    userId: number
}

const scopeSet = new Set<string>(AGENT_API_KEY_SCOPES)

export const agentApiKeyCreateSchema = z.object({
    expiresAt: z.string().datetime().optional().nullable(),
    name: z.string().trim().min(1).max(80).default("Agent Skill Key"),
    scopes: z.array(z.enum(AGENT_API_KEY_SCOPES)).optional().default([...AGENT_API_KEY_SCOPES]),
})

export const agentApiKeyRevokeSchema = z.object({
    id: z.union([z.string(), z.number()]).transform((value, ctx) => {
        const raw = String(value).trim()
        if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
            ctx.addIssue({ code: "custom", message: "ID 必须是正整数" })
            return z.NEVER
        }
        return Number(raw)
    }),
})

export function generateAgentApiKey() {
    return `ptc_live_${randomBytes(32).toString("base64url")}`
}

export function hashAgentApiKey(apiKey: string) {
    return createHash("sha256").update(apiKey, "utf8").digest("hex")
}

export function toAgentApiKeyPrefix(apiKey: string) {
    const trimmed = apiKey.trim()
    return `${trimmed.slice(0, 16)}...`
}

export function extractAgentBearerToken(request: Request) {
    const authorization = request.headers.get("authorization")?.trim() ?? ""
    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i)
    if (bearerMatch?.[1]?.trim()) {
        return bearerMatch[1].trim()
    }

    const apiKeyHeader = request.headers.get("x-petrichor-api-key")?.trim()
    return apiKeyHeader || null
}

export function parseAgentScopes(raw: string | null | undefined): AgentApiKeyScope[] {
    if (!raw?.trim()) return []
    try {
        const parsed = JSON.parse(raw) as unknown
        if (!Array.isArray(parsed)) return []
        return parsed.filter((item): item is AgentApiKeyScope => typeof item === "string" && scopeSet.has(item))
    } catch {
        return []
    }
}

export function hasAgentScope(scopes: AgentApiKeyScope[], required: AgentApiKeyScope) {
    return scopes.includes(required)
}

export function requireAgentScope(context: AgentAuthContext, required: AgentApiKeyScope) {
    if (!hasAgentScope(context.scopes, required)) {
        throw forbidden(`当前 API Key 缺少 ${required} 权限`)
    }
}

export async function authenticateAgentRequest(request: NextRequest): Promise<AgentAuthContext> {
    const apiKey = extractAgentBearerToken(request)
    if (!apiKey) {
        throw unauthorized("缺少 Agent API Key")
    }

    const keyHash = hashAgentApiKey(apiKey)
    const now = new Date()
    const db = getDb()
    const [record] = await db
        .select()
        .from(agentApiKeys)
        .where(and(
            eq(agentApiKeys.keyHash, keyHash),
            isNull(agentApiKeys.revokedAt),
            or(isNull(agentApiKeys.expiresAt), gt(agentApiKeys.expiresAt, now)),
        ))
        .limit(1)

    if (!record) {
        throw unauthorized("Agent API Key 无效或已过期")
    }

    await db
        .update(agentApiKeys)
        .set({ lastUsedAt: now, updatedAt: now })
        .where(eq(agentApiKeys.id, record.id))

    return {
        apiKey: record,
        scopes: parseAgentScopes(record.scopesJson),
        userId: record.userId,
    }
}

export function parseAgentApiKeyExpiresAt(value: string | null | undefined) {
    if (!value) return null
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
        throw badRequest("expiresAt 必须是合法时间")
    }
    if (date.getTime() <= Date.now()) {
        throw badRequest("expiresAt 必须晚于当前时间")
    }
    return date
}

export function toAgentApiKeyResponse(record: AgentApiKeyRecord) {
    return {
        id: String(record.id),
        name: record.name,
        keyPrefix: record.keyPrefix,
        scopes: parseAgentScopes(record.scopesJson),
        expiresAt: formatDate(record.expiresAt),
        lastUsedAt: formatDate(record.lastUsedAt),
        revokedAt: formatDate(record.revokedAt),
        createdAt: formatDate(record.createdAt),
        updatedAt: formatDate(record.updatedAt),
    }
}

function formatDate(value: Date | string | null | undefined): string | null {
    if (!value) return null
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
