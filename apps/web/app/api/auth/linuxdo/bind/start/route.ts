import { NextRequest } from "next/server"
import { linuxDoBindStartGet } from "@/server/auth/linuxdo-handlers"

export async function GET(request: NextRequest) {
    return linuxDoBindStartGet(request)
}
