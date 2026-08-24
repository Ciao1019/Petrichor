import type { AppRequest } from "@/server/http/request"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, toErrorResponse } from "@/server/http/response"
import { loadDashboardOverview } from "./overview-logic"

export async function dashboardOverview(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        return ok(await loadDashboardOverview(user.id))
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}
