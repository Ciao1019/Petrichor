import type { PublicArticleListItem } from "@/lib/api"
import { loadPublicArticleListResponse } from "@/server/kb/share-handlers"

export interface PublicSiteArticleLoadOptions {
    includeNonIndexable?: boolean
}

export function isIndexablePublicArticle(article: PublicArticleListItem) {
    return Boolean(article.shareCode.trim() && article.href && !article.expired && !article.hasPassword)
}

export async function loadPublicSiteArticles(options: PublicSiteArticleLoadOptions = {}) {
    try {
        const response = await loadPublicArticleListResponse()
        const items = Array.isArray(response.items) ? response.items : []
        return options.includeNonIndexable ? items : items.filter(isIndexablePublicArticle)
    } catch {
        return []
    }
}
