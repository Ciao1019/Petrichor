import { NextRequest } from "next/server"
import { linuxDoCallbackPost } from "@/server/auth/linuxdo-handlers"

export async function POST(request: NextRequest) {
    return linuxDoCallbackPost(request)
}
