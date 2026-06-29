import type { NextRequest } from "next/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, readJson, toErrorResponse } from "@/server/http/response"
import { deleteDocQaThreads, docQaThreadDeleteManySchema } from "@/server/doc-library/qa-logic"

export async function POST(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = docQaThreadDeleteManySchema.parse(await readJson(request))
        return ok(await deleteDocQaThreads(user.id, input.threadIds))
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}
