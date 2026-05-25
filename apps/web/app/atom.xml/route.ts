import { buildAtomFeedXml } from "@/server/public-site/feed"
import { loadPublicSiteArticles } from "@/server/public-site/articles"
import { getPublicBaseUrl } from "@/server/public-site/site-url"

export const dynamic = "force-dynamic"
export const revalidate = 60

export async function GET() {
    const articles = await loadPublicSiteArticles()
    const xml = buildAtomFeedXml(articles, getPublicBaseUrl())

    return new Response(xml, {
        headers: {
            "Content-Type": "application/atom+xml; charset=utf-8",
            "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
        },
    })
}
