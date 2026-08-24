import { ZodError } from "zod"
import { createLogger, toLogError } from "@/lib/logger"

const log = createLogger("http-response")

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

export function conflict(message = "资源冲突") {
    return new HttpError(409, message)
}

export function tooManyRequests(message = "请求过于频繁，请稍后再试") {
    return new HttpError(429, message)
}

export function ok<T>(data: T, init?: ResponseInit) {
    return Response.json(data, init)
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
        log.warn({ path, issues: error.issues }, "API 请求参数校验失败")
        return errorJson(400, "请求参数错误", path)
    }
    if (error instanceof HttpError) {
        log.warn({ path, status: error.status, err: error }, "API 请求失败")
        return errorJson(error.status, error.message, path)
    }
    log.error({ path, err: toLogError(error) }, "API 未处理异常")
    return errorJson(500, "系统异常，请稍后重试", path)
}

function errorJson(status: number, msg: string, path: string) {
    return Response.json(
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
