import { and, count, eq, isNotNull, isNull } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import { notifications } from "@/server/db/schema"
import { ok, readJson, tableData, toErrorResponse } from "@/server/http/response"
import {
    buildNotificationItem,
    resolveNotificationOrder,
    toNotificationOrderBy,
    validateNotificationListInput,
    validateNotificationReadAllInput,
    validateNotificationReadInput,
} from "./logic"

type User = Awaited<ReturnType<typeof requireCurrentUser>>

async function withUser(request: NextRequest, handler: (user: User) => Promise<Response>) {
    try {
        const user = await requireCurrentUser(request)
        return await handler(user)
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function notificationSummary(request: NextRequest) {
    return withUser(request, async (user) => {
        const db = getDb()
        const [countRow] = await db
            .select({ total: count() })
            .from(notifications)
            .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)))

        const [latestUnread] = await db
            .select({ id: notifications.id })
            .from(notifications)
            .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)))
            .orderBy(...toNotificationOrderBy([
                { column: "createdAt", direction: "desc" },
                { column: "id", direction: "desc" },
            ]))
            .limit(1)

        return ok({
            unreadCount: countRow?.total ?? 0,
            latestUnreadId: latestUnread ? String(latestUnread.id) : null,
        })
    })
}

export async function listNotifications(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = validateNotificationListInput(await readJson(request))
        const db = getDb()
        const filters = [eq(notifications.userId, user.id)]
        if (input.category) {
            filters.push(eq(notifications.category, input.category))
        }
        if (input.readStatus === "UNREAD") {
            filters.push(isNull(notifications.readAt))
        } else if (input.readStatus === "READ") {
            filters.push(isNotNull(notifications.readAt))
        }

        const where = and(...filters)
        const [totalRow] = await db
            .select({ total: count() })
            .from(notifications)
            .where(where)

        const rows = await db
            .select()
            .from(notifications)
            .where(where)
            .orderBy(...toNotificationOrderBy(resolveNotificationOrder(input)))
            .limit(input.pageSize)
            .offset((input.pageNum - 1) * input.pageSize)

        return tableData(rows.map(buildNotificationItem), totalRow?.total ?? 0)
    })
}

export async function readNotification(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = validateNotificationReadInput(await readJson(request))
        const readAt = new Date()

        await getDb()
            .update(notifications)
            .set({
                readAt,
                updatedAt: readAt,
            })
            .where(and(
                eq(notifications.id, input.notificationId),
                eq(notifications.userId, user.id),
                isNull(notifications.readAt),
            ))

        return ok({
            notificationId: String(input.notificationId),
            readAt: readAt.toISOString(),
        })
    })
}

export async function readAllNotifications(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = validateNotificationReadAllInput(await readJson(request))
        const readAt = new Date()
        const filters = [
            eq(notifications.userId, user.id),
            isNull(notifications.readAt),
        ]
        if (input.category) {
            filters.push(eq(notifications.category, input.category))
        }

        const rows = await getDb()
            .update(notifications)
            .set({
                readAt,
                updatedAt: readAt,
            })
            .where(and(...filters))
            .returning({ id: notifications.id })

        return ok({
            updatedCount: rows.length,
            readAt: readAt.toISOString(),
        })
    })
}
