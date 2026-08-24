import { eq } from "drizzle-orm"
import type { AppRequest } from "@/server/http/request"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import { siteProjectShowcase, users } from "@/server/db/schema"
import { isSuperAdmin } from "@/server/admin/logic"
import { forbidden, ok, readJson, toErrorResponse, unauthorized } from "@/server/http/response"
import { cachePublicContent, invalidatePublicProjectShowcaseCache } from "@/server/public-content-cache"
import {
    PROJECT_SHOWCASE_ID,
    buildProjectShowcaseResponse,
    serializeItems,
    validateProjectShowcaseInput,
} from "./logic"

type User = Awaited<ReturnType<typeof requireCurrentUser>>

const loadCachedPublicProjectShowcase = cachePublicContent("projectShowcase", loadPublicProjectShowcaseResponse)

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

export async function publicProjectShowcase(request: AppRequest) {
    return withPublic(request, async () => {
        return ok(await loadCachedPublicProjectShowcase())
    })
}

export async function adminProjectShowcaseDetail(request: AppRequest) {
    return withAdmin(request, async () => {
        const record = await loadProjectShowcaseOrNull()
        return ok(buildProjectShowcaseResponse(record))
    })
}

export async function adminProjectShowcaseUpdate(request: AppRequest) {
    return withAdmin(request, async () => {
        const input = validateProjectShowcaseInput(await readJson(request))
        const now = new Date()
        const [record] = await getDb()
            .insert(siteProjectShowcase)
            .values({
                id: PROJECT_SHOWCASE_ID,
                heading: input.heading,
                intro: input.intro,
                itemsJson: serializeItems(input.items),
                updatedAt: now,
            })
            .onConflictDoUpdate({
                target: siteProjectShowcase.id,
                set: {
                    heading: input.heading,
                    intro: input.intro,
                    itemsJson: serializeItems(input.items),
                    updatedAt: now,
                },
            })
            .returning()

        invalidatePublicProjectShowcaseCache()
        return ok(buildProjectShowcaseResponse(record))
    })
}

async function loadPublicProjectShowcaseResponse() {
    const record = await loadProjectShowcaseOrNull()
    return buildProjectShowcaseResponse(record)
}

async function loadProjectShowcaseOrNull() {
    try {
        const [record] = await getDb()
            .select()
            .from(siteProjectShowcase)
            .where(eq(siteProjectShowcase.id, PROJECT_SHOWCASE_ID))
            .limit(1)
        return record ?? null
    } catch (error) {
        // 读取接口允许在增量 SQL 尚未执行时回退默认值；写入仍要求先应用迁移。
        if (isMissingProjectShowcaseTableError(error)) {
            return null
        }
        throw error
    }
}

function isMissingProjectShowcaseTableError(error: unknown) {
    const parts = collectErrorParts(error).join("\n").toLowerCase()
    return parts.includes("petrichor_site_project_showcase") &&
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
