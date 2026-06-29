import type { NextRequest } from "next/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, readJson, toErrorResponse } from "@/server/http/response"
import { librarySaveSchema, saveLibrary } from "@/server/doc-library/library-logic"

export async function POST(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = librarySaveSchema.parse(await readJson(request))
        const result = await saveLibrary({
            userId: user.id,
            id: input.id ?? null,
            name: input.name,
            description: input.description ?? null,
            color: input.color ?? null,
            icon: input.icon ?? null,
        })
        return ok(result)
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}
