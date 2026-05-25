import { randomBytes } from "node:crypto"
import { Buffer } from "node:buffer"
import { eq } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { dashboardRoutes } from "@/lib/dashboard-routes"
import { requireCurrentUser } from "@/server/auth/current-user"
import { isSuperAdmin } from "@/server/admin/logic"
import { getDb } from "@/server/db/client"
import { authSessions, users } from "@/server/db/schema"
import { badRequest, readJson, toErrorResponse, unauthorized } from "@/server/http/response"
import { toUserResponse } from "@/server/mappers"
import type { NormalizedLinuxDoUser } from "./linuxdo-logic"
import { getSessionExpiresAt, hashSessionToken, issueSessionToken, setSessionCookie } from "./session"
import {
    normalizeLinuxDoUserInfo,
    validateLinuxDoCallbackInput,
} from "./linuxdo-logic"

const linuxDoAuthorizeUrl = "https://connect.linux.do/oauth2/authorize"
const linuxDoTokenUrl = "https://connect.linux.do/oauth2/token"
const linuxDoUserInfoUrl = "https://connect.linux.do/api/user"
const linuxDoOauthStateCookieName = "petrichor_linuxdo_oauth_state"
const linuxDoFetchTimeoutMs = 30_000
const bindStatePrefix = "bind:"
const loginStatePrefix = "login:"

export async function linuxDoLoginStartGet(request: NextRequest) {
    try {
        const config = getLinuxDoConfig(request)
        const state = `${loginStatePrefix}${randomBytes(24).toString("base64url")}`
        const response = NextResponse.redirect(buildAuthorizeUrl(config, state), { status: 302 })
        setLinuxDoOauthStateCookie(response, state)
        return response
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function linuxDoBindStartGet(request: NextRequest) {
    try {
        await requireCurrentUser(request)
        const config = getLinuxDoConfig(request)
        const state = `${bindStatePrefix}${randomBytes(24).toString("base64url")}`
        const response = NextResponse.redirect(buildAuthorizeUrl(config, state), { status: 302 })
        setLinuxDoOauthStateCookie(response, state)
        return response
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function linuxDoCallbackPost(request: NextRequest) {
    try {
        const input = validateLinuxDoCallbackInput(await readJson(request))
        const result = await handleLinuxDoCallback(request, input.code, input.state)
        const response = NextResponse.json(result)
        if (result.mode === "login") {
            setSessionCookie(response, result.token)
        }
        clearLinuxDoOauthStateCookie(response)
        return response
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function linuxDoCallbackGet(request: NextRequest) {
    try {
        const code = request.nextUrl.searchParams.get("code") ?? ""
        const state = request.nextUrl.searchParams.get("state") ?? null
        const result = await handleLinuxDoCallback(request, code, state)
        const target = new URL(result.mode === "bind" ? dashboardRoutes.account : dashboardRoutes.root, getFrontendBaseUrl(request))
        if (result.mode === "login") {
            target.searchParams.set("token", result.token)
        } else {
            target.searchParams.set("linuxdoBinding", "success")
        }
        const response = NextResponse.redirect(target, { status: 302 })
        if (result.mode === "login") {
            setSessionCookie(response, result.token)
        }
        clearLinuxDoOauthStateCookie(response)
        return response
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

async function handleLinuxDoCallback(request: NextRequest, code: string, state: string | null) {
    if (!code.trim()) {
        throw badRequest("授权码不能为空")
    }
    const callbackMode = resolveLinuxDoCallbackMode(request, state)
    const config = getLinuxDoConfig(request)
    const accessToken = await fetchAccessToken(code.trim(), config)
    const userInfo = normalizeLinuxDoUserInfo(await fetchUserInfo(accessToken))
    if (callbackMode === "bind") {
        const user = await bindLinuxDoAccount(request, userInfo)
        return {
            mode: "bind" as const,
            token: "",
            user: toUserResponse(user),
        }
    }

    const user = await resolveLinuxDoLoginUser(userInfo)
    const token = issueSessionToken()
    await getDb().insert(authSessions).values({
        tokenHash: await hashSessionToken(token),
        userId: user.id,
        userAgent: request.headers.get("user-agent"),
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
        expiresAt: getSessionExpiresAt(),
    })

    return {
        mode: "login" as const,
        token,
        user: toUserResponse(user),
    }
}

async function resolveLinuxDoLoginUser(userInfo: NormalizedLinuxDoUser) {
    const db = getDb()

    const boundUser = await findPetrichorUserByLinuxDoAccountId(userInfo.accountId)
    if (!boundUser) {
        throw unauthorized("该 Linux.do 账号未绑定超级管理员，无法登录后台")
    }
    if (!isSuperAdmin(boundUser.systemRole, boundUser.id)) {
        throw unauthorized("该 Linux.do 账号绑定的用户不是超级管理员，无法登录后台")
    }

    const [user] = await db
        .update(users)
        .set(buildLinuxDoUserUpdate(boundUser, userInfo))
        .where(eq(users.id, boundUser.id))
        .returning()

    return user
}

async function bindLinuxDoAccount(request: NextRequest, userInfo: NormalizedLinuxDoUser) {
    const currentUser = await requireCurrentUser(request)
    if (currentUser.linuxDoAccountId && currentUser.linuxDoAccountId !== userInfo.accountId) {
        throw badRequest("当前账号已绑定其他 Linux.do 账号")
    }

    const existingBoundUser = await findPetrichorUserByLinuxDoAccountId(userInfo.accountId)
    if (existingBoundUser && existingBoundUser.id !== currentUser.id) {
        throw badRequest("该 Linux.do 账号已绑定其他用户")
    }

    const [user] = await getDb()
        .update(users)
        .set(buildLinuxDoUserUpdate(currentUser, userInfo))
        .where(eq(users.id, currentUser.id))
        .returning()

    return user
}

async function findPetrichorUserByLinuxDoAccountId(accountId: string) {
    const [existing] = await getDb()
        .select()
        .from(users)
        .where(eq(users.linuxDoAccountId, accountId))
        .limit(1)
    return existing ?? null
}

function buildLinuxDoUserUpdate(user: typeof users.$inferSelect, userInfo: NormalizedLinuxDoUser) {
    return {
        linuxDoAccountId: userInfo.accountId,
        linuxDoEmail: userInfo.email,
        linuxDoUsername: userInfo.username,
        username: user.username || userInfo.username,
        nickname: user.nickname || userInfo.nickname,
        avatar: user.avatar || userInfo.avatar,
        updatedAt: new Date(),
    }
}

function resolveLinuxDoCallbackMode(request: NextRequest, state: string | null): "bind" | "login" {
    const storedState = request.cookies.get(linuxDoOauthStateCookieName)?.value ?? null
    if (!state) {
        return "login"
    }
    if (!storedState && state?.startsWith(bindStatePrefix)) {
        throw badRequest("绑定状态已失效，请重新发起绑定")
    }
    if (!storedState) {
        return "login"
    }
    if (!state || state !== storedState) {
        throw badRequest("授权状态校验失败，请重新发起操作")
    }
    if (storedState.startsWith(bindStatePrefix)) {
        return "bind"
    }
    return "login"
}

function buildAuthorizeUrl(config: LinuxDoConfig, state: string) {
    const target = new URL(linuxDoAuthorizeUrl)
    target.searchParams.set("client_id", config.clientId)
    target.searchParams.set("redirect_uri", config.redirectUri)
    target.searchParams.set("response_type", "code")
    target.searchParams.set("state", state)
    return target
}

function setLinuxDoOauthStateCookie(response: NextResponse, state: string) {
    response.cookies.set(linuxDoOauthStateCookieName, state, {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 60 * 10,
    })
}

function clearLinuxDoOauthStateCookie(response: NextResponse) {
    response.cookies.set(linuxDoOauthStateCookieName, "", {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 0,
    })
}

async function fetchAccessToken(code: string, config: LinuxDoConfig) {
    const form = new URLSearchParams()
    form.set("code", code)
    form.set("redirect_uri", config.redirectUri)
    form.set("grant_type", "authorization_code")
    const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString("base64")

    const response = await fetchWithRetry(linuxDoTokenUrl, {
        method: "POST",
        headers: {
            Accept: "application/json",
            Authorization: `Basic ${basicAuth}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
    })
    if (!response.ok) {
        const errorBody = await readResponseText(response)
        logLinuxDoTokenError(response, config, errorBody)
        throw badRequest(resolveLinuxDoTokenErrorMessage(response, errorBody))
    }
    const payload = await response.json() as { access_token?: string }
    if (!payload.access_token?.trim()) {
        throw badRequest("获取访问令牌失败")
    }
    return payload.access_token
}

function logLinuxDoTokenError(response: Response, config: LinuxDoConfig, body: string) {
    console.error("LinuxDo token exchange failed", {
        status: response.status,
        statusText: response.statusText,
        redirectUri: config.redirectUri,
        body: body.slice(0, 800),
    })
}

function resolveLinuxDoTokenErrorMessage(response: Response, body: string) {
    const errorCode = parseLinuxDoErrorCode(body)
    if (errorCode === "invalid_client" || response.status === 401) {
        return "LinuxDo Client ID 或 Client Secret 配置错误"
    }
    if (errorCode === "invalid_grant") {
        return "LinuxDo 授权码已失效或回调地址不匹配，请重新从登录页发起登录"
    }
    if (errorCode === "invalid_request") {
        return "LinuxDo 授权请求参数错误，请检查回调地址配置"
    }
    return "获取访问令牌失败"
}

function parseLinuxDoErrorCode(body: string) {
    try {
        const payload = JSON.parse(body) as { error?: unknown }
        return typeof payload.error === "string" ? payload.error : null
    } catch {
        return null
    }
}

async function fetchUserInfo(accessToken: string) {
    const response = await fetchWithRetry(linuxDoUserInfoUrl, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    })
    if (!response.ok) {
        throw badRequest("获取用户信息失败")
    }
    return await response.json() as Record<string, unknown>
}

async function fetchWithRetry(url: string, init: RequestInit) {
    let lastError: unknown = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), linuxDoFetchTimeoutMs)
        try {
            return await fetch(url, {
                ...init,
                signal: controller.signal,
            })
        } catch (error) {
            lastError = error
            if (attempt === 0) {
                await new Promise((resolve) => setTimeout(resolve, 180))
            }
        } finally {
            clearTimeout(timeout)
        }
    }
    if (lastError instanceof Error && lastError.name === "AbortError") {
        throw badRequest("LinuxDo 请求超时，请稍后重试")
    }
    throw lastError instanceof Error ? badRequest(lastError.message) : badRequest("LinuxDo 请求失败")
}

async function readResponseText(response: Response) {
    return await response.text().catch(() => "")
}

interface LinuxDoConfig {
    clientId: string
    clientSecret: string
    redirectUri: string
}

function getLinuxDoConfig(request: NextRequest): LinuxDoConfig {
    const clientId = readEnv("PETRICHOR_LINUXDO_CLIENT_ID", "LINUXDO_CLIENT_ID")
    const clientSecret = readEnv("PETRICHOR_LINUXDO_CLIENT_SECRET", "LINUXDO_CLIENT_SECRET")
    const redirectUri = readEnv("PETRICHOR_LINUXDO_REDIRECT_URI", "LINUXDO_REDIRECT_URI")
        || new URL("/api/auth/callback", getFrontendBaseUrl(request)).toString()
    if (!clientId || !clientSecret) {
        throw badRequest("LinuxDo 配置不完整")
    }
    return { clientId, clientSecret, redirectUri }
}

function getFrontendBaseUrl(request: NextRequest) {
    const configured = readEnv("NEXT_PUBLIC_APP_URL", "APP_BASE_URL")
    if (configured) {
        return configured.replace(/\/+$/, "")
    }
    if (process.env.VERCEL_URL?.trim()) {
        return `https://${process.env.VERCEL_URL.trim()}`
    }
    return request.nextUrl.origin
}

function readEnv(...names: string[]) {
    for (const name of names) {
        const value = process.env[name]?.trim()
        if (value) {
            return value
        }
    }
    return null
}
