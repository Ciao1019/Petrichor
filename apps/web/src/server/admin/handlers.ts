import { and, count, eq, ilike, or } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { createLocalUserWithBetterAuth } from "@/server/auth/better-auth-bridge"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import { betterAuthUsers, users } from "@/server/db/schema"
import { badRequest, forbidden, notFound, ok, readJson, tableData, toErrorResponse, unauthorized } from "@/server/http/response"
import {
    buildAdminUserItem,
    isSuperAdmin,
    normalizeAdminPagination,
    resolveAdminUserOrder,
    toAdminOrderBy,
    validateAdminCreateInput,
    validateAdminDeleteInput,
    validateAdminKeyword,
} from "./logic"

type User = Awaited<ReturnType<typeof requireCurrentUser>>

async function requireSuperAdminUser(user: User) {
    const db = getDb()
    const [freshUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1)

    if (!freshUser) {
        throw unauthorized("登录信息已失效")
    }
    if (!isSuperAdmin(freshUser.systemRole, freshUser.id)) {
        throw forbidden("仅超级管理员可执行该操作")
    }
    return freshUser
}

async function withAdmin(request: NextRequest, handler: (user: User) => Promise<Response>) {
    try {
        const user = await requireCurrentUser(request)
        await requireSuperAdminUser(user)
        return await handler(user)
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function listAdminUsers(request: NextRequest) {
    return withAdmin(request, async () => {
        const raw = await readJson<Record<string, unknown>>(request)
        const keyword = validateAdminKeyword(raw.keyword).trim()
        const { pageNum, pageSize } = normalizeAdminPagination(raw)
        const orderBy = toAdminOrderBy(resolveAdminUserOrder(raw))
        const db = getDb()
        const filters = keyword
            ? or(
                ilike(users.email, `%${keyword}%`),
                ilike(users.username, `%${keyword}%`),
                ilike(users.nickname, `%${keyword}%`),
            )
            : undefined

        const [totalRow] = await db
            .select({ total: count() })
            .from(users)
            .where(filters)

        const rows = await db
            .select()
            .from(users)
            .where(filters)
            .orderBy(...orderBy)
            .limit(pageSize)
            .offset((pageNum - 1) * pageSize)

        return tableData(rows.map(buildAdminUserItem), totalRow?.total ?? 0)
    })
}

export async function createAdminUser(request: NextRequest) {
    return withAdmin(request, async () => {
        const input = validateAdminCreateInput(await readJson(request))
        const db = getDb()
        const [existing] = await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, input.email))
            .limit(1)

        if (existing) {
            throw badRequest("邮箱已被注册")
        }

        const user = await createLocalUserWithBetterAuth({
            email: input.email,
            password: input.password,
            name: input.name,
            systemRole: input.systemRole ?? "USER",
        })

        return ok(buildAdminUserItem(user))
    })
}

export async function deleteAdminUser(request: NextRequest) {
    return withAdmin(request, async (currentUser) => {
        const input = validateAdminDeleteInput(await readJson(request))
        if (input.userId === currentUser.id) {
            throw badRequest("不允许删除当前登录用户")
        }

        const db = getDb()
        const [target] = await db
            .select()
            .from(users)
            .where(eq(users.id, input.userId))
            .limit(1)

        if (!target) {
            throw notFound("用户不存在")
        }

        if (isSuperAdmin(target.systemRole, target.id)) {
            const [countRow] = await db
                .select({ total: count() })
                .from(users)
                .where(eq(users.systemRole, "SUPER_ADMIN"))

            if ((countRow?.total ?? 0) <= 1) {
                throw badRequest("至少保留一个超级管理员")
            }
        }

        await db.transaction(async (tx) => {
            if (target.authUserId?.trim()) {
                await tx.delete(betterAuthUsers).where(eq(betterAuthUsers.id, target.authUserId))
            }
            await tx
                .delete(users)
                .where(and(eq(users.id, input.userId), eq(users.id, target.id)))
        })

        return ok({})
    })
}
