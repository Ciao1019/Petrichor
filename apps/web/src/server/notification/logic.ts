import type { AnyColumn } from "drizzle-orm"
import { asc, desc } from "drizzle-orm"
import { notifications, type NotificationRecord } from "@/server/db/schema"
import { badRequest } from "@/server/http/response"

export interface NotificationListInput {
    category: string
    readStatus: "ALL" | "READ" | "UNREAD" | ""
    pageNum: number
    pageSize: number
    orderByColumn?: string
    isAsc?: string
}

export interface NotificationReadInput {
    notificationId: number
}

export interface NotificationReadAllInput {
    category: string
}

export type NotificationOrderColumn =
    | "bizId"
    | "bizType"
    | "category"
    | "createdAt"
    | "id"
    | "readAt"
    | "title"
    | "updatedAt"

export interface NotificationOrder {
    column: NotificationOrderColumn
    direction: "asc" | "desc"
}

const orderColumnMap: Record<string, NotificationOrderColumn> = {
    biz_id: "bizId",
    biz_type: "bizType",
    category: "category",
    created_at: "createdAt",
    id: "id",
    read_at: "readAt",
    title: "title",
    updated_at: "updatedAt",
}

const drizzleColumnMap: Record<NotificationOrderColumn, AnyColumn> = {
    bizId: notifications.bizId,
    bizType: notifications.bizType,
    category: notifications.category,
    createdAt: notifications.createdAt,
    id: notifications.id,
    readAt: notifications.readAt,
    title: notifications.title,
    updatedAt: notifications.updatedAt,
}

export function validateNotificationListInput(raw: unknown): NotificationListInput {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    const category = String(value.category ?? "").trim()
    const readStatus = String(value.readStatus ?? "").trim() as NotificationListInput["readStatus"]
    const pageNum = normalizePositiveInteger(value.pageNum, 1)
    const pageSize = normalizePositiveInteger(value.pageSize, 20)

    if (category.length > 50) {
        throw badRequest("消息分类长度不能超过 50")
    }
    if (readStatus !== "" && readStatus !== "ALL" && readStatus !== "UNREAD" && readStatus !== "READ") {
        throw badRequest("readStatus 非法")
    }

    return {
        category,
        readStatus,
        pageNum,
        pageSize,
        orderByColumn: value.orderByColumn == null ? undefined : String(value.orderByColumn),
        isAsc: value.isAsc == null ? undefined : String(value.isAsc),
    }
}

export function validateNotificationReadInput(raw: unknown): NotificationReadInput {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    const notificationId = String(value.notificationId ?? "").trim()
    if (!/^\d+$/.test(notificationId)) {
        throw badRequest("消息ID非法")
    }
    return { notificationId: Number(notificationId) }
}

export function validateNotificationReadAllInput(raw: unknown): NotificationReadAllInput {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    const category = String(value.category ?? "").trim()
    if (category.length > 50) {
        throw badRequest("消息分类长度不能超过 50")
    }
    return { category }
}

export function resolveNotificationOrder(raw: { isAsc?: unknown; orderByColumn?: unknown }): NotificationOrder[] {
    const orderByColumn = String(raw.orderByColumn ?? "").trim()
    const isAsc = String(raw.isAsc ?? "").trim()
    if (!orderByColumn || !isAsc) {
        return [
            { column: "createdAt", direction: "desc" },
            { column: "id", direction: "desc" },
        ]
    }

    const columns = escapeOrderBy(orderByColumn)
        .split(",")
        .map((column) => toUnderScoreCase(column.trim()))
        .filter(Boolean)
    const directions = isAsc
        .replaceAll("ascending", "asc")
        .replaceAll("descending", "desc")
        .split(",")
        .map((direction) => direction.trim().toLowerCase())

    if (directions.length !== 1 && directions.length !== columns.length) {
        throw badRequest("排序参数有误")
    }

    return columns.map((column, index) => {
        const direction = directions.length === 1 ? directions[0] : directions[index]
        if (direction !== "asc" && direction !== "desc") {
            throw badRequest("排序参数有误")
        }
        const mapped = orderColumnMap[column]
        if (!mapped) {
            throw badRequest("排序参数有误")
        }
        return { column: mapped, direction }
    })
}

export function toNotificationOrderBy(order: NotificationOrder[]) {
    return order.map((item) => {
        const column = drizzleColumnMap[item.column]
        return item.direction === "asc" ? asc(column) : desc(column)
    })
}

export function buildNotificationItem(notification: NotificationRecord) {
    return {
        id: String(notification.id),
        category: notification.category,
        bizType: notification.bizType,
        bizId: String(notification.bizId),
        title: notification.title,
        content: notification.content,
        payload: parseNotificationPayload(notification.payloadJson),
        read: notification.readAt != null,
        readAt: formatDateOrNull(notification.readAt),
        createdAt: formatDate(notification.createdAt),
    }
}

export function parseNotificationPayload(payloadJson: string | null | undefined): Record<string, unknown> {
    const trimmed = payloadJson?.trim() ?? ""
    if (!trimmed) {
        return {}
    }
    const parsed = JSON.parse(trimmed) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
}

function normalizePositiveInteger(value: unknown, fallback: number) {
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function escapeOrderBy(raw: string) {
    for (const char of raw) {
        const code = char.charCodeAt(0)
        const ok = (code >= 48 && code <= 57) ||
            (code >= 65 && code <= 90) ||
            (code >= 97 && code <= 122) ||
            char === "_" ||
            char === ","
        if (!ok) {
            throw badRequest("排序参数有误")
        }
    }
    return raw
}

function toUnderScoreCase(value: string) {
    let output = ""
    for (let index = 0; index < value.length; index++) {
        const char = value[index]
        if (char >= "A" && char <= "Z") {
            if (index > 0 && value[index - 1] !== "," && value[index - 1] !== "_") {
                output += "_"
            }
            output += char.toLowerCase()
        } else {
            output += char
        }
    }
    return output
}

function formatDate(value: Date | string) {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function formatDateOrNull(value: Date | string | null | undefined) {
    if (!value) {
        return null
    }
    return formatDate(value)
}
