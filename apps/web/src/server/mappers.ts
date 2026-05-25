import type { UserRecord } from "@/server/db/schema"

function formatDate(value: Date | string | null | undefined): string {
    if (!value) {
        return ""
    }
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function toUserResponse(user: UserRecord) {
    return {
        id: String(user.id),
        email: user.email,
        systemRole: user.systemRole as "USER" | "SUPER_ADMIN",
        userType: user.userType,
        linuxDoBound: Boolean(user.linuxDoAccountId?.trim()),
        linuxDoUsername: user.linuxDoUsername,
        linuxDoEmail: user.linuxDoEmail,
        username: user.username,
        nickname: user.nickname,
        avatar: user.avatar,
    }
}

export function toUserProfileResponse(user: UserRecord, options?: { twoFactorEnabled?: boolean }) {
    return {
        ...toUserResponse(user),
        signature: user.signature,
        twoFactorEnabled: Boolean(options?.twoFactorEnabled),
        createdAt: formatDate(user.createdAt),
        updatedAt: formatDate(user.updatedAt),
    }
}

