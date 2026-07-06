import bcrypt from "bcryptjs"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { nextCookies } from "better-auth/next-js"
import { twoFactor } from "better-auth/plugins/two-factor"
import { getServerConfig } from "@/config/server"
import { getDb } from "@/server/db/client"

// better-auth 在模块加载时就要拿到 db 实例，但在 Cloudflare Workers 上数据库
// 连接必须「每请求一个」（见 db/client.ts）。用 Proxy 惰性转发：每次访问都在
// 当前请求上下文里重新解析 getDb()，从而拿到本请求专属的连接，避免跨请求复用
// 导致的 "Cannot perform I/O on behalf of a different request" 挂死。
const requestScopedDb = new Proxy({} as ReturnType<typeof getDb>, {
    get(_target, prop) {
        const db = getDb() as unknown as Record<PropertyKey, unknown>
        const value = db[prop]
        return typeof value === "function" ? value.bind(db) : value
    },
})
import {
    betterAuthAccounts,
    betterAuthSessions,
    betterAuthTwoFactors,
    betterAuthUsers,
    betterAuthVerifications,
} from "@/server/db/schema"
import { ensurePetrichorUserForBetterAuthUser } from "./better-auth-bridge"
import { BETTER_AUTH_COOKIE_PREFIX } from "./session"

const serverConfig = getServerConfig()

function readBaseUrl() {
    const configured = process.env.NEXT_PUBLIC_APP_URL?.trim()
        || process.env.BETTER_AUTH_URL?.trim()
        || process.env.APP_BASE_URL?.trim()
    return configured?.replace(/\/+$/, "") || "http://localhost:3000"
}

function buildTrustedOrigins() {
    const origins = new Set([
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:3002",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
        "http://127.0.0.1:3002",
    ])

    const baseUrl = readBaseUrl()
    if (baseUrl) {
        origins.add(baseUrl)
    }
    if (process.env.VERCEL_URL?.trim()) {
        origins.add(`https://${process.env.VERCEL_URL.trim()}`)
    }

    return Array.from(origins)
}

export const auth = betterAuth({
    baseURL: readBaseUrl(),
    secret: serverConfig.sessionSecret,
    trustedOrigins: buildTrustedOrigins(),
    database: drizzleAdapter(requestScopedDb, {
        provider: "pg",
        schema: {
            user: betterAuthUsers,
            session: betterAuthSessions,
            account: betterAuthAccounts,
            verification: betterAuthVerifications,
            twoFactor: betterAuthTwoFactors,
        },
    }),
    emailAndPassword: {
        enabled: true,
        autoSignIn: true,
        minPasswordLength: 6,
        password: {
            // 用同步 API：bcryptjs 的异步版靠 setTimeout 分片调度，在 Cloudflare
            // Workers(workerd) 的单请求事件循环里回调不执行，导致 Promise 永不
            // resolve、请求挂死(Error 1101)。同步版内联算完即返回，格式一致。
            hash: (password) => Promise.resolve(bcrypt.hashSync(password, 10)),
            verify: ({ hash, password }) =>
                Promise.resolve(bcrypt.compareSync(password, hash)),
        },
    },
    session: {
        expiresIn: serverConfig.session.expiresInSeconds,
        // 后台 token 由 requireCurrentUser 主动续期，避免旧长会话等待内部阈值才更新。
        disableSessionRefresh: true,
    },
    advanced: {
        cookiePrefix: BETTER_AUTH_COOKIE_PREFIX,
        useSecureCookies: process.env.NODE_ENV === "production",
        defaultCookieAttributes: {
            sameSite: "lax",
            path: "/",
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
        },
    },
    databaseHooks: {
        user: {
            create: {
                async after(user) {
                    await ensurePetrichorUserForBetterAuthUser(user)
                },
            },
        },
    },
    plugins: [
        twoFactor({
            issuer: "Petrichor",
            backupCodeOptions: {
                amount: 10,
                length: 10,
            },
        }),
        nextCookies(),
    ],
})

export type Auth = typeof auth
