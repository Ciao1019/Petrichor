import type { AppRequest } from "@/server/http/request"
import { linuxDoCallbackGet } from "@/server/auth/linuxdo-handlers"

export async function GET(request: AppRequest) {
    return linuxDoCallbackGet(request)
}
