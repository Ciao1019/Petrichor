import { isIP } from "node:net"
import path from "node:path"

const port = Number(process.env.PORT ?? 3000)
const hostname = process.env.HOST ?? "0.0.0.0"
const staticDirectory = path.join(import.meta.dir, "dist")
const developmentAssetsUrl = normalizeOrigin(process.env.PETRICHOR_VITE_DEV_SERVER_URL)
const goApiUrl = normalizeOrigin(process.env.PETRICHOR_GO_API_URL) ?? "http://127.0.0.1:8080"
const trustProxyHeaders = /^(1|true|yes)$/i.test(process.env.PETRICHOR_TRUST_PROXY_HEADERS ?? "")
const proxyTimeoutMs = positiveNumber(process.env.PETRICHOR_PROXY_TIMEOUT_MS, 15 * 60 * 1000)
const isProduction = process.env.NODE_ENV === "production"

const securityHeaders = {
    "X-DNS-Prefetch-Control": "on",
    "X-Frame-Options": "SAMEORIGIN",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'self'",
        "form-action 'self'",
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob: https:",
        "connect-src 'self' https: wss:",
        "frame-src 'self' https:",
        "worker-src 'self' blob:",
    ].join("; "),
}

let indexTemplate: Promise<string> | undefined

const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 255,
    async fetch(request, bunServer) {
        const url = new URL(request.url)

        try {
            let response: Response
            if (isBackendPath(url.pathname)) {
                response = await proxyRequest(request, goApiUrl, resolveClientIP(request, bunServer))
            } else if (developmentAssetsUrl) {
                response = await proxyRequest(request, developmentAssetsUrl, resolveClientIP(request, bunServer))
            } else {
                response = await serveProductionAsset(request)
            }

            applySecurityHeaders(response.headers)
            return response
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[bun-web] ${request.method} ${url.pathname} 处理失败：${message}`)
            const response = isBackendPath(url.pathname)
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

async function proxyRequest(request: Request, origin: string, clientIP: string | undefined) {
    const sourceUrl = new URL(request.url)
    const targetUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}`, origin)
    const headers = new Headers(request.headers)
    for (const name of ["host", "forwarded", "x-forwarded-for", "x-real-ip", "cf-connecting-ip"]) {
        headers.delete(name)
    }
    headers.set("x-forwarded-host", sourceUrl.host)
    headers.set("x-forwarded-proto", sourceUrl.protocol.replace(":", ""))
    headers.set("x-forwarded-port", sourceUrl.port || (sourceUrl.protocol === "https:" ? "443" : "80"))
    if (clientIP) {
        headers.set("x-forwarded-for", clientIP)
        headers.set("x-real-ip", clientIP)
    }

    const timeoutSignal = AbortSignal.timeout(proxyTimeoutMs)
    return fetch(targetUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
        signal: AbortSignal.any([request.signal, timeoutSignal]),
    })
}

async function serveProductionAsset(request: Request) {
    const pathname = new URL(request.url).pathname
    const filePath = safeStaticPath(pathname)
    if (filePath) {
        const source = Bun.file(filePath)
        if (await source.exists() && source.type !== "text/html") {
            const encoding = request.headers.has("Range") ? undefined : preferredEncoding(request.headers.get("Accept-Encoding"))
            const compressed = encoding ? Bun.file(`${filePath}.${encoding === "br" ? "br" : "gz"}`) : undefined
            const body = compressed && await compressed.exists() ? compressed : source
            const headers = new Headers({
                "Cache-Control": pathname.startsWith("/assets/")
                    ? "public, max-age=31536000, immutable"
                    : "public, max-age=3600",
                "Content-Type": source.type || "application/octet-stream",
            })
            if (body !== source && encoding) {
                headers.set("Content-Encoding", encoding)
                headers.set("Vary", "Accept-Encoding")
            }
            return new Response(body, { headers })
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
    if (!relative || relative.endsWith("/") || relative.endsWith(".br") || relative.endsWith(".gz")) return null
    const resolved = path.resolve(staticDirectory, relative)
    return resolved.startsWith(`${staticDirectory}${path.sep}`) ? resolved : null
}

function preferredEncoding(header: string | null): "br" | "gzip" | undefined {
    if (!header) return undefined
    const accepted = new Map<string, number>()
    for (const part of header.toLowerCase().split(",")) {
        const [name, ...parameters] = part.trim().split(";")
        let quality = 1
        for (const parameter of parameters) {
            const match = parameter.trim().match(/^q=(0(?:\.\d+)?|1(?:\.0+)?)$/)
            if (match) quality = Number(match[1])
        }
        if (name) accepted.set(name, quality)
    }
    if ((accepted.get("br") ?? 0) > 0) return "br"
    if ((accepted.get("gzip") ?? 0) > 0) return "gzip"
    return undefined
}

function resolveClientIP(request: Request, bunServer: Bun.Server<unknown>) {
    if (trustProxyHeaders) {
        for (const header of ["cf-connecting-ip", "x-real-ip", "x-forwarded-for"]) {
            const candidate = request.headers.get(header)?.split(",", 1)[0]?.trim()
            if (candidate && isIP(candidate) !== 0) return candidate
        }
    }
    const candidate = bunServer.requestIP(request)?.address
    return candidate && isIP(candidate) !== 0 ? candidate : undefined
}

function isBackendPath(pathname: string) {
    return pathname.startsWith("/api/") || pathname === "/healthz" || pathname === "/readyz"
}

function normalizeOrigin(value: string | undefined) {
    const normalized = value?.trim().replace(/\/+$/, "")
    return normalized || undefined
}

function positiveNumber(value: string | undefined, fallback: number) {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function applySecurityHeaders(headers: Headers) {
    for (const [name, value] of Object.entries(securityHeaders)) {
        headers.set(name, value)
    }
    if (isProduction) {
        headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    }
}
