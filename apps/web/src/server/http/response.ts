import { NextResponse } from "next/server"
import { ZodError } from "zod"

export class HttpError extends Error {
    constructor(
        public readonly status: number,
        message: string,
    ) {
        super(message)
    }
}

export function badRequest(message: string) {
    return new HttpError(400, message)
}

export function unauthorized(message = "请先登录") {
    return new HttpError(401, message)
}

export function forbidden(message = "无权限访问") {
    return new HttpError(403, message)
}

export function notFound(message = "数据不存在") {
    return new HttpError(404, message)
}

export function ok<T>(data: T, init?: ResponseInit) {
    return NextResponse.json(data, init)
}

export function tableData<T>(rows: T[], total: number) {
    return ok({
        total,
        rows,
        code: 200,
        msg: "查询成功",
    })
}

export function toErrorResponse(error: unknown, path: string) {
    if (error instanceof ZodError) {
        return errorJson(400, "请求参数错误", path)
    }
    if (error instanceof HttpError) {
        return errorJson(error.status, error.message, path)
    }
    console.error(error)
    return errorJson(500, "系统异常，请稍后重试", path)
}

function errorJson(status: number, msg: string, path: string) {
    return NextResponse.json(
        {
            code: status,
            msg,
            path,
            timestamp: new Date().toISOString(),
        },
        { status },
    )
}

export async function readJson<T>(request: Request): Promise<T> {
    try {
        return await request.json() as T
    } catch {
        throw badRequest("请求体必须是合法 JSON")
    }
}
