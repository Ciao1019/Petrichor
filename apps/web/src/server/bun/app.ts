import path from "node:path"
import { createLogger, toLogError } from "@/lib/logger"
import { dispatchApiRequest, hasApiRoute } from "./api-router"
import { atomFeed, robotsTxt, rssFeed, sitemapXml } from "./site-handlers"
import { finalizeResponse, runWithRequestContext } from "@/server/http/request-context"
import { toAppRequest } from "@/server/http/request"
import { loadPublicSiteArticles } from "@/server/public-site/articles"
import { renderMetadataHead, resolvePublicRouteMetadata } from "@/server/public-site/metadata"

const log = createLogger("bun-server")
const securityHeaders = {
    "X-DNS-Prefetch-Control": "on",
    "X-Frame-Options": "SAMEORIGIN",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}

export type BunAppOptions = {
    staticDirectory: string
    developmentAssetsUrl?: string
}

export function createBunApp(options: BunAppOptions) {
    const staticDirectory = path.resolve(options.staticDirectory)
    let indexTemplate: Promise<string> | undefined

    return async function fetch(request: Request) {
        return runWithRequestContext(async () => {
            const appRequest = toAppRequest(request)
            const pathname = appRequest.urlObject.pathname

            try {
                let response: Response
                if (pathname.startsWith("/api/") || hasApiRoute(pathname)) {
                    response = await dispatchApiRequest(appRequest)
                } else if (pathname === "/rss.xml") {
                    response = await rssFeed()
                } else if (pathname === "/atom.xml") {
                    response = await atomFeed()
                } else if (pathname === "/robots.txt") {
                    response = robotsTxt()
                } else if (pathname === "/sitemap.xml") {
                    response = await sitemapXml()
                } else if (pathname === "/healthz") {
                    response = Response.json({ status: "ok", runtime: "bun" })
                } else if (options.developmentAssetsUrl) {
                    response = await proxyDevelopmentAsset(appRequest, options.developmentAssetsUrl)
                } else {
                    response = await serveProductionAsset(appRequest, staticDirectory, () => {
                        indexTemplate ??= Bun.file(path.join(staticDirectory, "index.html")).text()
                        return indexTemplate
                    })
                }

                applySecurityHeaders(response.headers)
                return finalizeResponse(response)
            } catch (error) {
                log.error({ err: toLogError(error), method: request.method, pathname }, "Bun 请求处理失败")
                const response = Response.json(
                    { code: 500, msg: "系统异常，请稍后重试", path: pathname, timestamp: new Date().toISOString() },
                    { status: 500 },
                )
                applySecurityHeaders(response.headers)
                return finalizeResponse(response)
            }
        })
    }
}

async function serveProductionAsset(request: Request, staticDirectory: string, loadIndex: () => Promise<string>) {
    const pathname = new URL(request.url).pathname
    const filePath = safeStaticPath(staticDirectory, pathname)
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

    const segments = pathname.split("/").filter(Boolean)
    const articles = segments[0] === "p" ? await loadPublicSiteArticles({ includeNonIndexable: true }) : []
    const metadata = resolvePublicRouteMetadata(segments, articles)
    const html = (await loadIndex()).replace("<!-- PETRICHOR_METADATA -->", renderMetadataHead(metadata))
    return new Response(html, {
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
        },
    })
}

function safeStaticPath(staticDirectory: string, pathname: string) {
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

async function proxyDevelopmentAsset(request: Request, origin: string) {
    const sourceUrl = new URL(request.url)
    const targetUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}`, origin)
    return fetch(targetUrl, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
    })
}

function applySecurityHeaders(headers: Headers) {
    for (const [name, value] of Object.entries(securityHeaders)) {
        headers.set(name, value)
    }
}

