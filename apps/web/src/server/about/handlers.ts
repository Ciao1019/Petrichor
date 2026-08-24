import { eq } from "drizzle-orm"
import type { AppRequest } from "@/server/http/request"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import { siteAboutProfiles, users } from "@/server/db/schema"
import { isSuperAdmin } from "@/server/admin/logic"
import { forbidden, ok, readJson, toErrorResponse, unauthorized } from "@/server/http/response"
import { cachePublicContent, invalidatePublicAboutProfileCache } from "@/server/public-content-cache"
import {
    ABOUT_PROFILE_ID,
    buildAboutProfileResponse,
    serializeAccents,
    serializeProfileList,
    validateAboutProfileInput,
} from "./logic"

type User = Awaited<ReturnType<typeof requireCurrentUser>>

const loadCachedPublicAboutProfile = cachePublicContent("aboutProfile", loadPublicAboutProfileResponse)

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

export async function publicAboutProfile(request: AppRequest) {
    return withPublic(request, async () => {
        return ok(await loadCachedPublicAboutProfile())
    })
}

export async function adminAboutProfileDetail(request: AppRequest) {
    return withAdmin(request, async () => {
        const profile = await loadAboutProfileOrNull()
        return ok(buildAboutProfileResponse(profile))
    })
}

export async function adminAboutProfileUpdate(request: AppRequest) {
    return withAdmin(request, async () => {
        const input = validateAboutProfileInput(await readJson(request))
        const now = new Date()
        const [profile] = await getDb()
            .insert(siteAboutProfiles)
            .values({
                id: ABOUT_PROFILE_ID,
                displayName: input.displayName,
                roleTitle: input.roleTitle,
                intro: input.intro,
                expertiseJson: serializeProfileList(input.expertise),
                toolkitJson: serializeProfileList(input.toolkit),
                quote: input.quote,
                accentsJson: serializeAccents(input.accents),
                contactText: input.contactText,
                contactLabel: input.contactLabel,
                contactHref: input.contactHref,
                updatedAt: now,
            })
            .onConflictDoUpdate({
                target: siteAboutProfiles.id,
                set: {
                    displayName: input.displayName,
                    roleTitle: input.roleTitle,
                    intro: input.intro,
                    expertiseJson: serializeProfileList(input.expertise),
                    toolkitJson: serializeProfileList(input.toolkit),
                    quote: input.quote,
                    accentsJson: serializeAccents(input.accents),
                    contactText: input.contactText,
                    contactLabel: input.contactLabel,
                    contactHref: input.contactHref,
                    updatedAt: now,
                },
            })
            .returning()

        invalidatePublicAboutProfileCache()
        return ok(buildAboutProfileResponse(profile))
    })
}

async function loadPublicAboutProfileResponse() {
    const profile = await loadAboutProfileOrNull()
    return buildAboutProfileResponse(profile)
}

async function loadAboutProfileOrNull() {
    try {
        const [profile] = await getDb()
            .select()
            .from(siteAboutProfiles)
            .where(eq(siteAboutProfiles.id, ABOUT_PROFILE_ID))
            .limit(1)
        return profile ?? null
    } catch (error) {
        // 读取接口允许在增量 SQL 尚未执行时回退默认值；写入仍要求先应用迁移。
        if (isMissingAboutProfileTableError(error)) {
            return null
        }
        throw error
    }
}

function isMissingAboutProfileTableError(error: unknown) {
    const parts = collectErrorParts(error).join("\n").toLowerCase()
    return parts.includes("petrichor_site_about_profile") &&
        (parts.includes("42p01") || parts.includes("does not exist") || parts.includes("relation"))
}

function collectErrorParts(error: unknown): string[] {
    const parts: string[] = []
    let current: unknown = error
    const visited = new Set<unknown>()

    while (current && typeof current === "object" && !visited.has(current)) {
        visited.add(current)
        const record = current as Record<string, unknown>
        if (typeof record.message === "string") {
            parts.push(record.message)
        }
        if (typeof record.code === "string") {
            parts.push(record.code)
        }
        current = record.cause
    }

    return parts
}
