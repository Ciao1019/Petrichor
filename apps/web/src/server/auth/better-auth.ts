import bcrypt from "bcryptjs"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { nextCookies } from "better-auth/next-js"
import { twoFactor } from "better-auth/plugins/two-factor"
import { getServerConfig } from "@/config/server"
import { getDb } from "@/server/db/client"
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
    database: drizzleAdapter(getDb(), {
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
            hash: (password) => bcrypt.hash(password, 10),
            verify: ({ hash, password }) => bcrypt.compare(password, hash),
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
