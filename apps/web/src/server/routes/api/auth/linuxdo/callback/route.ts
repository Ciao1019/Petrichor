import type { AppRequest } from "@/server/http/request"
import { linuxDoCallbackPost } from "@/server/auth/linuxdo-handlers"

export async function POST(request: AppRequest) {
    return linuxDoCallbackPost(request)
}
