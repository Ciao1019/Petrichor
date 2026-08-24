import { randomBytes, createHash } from "node:crypto"
import type { AppRequest } from "@/server/http/request"
import { getServerConfig } from "@/config/server"
import { setDeferredCookie, setResponseCookie } from "@/server/http/cookies"

export const SESSION_COOKIE_NAME = "petrichor_session"
export const BETTER_AUTH_COOKIE_PREFIX = "petrichor"

export function getBetterAuthSessionCookieName() {
    const securePrefix = process.env.NODE_ENV === "production" ? "__Secure-" : ""
    return `${securePrefix}${BETTER_AUTH_COOKIE_PREFIX}.session_token`
}

export function issueSessionToken(): string {
    return randomBytes(32).toString("base64url")
}

export async function hashSessionToken(token: string): Promise<string> {
    return createHash("sha256").update(token).digest("hex")
}

export function getBearerToken(request: Request): string | null {
    const raw = request.headers.get("authorization")?.trim()
    if (!raw) {
        return null
    }

    const [scheme, token] = raw.split(/\s+/, 2)
    if (scheme?.toLowerCase() !== "bearer" || !token) {
        return null
    }

    return token
}

export function getSessionToken(request: AppRequest): string | null {
    return request.cookies.get(SESSION_COOKIE_NAME)?.value || getBearerToken(request)
}

export function getSessionExpiresAt(now = new Date()): Date {
    return new Date(now.getTime() + getServerConfig().session.expiresInSeconds * 1000)
}

function getSessionCookieOptions(maxAge: number) {
    return {
        httpOnly: true,
        path: "/",
        sameSite: "lax" as const,
        secure: process.env.NODE_ENV === "production",
        maxAge,
    }
}

export function setSessionCookie(response: Response, token: string) {
    setResponseCookie(
        response,
        SESSION_COOKIE_NAME,
        token,
        getSessionCookieOptions(getServerConfig().session.expiresInSeconds),
    )
}

async function refreshCookie(name: string, value: string) {
    setDeferredCookie(name, value, getSessionCookieOptions(getServerConfig().session.expiresInSeconds))
}

export async function refreshSessionCookie(token: string) {
    await refreshCookie(SESSION_COOKIE_NAME, token)
}

export async function refreshBetterAuthSessionCookie(request: AppRequest) {
    const cookieName = getBetterAuthSessionCookieName()
    const cookieValue = request.cookies.get(cookieName)?.value
        ?? request.cookies.get(`${BETTER_AUTH_COOKIE_PREFIX}.session_token`)?.value
    if (cookieValue) {
        await refreshCookie(cookieName, cookieValue)
    }
}

export function clearSessionCookie(response: Response) {
    setResponseCookie(response, SESSION_COOKIE_NAME, "", getSessionCookieOptions(0))
}
