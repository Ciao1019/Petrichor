import { routeDefinitions } from "./routes.generated"
import type { RouteDefinition, RouteModule, RouteParams } from "./types"
import type { AppRequest } from "@/server/http/request"

type CatchAllRoute = {
    prefix: string
    paramName: string
    definition: RouteDefinition
}

const exactRoutes = new Map<string, RouteDefinition>()
const catchAllRoutes: CatchAllRoute[] = []

for (const definition of routeDefinitions) {
    const match = definition.path.match(/^(.*)\/\[\.\.\.([^/]+)]$/)
    if (match) {
        catchAllRoutes.push({
            prefix: `${match[1]}/`,
            paramName: match[2],
            definition,
        })
    } else {
        exactRoutes.set(definition.path, definition)
    }
}

function resolveRoute(pathname: string): { module: RouteModule; params: RouteParams } | null {
    const exact = exactRoutes.get(pathname)
    if (exact) return { module: exact.module, params: {} }

    for (const route of catchAllRoutes) {
        if (!pathname.startsWith(route.prefix)) continue
        const tail = pathname.slice(route.prefix.length)
        if (!tail) continue
        return {
            module: route.definition.module,
            params: {
                [route.paramName]: tail.split("/").map((part) => decodeURIComponent(part)),
            },
        }
    }
    return null
}

export function hasApiRoute(pathname: string) {
    return resolveRoute(pathname) !== null
}

export async function dispatchApiRequest(request: AppRequest) {
    const resolved = resolveRoute(request.urlObject.pathname)
    if (!resolved) {
        return Response.json({ code: 404, msg: "接口不存在" }, { status: 404 })
    }

    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: { Allow: allowedMethods(resolved.module).join(", ") } })
    }

    const method = request.method === "HEAD" && !resolved.module.HEAD ? "GET" : request.method
    const handler = resolved.module[method as keyof RouteModule]
    if (!handler) {
        return Response.json(
            { code: 405, msg: "请求方法不受支持" },
            { status: 405, headers: { Allow: allowedMethods(resolved.module).join(", ") } },
        )
    }

    const response = await handler(request, { params: Promise.resolve(resolved.params) })
    if (request.method === "HEAD") {
        return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers })
    }
    return response
}

function allowedMethods(module: RouteModule) {
    const methods = Object.keys(module).filter((key) => ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(key))
    if (module.GET && !methods.includes("HEAD")) methods.push("HEAD")
    methods.push("OPTIONS")
    return methods
}

