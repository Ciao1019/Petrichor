import path from "node:path"

const port = Number(process.env.PORT ?? 3000)
const hostname = process.env.HOST ?? "0.0.0.0"
const staticDirectory = path.join(import.meta.dir, "apps/web/dist")
const developmentAssetsUrl = normalizeOrigin(process.env.PETRICHOR_VITE_DEV_SERVER_URL)
const goApiUrl = normalizeOrigin(process.env.PETRICHOR_GO_API_URL) ?? "http://127.0.0.1:8080"

const securityHeaders = {
    "X-DNS-Prefetch-Control": "on",
    "X-Frame-Options": "SAMEORIGIN",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}

let indexTemplate: Promise<string> | undefined

const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 255,
    async fetch(request) {
        const url = new URL(request.url)

        try {
            let response: Response
            if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") {
                response = await proxyRequest(request, goApiUrl)
            } else if (developmentAssetsUrl) {
                response = await proxyRequest(request, developmentAssetsUrl)
            } else {
                response = await serveProductionAsset(request)
            }

            applySecurityHeaders(response.headers)
            return response
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[bun-web] ${request.method} ${url.pathname} 处理失败：${message}`)
            const response = url.pathname.startsWith("/api/")
                ? Response.json(
                    { code: 502, msg: "Go 后端暂不可用", path: url.pathname, timestamp: new Date().toISOString() },
                    { status: 502 },
                )
                : new Response("前端服务暂不可用", { status: 502 })
            applySecurityHeaders(response.headers)
            return response
        }
    },
})

console.log(`Petrichor Bun web: ${server.url}`)
console.log(`Petrichor Go API proxy: ${goApiUrl}`)

async function proxyRequest(request: Request, origin: string) {
    const sourceUrl = new URL(request.url)
    const targetUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}`, origin)
    const headers = new Headers(request.headers)
    headers.delete("host")
    headers.set("x-forwarded-host", sourceUrl.host)
    headers.set("x-forwarded-proto", sourceUrl.protocol.replace(":", ""))

    return fetch(targetUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
    })
}

async function serveProductionAsset(request: Request) {
    const pathname = new URL(request.url).pathname
    const filePath = safeStaticPath(pathname)
    if (filePath) {
        const file = Bun.file(filePath)
        if (await file.exists() && file.type !== "text/html") {
            return new Response(file, {
                headers: pathname.startsWith("/assets/")
                    ? { "Cache-Control": "public, max-age=31536000, immutable" }
                    : { "Cache-Control": "public, max-age=3600" },
            })
        }
    }

    indexTemplate ??= Bun.file(path.join(staticDirectory, "index.html")).text()
    return new Response(await indexTemplate, {
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
        },
    })
}

function safeStaticPath(pathname: string) {
    let decoded: string
    try {
        decoded = decodeURIComponent(pathname)
    } catch {
        return null
    }

    const relative = decoded.replace(/^\/+/, "")
    if (!relative || relative.endsWith("/")) return null
    const resolved = path.resolve(staticDirectory, relative)
    return resolved.startsWith(`${staticDirectory}${path.sep}`) ? resolved : null
}

function normalizeOrigin(value: string | undefined) {
    const normalized = value?.trim().replace(/\/+$/, "")
    return normalized || undefined
}

function applySecurityHeaders(headers: Headers) {
    for (const [name, value] of Object.entries(securityHeaders)) {
        headers.set(name, value)
    }
}
