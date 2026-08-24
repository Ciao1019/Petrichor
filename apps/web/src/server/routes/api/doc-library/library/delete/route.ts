import { z } from "zod"
import type { AppRequest } from "@/server/http/request"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, readJson, toErrorResponse } from "@/server/http/response"
import { deleteLibrary, idSchema } from "@/server/doc-library/library-logic"

const schema = z.object({ id: idSchema })

export async function POST(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = schema.parse(await readJson(request))
        return ok(await deleteLibrary(user.id, input.id))
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}
