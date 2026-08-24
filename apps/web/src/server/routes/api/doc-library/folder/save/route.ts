import type { AppRequest } from "@/server/http/request"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, readJson, toErrorResponse } from "@/server/http/response"
import { folderSaveSchema, saveFolder } from "@/server/doc-library/library-logic"

export async function POST(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = folderSaveSchema.parse(await readJson(request))
        const result = await saveFolder({
            userId: user.id,
            id: input.id ?? null,
            libraryId: input.libraryId,
            parentId: input.parentId ?? null,
            name: input.name,
        })
        return ok(result)
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}
