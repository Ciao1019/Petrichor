import type { AppRequest } from "@/server/http/request"
import { linuxDoBindStartGet } from "@/server/auth/linuxdo-handlers"

export async function GET(request: AppRequest) {
    return linuxDoBindStartGet(request)
}
