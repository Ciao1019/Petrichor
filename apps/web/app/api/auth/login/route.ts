import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { auth } from "@/server/auth/better-auth"
import { ensureBetterAuthCredentialsForEmail, ensurePetrichorUserForBetterAuthUser } from "@/server/auth/better-auth-bridge"
import { appendBetterAuthCookies, toAuthHttpError } from "@/server/auth/better-auth-response"
import { toUserResponse } from "@/server/mappers"
import { readJson, toErrorResponse } from "@/server/http/response"

const schema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
})

export async function POST(request: NextRequest) {
    try {
        const input = schema.parse(await readJson(request))
        await ensureBetterAuthCredentialsForEmail(input.email)

        const result = await auth.api.signInEmail({
            body: {
                email: input.email,
                password: input.password,
                rememberMe: true,
            },
            headers: request.headers,
            returnHeaders: true,
        })

        const challenge = result.response as unknown as { twoFactorRedirect?: boolean }
        if (challenge?.twoFactorRedirect) {
            const response = NextResponse.json({ twoFactorRequired: true })
            return appendBetterAuthCookies(response, result.headers)
        }

        const user = await ensurePetrichorUserForBetterAuthUser(result.response.user)

        const response = NextResponse.json({
            token: result.response.token,
            user: toUserResponse(user),
        })
        return appendBetterAuthCookies(response, result.headers)
    } catch (error) {
        return toErrorResponse(toAuthHttpError(error, "邮箱或密码错误"), request.nextUrl.pathname)
    }
}
