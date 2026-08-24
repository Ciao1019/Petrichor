import { and, desc, eq, gt, ne } from "drizzle-orm"
import type { AppRequest } from "@/server/http/request"
import { z } from "zod"
import { getDb } from "@/server/db/client"
import { betterAuthSessions, betterAuthUsers } from "@/server/db/schema"
import { badRequest, notFound, ok, readJson, toErrorResponse, unauthorized } from "@/server/http/response"
import { auth } from "./better-auth"
import { requireCurrentUser } from "./current-user"

type CurrentUser = Awaited<ReturnType<typeof requireCurrentUser>>

type SessionItem = {
    id: string
    ip: string | null
    userAgent: string | null
    createdAt: string
    lastActiveAt: string
    expiresAt: string
    current: boolean
}

const revokeSchema = z.object({
    sessionId: z.string().trim().min(1, "缺少会话标识"),
    code: z.string().trim().min(1, "请输入 TOTP 验证码"),
})

const revokeOthersSchema = z.object({
    code: z.string().trim().min(1, "请输入 TOTP 验证码"),
})

// 读取当前请求对应的 Better Auth 会话 id，用于标记“当前登录”并避免误踢自己。
async function getCurrentSessionId(request: AppRequest): Promise<string | null> {
    const session = await auth.api.getSession({ headers: request.headers }).catch(() => null)
    return session?.session?.id ?? null
}

// 校验当前登录账户的 TOTP 验证码：仅校验、不产生会话副作用。
// 校验失败或未启用二步验证时抛出对应的业务错误。
async function verifyTotpOrThrow(request: AppRequest, code: string) {
    try {
        await auth.api.verifyTOTP({
            body: { code },
            headers: request.headers,
        })
    } catch (error) {
        const candidate = error as {
            status?: number | string
            statusCode?: number
            body?: { code?: string; message?: string }
        }
        const errorCode = candidate.body?.code
        if (errorCode === "TOTP_NOT_ENABLED" || errorCode === "TWO_FACTOR_NOT_ENABLED") {
            throw badRequest("请先启用二步验证（TOTP）后再执行下线操作")
        }
        throw badRequest("TOTP 验证码不正确，请重试")
    }
}

async function getTwoFactorEnabled(authUserId: string | null): Promise<boolean> {
    if (!authUserId) {
        return false
    }
    const [row] = await getDb()
        .select({ twoFactorEnabled: betterAuthUsers.twoFactorEnabled })
        .from(betterAuthUsers)
        .where(eq(betterAuthUsers.id, authUserId))
        .limit(1)
    return Boolean(row?.twoFactorEnabled)
}

function requireAuthUserId(user: CurrentUser): string {
    const authUserId = user.authUserId?.trim()
    if (!authUserId) {
        throw badRequest("当前账户不支持会话管理")
    }
    return authUserId
}

// 列出当前账户所有有效登录会话（含登录 IP、设备信息），并标记当前登录。
export async function listSessions(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const authUserId = user.authUserId?.trim() ?? null
        const twoFactorEnabled = await getTwoFactorEnabled(authUserId)

        if (!authUserId) {
            return ok({ sessions: [], currentSessionId: null, twoFactorEnabled })
        }

        const currentSessionId = await getCurrentSessionId(request)
        const rows = await getDb()
            .select({
                id: betterAuthSessions.id,
                ip: betterAuthSessions.ipAddress,
                userAgent: betterAuthSessions.userAgent,
                createdAt: betterAuthSessions.createdAt,
                updatedAt: betterAuthSessions.updatedAt,
                expiresAt: betterAuthSessions.expiresAt,
            })
            .from(betterAuthSessions)
            .where(and(
                eq(betterAuthSessions.userId, authUserId),
                gt(betterAuthSessions.expiresAt, new Date()),
            ))
            .orderBy(desc(betterAuthSessions.updatedAt))

        const sessions: SessionItem[] = rows.map((row) => ({
            id: row.id,
            ip: row.ip,
            userAgent: row.userAgent,
            createdAt: row.createdAt.toISOString(),
            lastActiveAt: row.updatedAt.toISOString(),
            expiresAt: row.expiresAt.toISOString(),
            current: currentSessionId != null && row.id === currentSessionId,
        }))

        return ok({ sessions, currentSessionId, twoFactorEnabled })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

// 下线指定会话：需校验 TOTP，且不能下线当前登录会话。
export async function revokeSession(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const authUserId = requireAuthUserId(user)
        const input = revokeSchema.parse(await readJson(request))

        const currentSessionId = await getCurrentSessionId(request)
        if (currentSessionId && input.sessionId === currentSessionId) {
            throw badRequest("不能下线当前登录的会话")
        }

        const db = getDb()
        const [target] = await db
            .select({ id: betterAuthSessions.id })
            .from(betterAuthSessions)
            .where(and(
                eq(betterAuthSessions.id, input.sessionId),
                eq(betterAuthSessions.userId, authUserId),
            ))
            .limit(1)

        if (!target) {
            throw notFound("会话不存在或已下线")
        }

        await verifyTotpOrThrow(request, input.code)

        await db
            .delete(betterAuthSessions)
            .where(and(
                eq(betterAuthSessions.id, input.sessionId),
                eq(betterAuthSessions.userId, authUserId),
            ))

        return ok({ success: true })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

// 一键下线当前账户除当前登录外的所有会话：需校验 TOTP。
export async function revokeOtherSessions(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const authUserId = requireAuthUserId(user)
        const input = revokeOthersSchema.parse(await readJson(request))

        const currentSessionId = await getCurrentSessionId(request)
        if (!currentSessionId) {
            throw unauthorized("登录信息已失效，请重新登录")
        }

        await verifyTotpOrThrow(request, input.code)

        const deleted = await getDb()
            .delete(betterAuthSessions)
            .where(and(
                eq(betterAuthSessions.userId, authUserId),
                ne(betterAuthSessions.id, currentSessionId),
            ))
            .returning({ id: betterAuthSessions.id })

        return ok({ success: true, revokedCount: deleted.length })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}
