import { eq } from "drizzle-orm"
import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/server/auth/better-auth"
import { appendBetterAuthCookies } from "@/server/auth/better-auth-response"
import { getDb } from "@/server/db/client"
import { authSessions } from "@/server/db/schema"
import { clearSessionCookie, getSessionToken, hashSessionToken } from "@/server/auth/session"
import { toErrorResponse } from "@/server/http/response"

export async function POST(request: NextRequest) {
    try {
        const token = getSessionToken(request)
        if (token) {
            await getDb()
                .update(authSessions)
                .set({ revokedAt: new Date(), updatedAt: new Date() })
                .where(eq(authSessions.tokenHash, await hashSessionToken(token)))
        }

        const authResult = await auth.api.signOut({
            headers: request.headers,
            returnHeaders: true,
        }).catch(() => null)

        const response = NextResponse.json({})
        appendBetterAuthCookies(response, authResult?.headers)
        clearSessionCookie(response)
        return response
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}
