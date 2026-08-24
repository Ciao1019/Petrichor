import type { AppRequest } from "@/server/http/request"

export type RouteParams = Record<string, string | string[]>
export type RouteContext = { params: Promise<RouteParams> }
export type RouteHandler = (request: AppRequest, context: RouteContext) => Response | Promise<Response>
export type RouteModule = Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD", RouteHandler>>

export type RouteDefinition = {
    path: string
    module: RouteModule
}

