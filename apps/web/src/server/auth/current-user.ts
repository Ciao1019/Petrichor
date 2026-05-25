import { and, eq, gt, isNull } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { getDb } from "@/server/db/client"
import { authSessions, betterAuthSessions, users } from "@/server/db/schema"
import { unauthorized } from "@/server/http/response"
import { auth } from "./better-auth"
import { ensurePetrichorUserForBetterAuthUser } from "./better-auth-bridge"
import {
    getSessionExpiresAt,
    getSessionToken,
    hashSessionToken,
    refreshBetterAuthSessionCookie,
    refreshSessionCookie,
} from "./session"

async function getBetterAuthCurrentUser(request: NextRequest) {
    const session = await auth.api.getSession({
        headers: request.headers,
    }).catch(() => null)
    if (!session?.user?.id || !session.user.email) {
        return null
    }

    const now = new Date()
    await getDb()
        .update(betterAuthSessions)
        .set({
            expiresAt: getSessionExpiresAt(now),
            updatedAt: now,
        })
        .where(eq(betterAuthSessions.id, session.session.id))
    await refreshBetterAuthSessionCookie(request)

    return await ensurePetrichorUserForBetterAuthUser({
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image,
        createdAt: session.user.createdAt,
        updatedAt: session.user.updatedAt,
    })
}

export async function getCurrentUser(request: NextRequest) {
    const betterAuthUser = await getBetterAuthCurrentUser(request)
    if (betterAuthUser) {
        return betterAuthUser
    }

    const token = getSessionToken(request)
    if (!token) {
        return null
    }

    const tokenHash = await hashSessionToken(token)
    const db = getDb()
    const [row] = await db
        .select({
            user: users,
            session: authSessions,
        })
        .from(authSessions)
        .innerJoin(users, eq(users.id, authSessions.userId))
        .where(and(
            eq(authSessions.tokenHash, tokenHash),
            isNull(authSessions.revokedAt),
            gt(authSessions.expiresAt, new Date()),
        ))
        .limit(1)

    if (!row) {
        return null
    }

    const now = new Date()
    await db
        .update(authSessions)
        .set({
            expiresAt: getSessionExpiresAt(now),
            lastSeenAt: now,
            updatedAt: now,
        })
        .where(eq(authSessions.id, row.session.id))
    await refreshSessionCookie(token)

    return row.user
}

export async function requireCurrentUser(request: NextRequest) {
    const user = await getCurrentUser(request)
    if (!user) {
        throw unauthorized()
    }
    return user
}
