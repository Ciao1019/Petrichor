import type { MetadataRoute } from "next"

import { loadPublicSiteArticles } from "@/server/public-site/articles"
import { getPublicBaseUrl, toAbsolutePublicUrl } from "@/server/public-site/site-url"

export const dynamic = "force-dynamic"
export const revalidate = 60

function toDate(value: string) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? new Date() : date
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    const baseUrl = getPublicBaseUrl()
    const now = new Date()
    const staticRoutes: MetadataRoute.Sitemap = [
        {
            url: toAbsolutePublicUrl("/", baseUrl),
            lastModified: now,
            changeFrequency: "weekly",
            priority: 1,
        },
        {
            url: toAbsolutePublicUrl("/tags", baseUrl),
            lastModified: now,
            changeFrequency: "weekly",
            priority: 0.7,
        },
        {
            url: toAbsolutePublicUrl("/about", baseUrl),
            lastModified: now,
            changeFrequency: "monthly",
            priority: 0.6,
        },
    ]
    const articles = await loadPublicSiteArticles()
    const articleRoutes: MetadataRoute.Sitemap = articles.map((article) => ({
        url: toAbsolutePublicUrl(article.href, baseUrl),
        lastModified: toDate(article.updatedAt),
        changeFrequency: "monthly",
        priority: 0.8,
    }))

    return [...staticRoutes, ...articleRoutes]
}
