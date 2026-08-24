import { eq } from "drizzle-orm"
import type { AppRequest } from "@/server/http/request"
import { z } from "zod"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import { users } from "@/server/db/schema"
import { ok, readJson, toErrorResponse } from "@/server/http/response"
import { toUserProfileResponse } from "@/server/mappers"

const schema = z.object({
    nickname: z.string().nullable().optional(),
    avatar: z.string().nullable().optional(),
    signature: z.string().nullable().optional(),
})

export async function POST(request: AppRequest) {
    try {
        const currentUser = await requireCurrentUser(request)
        const input = schema.parse(await readJson(request))
        const [user] = await getDb()
            .update(users)
            .set({ ...input, updatedAt: new Date() })
            .where(eq(users.id, currentUser.id))
            .returning()

        return ok(toUserProfileResponse(user))
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}
