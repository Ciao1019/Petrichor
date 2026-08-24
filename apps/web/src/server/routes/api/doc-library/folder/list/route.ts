import { z } from "zod"
import type { AppRequest } from "@/server/http/request"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, readJson, toErrorResponse } from "@/server/http/response"
import { idSchema, listFolders } from "@/server/doc-library/library-logic"

const schema = z.object({ libraryId: idSchema })

export async function POST(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = schema.parse(await readJson(request))
        const folders = await listFolders(user.id, input.libraryId)
        return ok({ folders })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}
