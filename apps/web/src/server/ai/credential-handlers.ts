/**
 * 凭证库接口。
 *
 * API Key 从供应商配置里独立出来单独管理：填一次，之后在供应商表单里下拉选择。
 * 这样同一个 Key 接多个 BaseUrl（官方端点 + 代理）不用重复粘贴，轮换 Key 也只改一处。
 */

import { and, count, desc, eq, sql } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { aiCredentials, aiProviders } from "@/server/db/schema"
import { getDb } from "@/server/db/client"
import { badRequest, notFound, ok, readJson, toErrorResponse } from "@/server/http/response"
import {
    buildCredentialResponse,
    encodeApiKey,
    encodeExtra,
    decodeExtra,
    requireId,
    validateCredentialInput,
} from "@/server/ai/config-logic"

type User = Awaited<ReturnType<typeof requireCurrentUser>>

async function withUser(request: NextRequest, handler: (user: User) => Promise<Response>) {
    try {
        return await handler(await requireCurrentUser(request))
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function listAiCredentials(request: NextRequest) {
    return withUser(request, async (user) => {
        const db = getDb()
        const rows = await db
            .select()
            .from(aiCredentials)
            .where(eq(aiCredentials.userId, user.id))
            .orderBy(desc(aiCredentials.updatedAt), desc(aiCredentials.id))

        // 被多少个供应商实例引用，用于删除前提示
        const usage = await db
            .select({ credentialId: aiProviders.credentialId, total: count() })
            .from(aiProviders)
            .where(eq(aiProviders.userId, user.id))
            .groupBy(aiProviders.credentialId)
        const usageMap = new Map(usage.map((row) => [row.credentialId, row.total]))

        return ok({ items: rows.map((row) => buildCredentialResponse(row, usageMap.get(row.id) ?? 0)) })
    })
}

export async function createAiCredential(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = validateCredentialInput(await readJson(request), { requireApiKey: true })
        await ensureUniqueName(user.id, input.name)

        const [record] = await getDb()
            .insert(aiCredentials)
            .values({
                userId: user.id,
                name: input.name,
                providerKey: input.providerKey,
                apiKeyEnc: encodeApiKey(input.apiKey),
                extraEnc: encodeExtra(input.extra),
            })
            .returning()
        return ok(buildCredentialResponse(record))
    })
}

export async function updateAiCredential(request: NextRequest) {
    return withUser(request, async (user) => {
        const raw = await readJson<Record<string, unknown>>(request)
        const id = requireId(raw.id, "凭证 ID")
        const existing = await findOwned(user.id, id)

        // apiKey 留空表示不改，避免编辑其它字段时被迫重新粘贴 Key
        const input = validateCredentialInput(
            { ...raw, name: raw.name ?? existing.name },
            { requireApiKey: false },
        )
        if (input.name !== existing.name) {
            await ensureUniqueName(user.id, input.name, id)
        }

        // 额外字段同理：没传就沿用旧值，传了就整体覆盖
        const extra = Object.keys(input.extra).length > 0 ? input.extra : decodeExtra(existing.extraEnc)

        const [updated] = await getDb()
            .update(aiCredentials)
            .set({
                name: input.name,
                providerKey: input.providerKey,
                ...(input.apiKey ? { apiKeyEnc: encodeApiKey(input.apiKey) } : {}),
                extraEnc: encodeExtra(extra),
                updatedAt: new Date(),
            })
            .where(and(eq(aiCredentials.id, id), eq(aiCredentials.userId, user.id)))
            .returning()
        return ok(buildCredentialResponse(updated))
    })
}

export async function deleteAiCredential(request: NextRequest) {
    return withUser(request, async (user) => {
        const raw = await readJson<Record<string, unknown>>(request)
        const id = requireId(raw.id, "凭证 ID")
        await findOwned(user.id, id)

        const [inUse] = await getDb()
            .select({ total: count() })
            .from(aiProviders)
            .where(and(eq(aiProviders.userId, user.id), eq(aiProviders.credentialId, id)))
        if ((inUse?.total ?? 0) > 0) {
            throw badRequest(`该凭证正被 ${inUse.total} 个供应商使用，请先解除引用再删除`)
        }

        await getDb().delete(aiCredentials).where(and(eq(aiCredentials.id, id), eq(aiCredentials.userId, user.id)))
        return new NextResponse(null, { status: 200 })
    })
}

/** 供应商成功调用后记录一次使用时间，便于识别僵尸凭证 */
export async function touchCredential(credentialId: number) {
    await getDb()
        .update(aiCredentials)
        .set({ lastUsedAt: sql`now()` })
        .where(eq(aiCredentials.id, credentialId))
}

async function findOwned(userId: number, id: number) {
    const [record] = await getDb()
        .select()
        .from(aiCredentials)
        .where(and(eq(aiCredentials.id, id), eq(aiCredentials.userId, userId)))
        .limit(1)
    if (!record) {
        throw notFound("凭证不存在")
    }
    return record
}

async function ensureUniqueName(userId: number, name: string, excludeId?: number) {
    const rows = await getDb()
        .select({ id: aiCredentials.id })
        .from(aiCredentials)
        .where(and(eq(aiCredentials.userId, userId), eq(aiCredentials.name, name)))
        .limit(2)
    if (rows.some((row) => row.id !== excludeId)) {
        throw badRequest("已存在同名凭证")
    }
}
