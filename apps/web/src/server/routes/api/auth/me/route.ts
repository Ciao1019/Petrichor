import type { AppRequest } from "@/server/http/request"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, toErrorResponse } from "@/server/http/response"
import { toUserResponse } from "@/server/mappers"

export async function GET(request: AppRequest) {
    try {
        return ok(toUserResponse(await requireCurrentUser(request)))
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}
