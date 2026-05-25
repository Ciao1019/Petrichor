import { NextRequest } from "next/server"
import { linuxDoCallbackGet } from "@/server/auth/linuxdo-handlers"

export async function GET(request: NextRequest) {
    return linuxDoCallbackGet(request)
}
