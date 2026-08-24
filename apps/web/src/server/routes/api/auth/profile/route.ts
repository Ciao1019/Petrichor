import { eq } from "drizzle-orm"
import type { AppRequest } from "@/server/http/request"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import { betterAuthUsers } from "@/server/db/schema"
import { ok, toErrorResponse } from "@/server/http/response"
import { toUserProfileResponse } from "@/server/mappers"

export async function GET(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        let twoFactorEnabled = false
        if (user.authUserId) {
            const [row] = await getDb()
                .select({ twoFactorEnabled: betterAuthUsers.twoFactorEnabled })
                .from(betterAuthUsers)
                .where(eq(betterAuthUsers.id, user.authUserId))
                .limit(1)
            twoFactorEnabled = Boolean(row?.twoFactorEnabled)
        }
        return ok(toUserProfileResponse(user, { twoFactorEnabled }))
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}
