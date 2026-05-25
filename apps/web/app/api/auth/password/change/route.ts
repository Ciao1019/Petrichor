import { and, eq } from "drizzle-orm"
import { NextRequest, NextResponse } from "next/server"
import bcrypt from "bcryptjs"
import { z } from "zod"
import { auth } from "@/server/auth/better-auth"
import { ensureBetterAuthCredentialsForEmail, requireAuthUserIdForPetrichorUser, syncPetrichorPasswordHashFromBetterAuth } from "@/server/auth/better-auth-bridge"
import { appendBetterAuthCookies, toAuthHttpError } from "@/server/auth/better-auth-response"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import { betterAuthAccounts, users } from "@/server/db/schema"
import { badRequest, ok, readJson, toErrorResponse } from "@/server/http/response"

const schema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(6),
})

export async function POST(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = schema.parse(await readJson(request))
        const session = await auth.api.getSession({ headers: request.headers })
        if (session?.user?.id && session.user.id === user.authUserId) {
            const result = await auth.api.changePassword({
                body: {
                    currentPassword: input.currentPassword,
                    newPassword: input.newPassword,
                    revokeOtherSessions: false,
                },
                headers: request.headers,
                returnHeaders: true,
            })
            await syncPetrichorPasswordHashFromBetterAuth(user)
            const response = NextResponse.json({})
            return appendBetterAuthCookies(response, result.headers)
        }

        if (!await bcrypt.compare(input.currentPassword, user.passwordHash)) {
            throw badRequest("当前密码错误")
        }
        if (await bcrypt.compare(input.newPassword, user.passwordHash)) {
            throw badRequest("新密码不能与当前密码相同")
        }

        const passwordHash = await bcrypt.hash(input.newPassword, 10)
        const authUserId = await requireAuthUserIdForPetrichorUser(user)
        await ensureBetterAuthCredentialsForEmail(user.email)
        await getDb()
            .update(users)
            .set({
                passwordHash,
                updatedAt: new Date(),
            })
            .where(eq(users.id, user.id))
        await getDb()
            .update(betterAuthAccounts)
            .set({ password: passwordHash, updatedAt: new Date() })
            .where(and(
                eq(betterAuthAccounts.userId, authUserId),
                eq(betterAuthAccounts.providerId, "credential"),
            ))

        return ok({})
    } catch (error) {
        return toErrorResponse(toAuthHttpError(error, "修改密码失败"), request.nextUrl.pathname)
    }
}
