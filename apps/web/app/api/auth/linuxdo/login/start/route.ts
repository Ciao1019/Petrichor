import { NextRequest } from "next/server"
import { linuxDoLoginStartGet } from "@/server/auth/linuxdo-handlers"

export async function GET(request: NextRequest) {
    return linuxDoLoginStartGet(request)
}
