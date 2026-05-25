import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { auth } from "@/server/auth/better-auth"
import { createLocalUserWithBetterAuth } from "@/server/auth/better-auth-bridge"
import { appendBetterAuthCookies, toAuthHttpError } from "@/server/auth/better-auth-response"
import { toUserResponse } from "@/server/mappers"
import { readJson, toErrorResponse } from "@/server/http/response"
import { resolveRegisterDefaultSystemRole } from "@/server/auth/register-policy"

const schema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
    name: z.string().trim().min(1),
})

export async function POST(request: NextRequest) {
    try {
        const input = schema.parse(await readJson(request))
        const systemRole = resolveRegisterDefaultSystemRole()
        const user = await createLocalUserWithBetterAuth({
            email: input.email,
            password: input.password,
            name: input.name,
            systemRole,
        })

        const result = await auth.api.signInEmail({
            body: {
                email: input.email,
                password: input.password,
                rememberMe: true,
            },
            headers: request.headers,
            returnHeaders: true,
        })
        const response = NextResponse.json({
            token: result.response.token,
            user: toUserResponse(user),
        })
        return appendBetterAuthCookies(response, result.headers)
    } catch (error) {
        return toErrorResponse(toAuthHttpError(error, "注册失败"), request.nextUrl.pathname)
    }
}
