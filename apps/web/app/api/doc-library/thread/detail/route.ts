import { z } from "zod"
import type { NextRequest } from "next/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, readJson, toErrorResponse } from "@/server/http/response"
import { getDocQaThreadDetail, idSchema } from "@/server/doc-library/qa-logic"

const schema = z.object({ threadId: idSchema })

export async function POST(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = schema.parse(await readJson(request))
        return ok(await getDocQaThreadDetail({ userId: user.id, threadId: input.threadId }))
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}
