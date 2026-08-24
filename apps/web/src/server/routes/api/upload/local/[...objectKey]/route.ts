import type { AppRequest } from "@/server/http/request"
import { requireCurrentUser } from "@/server/auth/current-user"
import { HttpError, toErrorResponse } from "@/server/http/response"
import {
    readLocalObjectBytes,
    writeLocalObjectBytes,
} from "@/server/upload/local-storage"

type LocalObjectParams = {
    objectKey?: string[]
}

type LocalObjectContext = {
    params: Promise<LocalObjectParams>
}

async function resolveObjectKey(context: LocalObjectContext) {
    const params = await context.params
    const objectKey = params.objectKey?.join("/") ?? ""
    if (!objectKey) {
        throw new HttpError(400, "对象键不能为空")
    }
    return objectKey
}

export async function PUT(request: AppRequest, context: LocalObjectContext) {
    try {
        await requireCurrentUser(request)
        const objectKey = await resolveObjectKey(context)
        const data = Buffer.from(await request.arrayBuffer())
        await writeLocalObjectBytes({
            contentType: request.headers.get("content-type"),
            data,
            objectKey,
        })
        return new Response(null, { status: 204 })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

export async function GET(request: AppRequest, context: LocalObjectContext) {
    try {
        const objectKey = await resolveObjectKey(context)
        const object = await readLocalObjectBytes(objectKey)
        return new Response(new Uint8Array(object.data), {
            headers: {
                "Cache-Control": "private, max-age=3600",
                "Content-Type": object.mime,
            },
        })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}
