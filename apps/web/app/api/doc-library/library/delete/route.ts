import { z } from "zod"
import type { NextRequest } from "next/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, readJson, toErrorResponse } from "@/server/http/response"
import { deleteLibrary, idSchema } from "@/server/doc-library/library-logic"

const schema = z.object({ id: idSchema })

export async function POST(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = schema.parse(await readJson(request))
        return ok(await deleteLibrary(user.id, input.id))
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}
