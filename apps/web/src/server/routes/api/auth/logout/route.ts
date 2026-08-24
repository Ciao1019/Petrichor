import { eq } from "drizzle-orm"
import type { AppRequest } from "@/server/http/request"
import { auth } from "@/server/auth/better-auth"
import { appendBetterAuthCookies } from "@/server/auth/better-auth-response"
import { getDb } from "@/server/db/client"
import { authSessions } from "@/server/db/schema"
import { clearSessionCookie, getSessionToken, hashSessionToken } from "@/server/auth/session"
import { toErrorResponse } from "@/server/http/response"

export async function POST(request: AppRequest) {
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

        const response = Response.json({})
        appendBetterAuthCookies(response, authResult?.headers)
        clearSessionCookie(response)
        return response
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}
