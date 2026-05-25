import { randomBytes, createHash } from "node:crypto"
import type { NextRequest, NextResponse } from "next/server"
import { getServerConfig } from "@/config/server"

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

export function getSessionToken(request: NextRequest): string | null {
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

export function setSessionCookie(response: NextResponse, token: string) {
    response.cookies.set(SESSION_COOKIE_NAME, token, getSessionCookieOptions(getServerConfig().session.expiresInSeconds))
}

async function refreshCookie(name: string, value: string) {
    try {
        const { cookies } = await import("next/headers")
        const cookieStore = await cookies()
        cookieStore.set(name, value, getSessionCookieOptions(getServerConfig().session.expiresInSeconds))
    } catch {
        // 非 Route Handler 上下文无法写 Cookie；数据库续期仍然保持生效。
    }
}

export async function refreshSessionCookie(token: string) {
    await refreshCookie(SESSION_COOKIE_NAME, token)
}

export async function refreshBetterAuthSessionCookie(request: NextRequest) {
    const cookieName = getBetterAuthSessionCookieName()
    const cookieValue = request.cookies.get(cookieName)?.value
        ?? request.cookies.get(`${BETTER_AUTH_COOKIE_PREFIX}.session_token`)?.value
    if (cookieValue) {
        await refreshCookie(cookieName, cookieValue)
    }
}

export function clearSessionCookie(response: NextResponse) {
    response.cookies.set(SESSION_COOKIE_NAME, "", getSessionCookieOptions(0))
}
