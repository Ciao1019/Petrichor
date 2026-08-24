import { eq } from "drizzle-orm"
import type { AppRequest } from "@/server/http/request"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import { siteAppearance, users } from "@/server/db/schema"
import { isSuperAdmin } from "@/server/admin/logic"
import { forbidden, ok, readJson, toErrorResponse, unauthorized } from "@/server/http/response"
import { invalidatePublicSiteAppearanceCache } from "@/server/public-content-cache"
import { loadCachedPublicSiteAppearance, loadSiteAppearanceOrNull } from "./public-loader"
import {
    SITE_APPEARANCE_ID,
    buildSiteAppearanceResponse,
    validateSiteAppearanceInput,
} from "./logic"

type User = Awaited<ReturnType<typeof requireCurrentUser>>

async function withPublic(request: AppRequest, handler: () => Promise<Response>) {
    try {
        return await handler()
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

async function requireSuperAdminUser(user: User) {
    const [freshUser] = await getDb()
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

async function withAdmin(request: AppRequest, handler: (user: User) => Promise<Response>) {
    try {
        const user = await requireCurrentUser(request)
        await requireSuperAdminUser(user)
        return await handler(user)
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

export async function publicSiteAppearance(request: AppRequest) {
    return withPublic(request, async () => {
        return ok(await loadCachedPublicSiteAppearance())
    })
}

export async function adminSiteAppearanceDetail(request: AppRequest) {
    return withAdmin(request, async () => {
        const record = await loadSiteAppearanceOrNull()
        return ok(buildSiteAppearanceResponse(record))
    })
}

export async function adminSiteAppearanceUpdate(request: AppRequest) {
    return withAdmin(request, async () => {
        const input = validateSiteAppearanceInput(await readJson(request))
        const now = new Date()
        const [record] = await getDb()
            .insert(siteAppearance)
            .values({
                id: SITE_APPEARANCE_ID,
                publicQaEnabled: input.publicQaEnabled,
                updatedAt: now,
            })
            .onConflictDoUpdate({
                target: siteAppearance.id,
                set: {
                    publicQaEnabled: input.publicQaEnabled,
                    updatedAt: now,
                },
            })
            .returning()

        invalidatePublicSiteAppearanceCache()
        return ok(buildSiteAppearanceResponse(record))
    })
}
