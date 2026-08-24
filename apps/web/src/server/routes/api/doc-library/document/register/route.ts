import type { AppRequest } from "@/server/http/request"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, readJson, toErrorResponse } from "@/server/http/response"
import { documentRegisterSchema, registerDocument } from "@/server/doc-library/library-logic"

export const maxDuration = 120

export async function POST(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = documentRegisterSchema.parse(await readJson(request))
        const result = await registerDocument({
            userId: user.id,
            libraryId: input.libraryId,
            folderId: input.folderId ?? null,
            fileName: input.fileName,
            title: input.title ?? null,
            fileType: input.fileType,
            contentType: input.contentType ?? null,
            objectKey: input.objectKey,
            sizeBytes: input.sizeBytes ?? null,
            pageCount: input.pageCount ?? null,
            blocks: input.blocks,
            chunks: input.chunks,
            summary: input.summary ?? null,
        })
        return ok(result)
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}
