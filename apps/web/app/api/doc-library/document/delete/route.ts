import { z } from "zod"
import type { NextRequest } from "next/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, readJson, toErrorResponse } from "@/server/http/response"
import { deleteDocument, idSchema } from "@/server/doc-library/library-logic"

const schema = z.object({ id: idSchema })

export async function POST(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = schema.parse(await readJson(request))
        const result = await deleteDocument(user.id, input.id)
        return ok({ id: result.id })
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}
