import { buildAtomFeedXml, buildRssFeedXml } from "@/server/public-site/feed"
import { loadPublicSiteArticles } from "@/server/public-site/articles"
import { getPublicBaseUrl, toAbsolutePublicUrl } from "@/server/public-site/site-url"

const feedHeaders = {
    "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
}

export async function rssFeed() {
    const xml = buildRssFeedXml(await loadPublicSiteArticles(), getPublicBaseUrl())
    return new Response(xml, { headers: { ...feedHeaders, "Content-Type": "application/rss+xml; charset=utf-8" } })
}

export async function atomFeed() {
    const xml = buildAtomFeedXml(await loadPublicSiteArticles(), getPublicBaseUrl())
    return new Response(xml, { headers: { ...feedHeaders, "Content-Type": "application/atom+xml; charset=utf-8" } })
}

export function robotsTxt() {
    const sitemap = toAbsolutePublicUrl("/sitemap.xml", getPublicBaseUrl())
    return new Response(`User-agent: *\nAllow: /\nDisallow: /dashboard\nDisallow: /login\nDisallow: /auth\nSitemap: ${sitemap}\n`, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
}

export async function sitemapXml() {
    const baseUrl = getPublicBaseUrl()
    const now = new Date().toISOString()
    const staticRoutes = [
        ["/", "weekly", "1.0"],
        ["/tags", "weekly", "0.7"],
        ["/about", "monthly", "0.6"],
        ["/petrichor", "monthly", "0.7"],
    ] as const
    const entries: Array<{ url: string; lastModified: string; changeFrequency: string; priority: string }> = staticRoutes.map(([pathname, changeFrequency, priority]) => ({
        url: toAbsolutePublicUrl(pathname, baseUrl),
        lastModified: now,
        changeFrequency,
        priority,
    }))
    for (const article of await loadPublicSiteArticles()) {
        entries.push({
            url: toAbsolutePublicUrl(article.href, baseUrl),
            lastModified: toIsoDate(article.updatedAt),
            changeFrequency: "monthly",
            priority: "0.8",
        })
    }
    const body = entries.map((entry) => [
        "  <url>",
        `    <loc>${escapeXml(entry.url)}</loc>`,
        `    <lastmod>${entry.lastModified}</lastmod>`,
        `    <changefreq>${entry.changeFrequency}</changefreq>`,
        `    <priority>${entry.priority}</priority>`,
        "  </url>",
    ].join("\n")).join("\n")
    return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`, {
        headers: { "Content-Type": "application/xml; charset=utf-8", ...feedHeaders },
    })
}

function toIsoDate(value: string) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

function escapeXml(value: string) {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}
