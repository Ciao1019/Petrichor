import { appendPendingCookie } from "./request-context"

export type CookieOptions = {
    httpOnly?: boolean
    path?: string
    sameSite?: "strict" | "lax" | "none"
    secure?: boolean
    maxAge?: number
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`]
    if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`)
    if (options.path) parts.push(`Path=${options.path}`)
    if (options.httpOnly) parts.push("HttpOnly")
    if (options.secure) parts.push("Secure")
    if (options.sameSite) {
        parts.push(`SameSite=${options.sameSite[0]?.toUpperCase()}${options.sameSite.slice(1)}`)
    }
    return parts.join("; ")
}

export function setResponseCookie(response: Response, name: string, value: string, options: CookieOptions = {}) {
    response.headers.append("set-cookie", serializeCookie(name, value, options))
}

export function setDeferredCookie(name: string, value: string, options: CookieOptions = {}) {
    appendPendingCookie(serializeCookie(name, value, options))
}

