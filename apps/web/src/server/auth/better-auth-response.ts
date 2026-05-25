import type { NextResponse } from "next/server"
import { badRequest, forbidden, unauthorized } from "@/server/http/response"

function splitCombinedSetCookie(value: string) {
    return value
        .split(/,(?=\s*[^;,]+=)/)
        .map((cookie) => cookie.trim())
        .filter(Boolean)
}

export function appendBetterAuthCookies(response: NextResponse, headers: Headers | null | undefined) {
    if (!headers) {
        return response
    }

    const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] }
    const cookies = withGetSetCookie.getSetCookie?.() ?? splitCombinedSetCookie(headers.get("set-cookie") ?? "")
    for (const cookie of cookies) {
        response.headers.append("set-cookie", cookie)
    }
    return response
}

export function toAuthHttpError(error: unknown, fallbackMessage = "认证失败") {
    const candidate = error as {
        status?: number
        statusCode?: number
        body?: { message?: string }
        message?: string
    }
    const status = candidate.statusCode ?? candidate.status
    const message = candidate.body?.message || candidate.message || fallbackMessage

    if (status === 400 || status === 422) {
        return badRequest(message)
    }
    if (status === 401) {
        return unauthorized(fallbackMessage)
    }
    if (status === 403) {
        return forbidden(message)
    }
    return error
}
