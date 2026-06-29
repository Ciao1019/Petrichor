import type { NextRequest } from "next/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, toErrorResponse } from "@/server/http/response"
import { listLibraries } from "@/server/doc-library/library-logic"

export async function GET(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const libraries = await listLibraries(user.id)
        return ok({ libraries })
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}
