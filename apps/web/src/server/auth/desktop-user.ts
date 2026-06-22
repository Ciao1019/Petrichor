import { or, eq } from "drizzle-orm"
import { getDb } from "@/server/db/client"
import { betterAuthUsers, users, type UserRecord } from "@/server/db/schema"

const DESKTOP_AUTH_USER_ID = "petrichor_desktop_local_user"
const DESKTOP_USER_EMAIL = "local@dosphere.desktop"
const DESKTOP_USER_NAME = "本地用户"

export function isDesktopAuthEnabled() {
    return process.env.PETRICHOR_DESKTOP === "true"
}

export async function ensureDesktopCurrentUser(): Promise<UserRecord> {
    const db = getDb()
    const now = new Date()

    const [existingAuthUser] = await db
        .select()
        .from(betterAuthUsers)
        .where(or(
            eq(betterAuthUsers.id, DESKTOP_AUTH_USER_ID),
            eq(betterAuthUsers.email, DESKTOP_USER_EMAIL),
        ))
        .limit(1)

    const authUserId = existingAuthUser?.id ?? DESKTOP_AUTH_USER_ID

    if (!existingAuthUser) {
        await db.insert(betterAuthUsers).values({
            id: authUserId,
            name: DESKTOP_USER_NAME,
            email: DESKTOP_USER_EMAIL,
            emailVerified: true,
            image: null,
            twoFactorEnabled: false,
            createdAt: now,
            updatedAt: now,
        })
    }

    const [existingUser] = await db
        .select()
        .from(users)
        .where(or(
            eq(users.authUserId, authUserId),
            eq(users.email, DESKTOP_USER_EMAIL),
        ))
        .limit(1)

    if (!existingUser) {
        const [user] = await db
            .insert(users)
            .values({
                authUserId,
                email: DESKTOP_USER_EMAIL,
                passwordHash: "",
                systemRole: "SUPER_ADMIN",
                userType: "DESKTOP",
                username: "desktop",
                nickname: DESKTOP_USER_NAME,
                avatar: null,
                signature: null,
                createdAt: now,
                updatedAt: now,
            })
            .returning()
        return user
    }

    const needsUpdate =
        existingUser.authUserId !== authUserId ||
        existingUser.systemRole !== "SUPER_ADMIN" ||
        existingUser.userType !== "DESKTOP" ||
        !existingUser.nickname

    if (!needsUpdate) {
        return existingUser
    }

    const [user] = await db
        .update(users)
        .set({
            authUserId,
            systemRole: "SUPER_ADMIN",
            userType: "DESKTOP",
            nickname: existingUser.nickname || DESKTOP_USER_NAME,
            updatedAt: now,
        })
        .where(eq(users.id, existingUser.id))
        .returning()
    return user
}
