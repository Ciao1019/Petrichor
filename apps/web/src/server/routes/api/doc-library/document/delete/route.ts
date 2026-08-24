import { z } from "zod"
import type { AppRequest } from "@/server/http/request"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, readJson, toErrorResponse } from "@/server/http/response"
import { deleteDocument, idSchema } from "@/server/doc-library/library-logic"

const schema = z.object({ id: idSchema })

export async function POST(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = schema.parse(await readJson(request))
        const result = await deleteDocument(user.id, input.id)
        return ok({ id: result.id, storageCleanup: result.storageCleanup })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}
