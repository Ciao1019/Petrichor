import type { AppRequest } from "@/server/http/request"
import { linuxDoLoginStartGet } from "@/server/auth/linuxdo-handlers"

export async function GET(request: AppRequest) {
    return linuxDoLoginStartGet(request)
}
