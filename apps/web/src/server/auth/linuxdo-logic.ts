import { badRequest } from "@/server/http/response"

export interface NormalizedLinuxDoUser {
    accountId: string
    email: string
    username: string | null
    nickname: string | null
    avatar: string | null
}

export function validateLinuxDoCallbackInput(raw: unknown) {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    const code = String(value.code ?? "").trim()
    const state = String(value.state ?? "").trim()
    if (!code) {
        throw badRequest("授权码不能为空")
    }
    return { code, state: state || null }
}

export function normalizeLinuxDoUserInfo(raw: Record<string, unknown>): NormalizedLinuxDoUser {
    const username = readString(raw, "username")
    const rawAccountId = readString(raw, "id")
        ?? readString(raw, "user_id")
        ?? readString(raw, "sub")
    let email = readString(raw, "email")
    if (!email?.trim()) {
        email = username != null ? `${username}@linux.do` : "null@linux.do"
    }

    let nickname = readString(raw, "name")
    if (!nickname?.trim()) {
        nickname = username
    }

    return {
        accountId: (rawAccountId?.trim() || username?.trim() || email).toLowerCase(),
        email,
        username,
        nickname,
        avatar: readString(raw, "avatar_url"),
    }
}

export function shouldUpgradeToLinuxDoUserType(userType: string | null | undefined, passwordHash: string | null | undefined) {
    const type = userType?.trim() ?? ""
    const hasLocalPassword = Boolean(passwordHash?.trim())
    if (type === "LOCAL" && hasLocalPassword) {
        return false
    }
    return type === "" || (type === "LOCAL" && !hasLocalPassword)
}

function readString(raw: Record<string, unknown>, key: string) {
    const value = raw[key]
    if (typeof value === "string") {
        return value
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value)
    }
    return null
}
