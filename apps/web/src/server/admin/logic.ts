import type { AnyColumn } from "drizzle-orm"
import { asc, desc } from "drizzle-orm"
import type { UserRecord } from "@/server/db/schema"
import { users } from "@/server/db/schema"
import { badRequest } from "@/server/http/response"

export type AdminUserOrderColumn =
    | "avatar"
    | "createdAt"
    | "email"
    | "id"
    | "nickname"
    | "signature"
    | "systemRole"
    | "updatedAt"
    | "username"
    | "userType"

export interface AdminUserOrder {
    column: AdminUserOrderColumn
    direction: "asc" | "desc"
}

export interface AdminCreateInput {
    email: string
    password: string
    name: string
    systemRole?: "USER" | "SUPER_ADMIN"
}

export interface AdminDeleteInput {
    userId: number
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const orderColumnMap: Record<string, AdminUserOrderColumn> = {
    avatar: "avatar",
    created_at: "createdAt",
    email: "email",
    id: "id",
    nickname: "nickname",
    signature: "signature",
    system_role: "systemRole",
    updated_at: "updatedAt",
    username: "username",
    user_type: "userType",
}

const drizzleColumnMap: Record<AdminUserOrderColumn, AnyColumn> = {
    avatar: users.avatar,
    createdAt: users.createdAt,
    email: users.email,
    id: users.id,
    nickname: users.nickname,
    signature: users.signature,
    systemRole: users.systemRole,
    updatedAt: users.updatedAt,
    username: users.username,
    userType: users.userType,
}

export function normalizeSystemRole(systemRole: string | null | undefined, userId: number): "USER" | "SUPER_ADMIN" {
    const role = systemRole?.trim() ?? ""
    if (role) {
        return role === "SUPER_ADMIN" ? "SUPER_ADMIN" : "USER"
    }
    return userId === 1 ? "SUPER_ADMIN" : "USER"
}

export function isSuperAdmin(systemRole: string | null | undefined, userId: number) {
    return normalizeSystemRole(systemRole, userId) === "SUPER_ADMIN"
}

export function normalizeUserType(userType: string | null | undefined, passwordHash: string | null | undefined) {
    const normalized = userType?.trim() ?? ""
    if (normalized) {
        return normalized
    }
    return passwordHash?.trim() ? "LOCAL" : "LINUXDO"
}

export function validateAdminCreateInput(raw: unknown): AdminCreateInput {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    const email = String(value.email ?? "").trim()
    const password = String(value.password ?? "")
    const name = String(value.name ?? "").trim()
    const rawSystemRole = value.systemRole == null ? undefined : String(value.systemRole).trim()

    if (!email) {
        throw badRequest("不能为空")
    }
    if (!emailPattern.test(email)) {
        throw badRequest("不是一个合法的电子邮件地址")
    }
    if (!password.trim()) {
        throw badRequest("不能为空")
    }
    if (password.length < 6 || password.length > 50) {
        throw badRequest("个数必须在6和50之间")
    }
    if (!name) {
        throw badRequest("不能为空")
    }
    if (name.length > 80) {
        throw badRequest("个数必须在0和80之间")
    }
    if (rawSystemRole && rawSystemRole !== "USER" && rawSystemRole !== "SUPER_ADMIN") {
        throw badRequest("systemRole 非法")
    }

    return {
        email,
        password,
        name,
        systemRole: rawSystemRole as AdminCreateInput["systemRole"],
    }
}

export function validateAdminDeleteInput(raw: unknown): AdminDeleteInput {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    const userId = String(value.userId ?? "").trim()
    if (!/^\d+$/.test(userId)) {
        throw badRequest("用户ID非法")
    }
    return { userId: Number(userId) }
}

export function validateAdminKeyword(value: unknown) {
    const keyword = value == null ? "" : String(value)
    if (keyword.length > 200) {
        throw badRequest("关键字长度不能超过 200")
    }
    return keyword
}

export function normalizeAdminPagination(raw: Record<string, unknown>) {
    const pageNum = Number(raw.pageNum)
    const pageSize = Number(raw.pageSize)

    return {
        pageNum: Number.isInteger(pageNum) && pageNum > 0 ? pageNum : 1,
        pageSize: Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 20,
    }
}

export function resolveAdminUserOrder(raw: { isAsc?: unknown; orderByColumn?: unknown }): AdminUserOrder[] {
    const orderByColumn = String(raw.orderByColumn ?? "").trim()
    const isAsc = String(raw.isAsc ?? "").trim()

    if (!orderByColumn || !isAsc) {
        return [
            { column: "updatedAt", direction: "desc" },
            { column: "id", direction: "desc" },
        ]
    }

    const safeOrderBy = escapeOrderBy(orderByColumn)
    const columns = safeOrderBy.split(",").map((column) => toUnderScoreCase(column.trim())).filter(Boolean)
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

export function toAdminOrderBy(order: AdminUserOrder[]) {
    return order.map((item) => {
        const column = drizzleColumnMap[item.column]
        return item.direction === "asc" ? asc(column) : desc(column)
    })
}

export function buildAdminUserItem(user: UserRecord) {
    return {
        id: String(user.id),
        email: user.email,
        systemRole: normalizeSystemRole(user.systemRole, user.id),
        userType: normalizeUserType(user.userType, user.passwordHash),
        username: user.username,
        nickname: user.nickname,
        avatar: user.avatar,
        signature: user.signature,
        createdAt: formatDate(user.createdAt),
        updatedAt: formatDate(user.updatedAt),
    }
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
        const lower = char.toLowerCase()
        if (char >= "A" && char <= "Z") {
            if (index > 0 && value[index - 1] !== "," && value[index - 1] !== "_") {
                output += "_"
            }
            output += lower
        } else {
            output += char
        }
    }
    return output
}

function formatDate(value: Date | string | null | undefined) {
    if (!value) {
        return ""
    }
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
