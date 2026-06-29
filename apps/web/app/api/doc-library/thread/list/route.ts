import type { NextRequest } from "next/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, readJson, toErrorResponse } from "@/server/http/response"
import { docQaThreadListSchema, listDocQaThreads } from "@/server/doc-library/qa-logic"

export async function POST(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = docQaThreadListSchema.parse(await readJson(request).catch(() => ({})))
        const libraryIdRaw = input.libraryId != null ? String(input.libraryId).trim() : ""
        const libraryId = /^\d+$/.test(libraryIdRaw) ? Number(libraryIdRaw) : null
        const result = await listDocQaThreads({
            userId: user.id,
            limit: input.limit,
            cursor: input.cursor,
            query: input.q,
            libraryId,
        })
        return ok(result)
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}
