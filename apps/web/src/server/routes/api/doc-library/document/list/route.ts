import { z } from "zod"
import type { AppRequest } from "@/server/http/request"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, readJson, toErrorResponse } from "@/server/http/response"
import { idSchema, listDocuments } from "@/server/doc-library/library-logic"

const schema = z.object({ libraryId: idSchema })

export async function POST(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = schema.parse(await readJson(request))
        const documents = await listDocuments(user.id, input.libraryId)
        return ok({ documents })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}
