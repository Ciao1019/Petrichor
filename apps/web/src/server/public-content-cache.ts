import { cacheDrop, cacheDropByPrefix, cacheKey, cacheReadThrough } from "@/server/cache"

export const PUBLIC_CONTENT_CACHE_TAGS = {
    articleDetail: "public:article:detail",
    articleList: "public:article:list",
    aboutProfile: "public:about:profile",
    projectShowcase: "public:project:showcase",
    siteAppearance: "public:site:appearance",
    siteGraph: "public:site:graph",
} as const

// 公开内容缓存统一 TTL：1 天。写操作都会主动失效，
// 所以 TTL 只是兜底上限，不影响内容新鲜度。注意：这不影响 share-handlers 里独立硬编码的
// HTTP Cache-Control（s-maxage），CDN/浏览器缓存仍按原值。
const PUBLIC_CONTENT_TTL_SECONDS = 60 * 60 * 24

export const PUBLIC_CONTENT_CACHE_TTL_SECONDS = {
    articleDetail: PUBLIC_CONTENT_TTL_SECONDS,
    articleList: PUBLIC_CONTENT_TTL_SECONDS,
    aboutProfile: PUBLIC_CONTENT_TTL_SECONDS,
    projectShowcase: PUBLIC_CONTENT_TTL_SECONDS,
    siteAppearance: PUBLIC_CONTENT_TTL_SECONDS,
    siteGraph: PUBLIC_CONTENT_TTL_SECONDS,
} as const

type PublicContentCacheKey = keyof typeof PUBLIC_CONTENT_CACHE_TTL_SECONDS

const publicContentRedisKey: Record<PublicContentCacheKey, string> = {
    articleDetail: cacheKey("public", "article-detail"),
    articleList: cacheKey("public", "article-list"),
    aboutProfile: cacheKey("public", "about-profile"),
    projectShowcase: cacheKey("public", "project-showcase"),
    siteAppearance: cacheKey("public", "site-appearance"),
    siteGraph: cacheKey("public", "site-graph"),
}

export function cachePublicContent<T>(key: PublicContentCacheKey, loader: () => Promise<T>) {
    return async (): Promise<T> => cacheReadThrough(
        publicContentRedisKey[key],
        PUBLIC_CONTENT_CACHE_TTL_SECONDS[key],
        loader,
    )
}

export function cachePublicArticleDetail<T>(shareCode: string, loader: () => Promise<T>) {
    return async (): Promise<T> => cacheReadThrough(
        buildPublicArticleDetailRedisKey(shareCode),
        PUBLIC_CONTENT_CACHE_TTL_SECONDS.articleDetail,
        loader,
    )
}

export function invalidatePublicArticleListCache() {
    void cacheDrop(publicContentRedisKey.articleList)
}

export function invalidatePublicArticleDetailCache(shareCode?: string | null) {
    const normalizedShareCode = shareCode?.trim()
    if (normalizedShareCode) {
        void cacheDrop(buildPublicArticleDetailRedisKey(normalizedShareCode))
    } else {
        // 未指定 shareCode：失效全部文章详情缓存
        void cacheDropByPrefix(`${publicContentRedisKey.articleDetail}:`)
    }
}

export function invalidatePublicAboutProfileCache() {
    void cacheDrop(publicContentRedisKey.aboutProfile)
}

export function invalidatePublicProjectShowcaseCache() {
    void cacheDrop(publicContentRedisKey.projectShowcase)
}

export function invalidatePublicSiteAppearanceCache() {
    void cacheDrop(publicContentRedisKey.siteAppearance)
}

export function invalidatePublicSiteGraphCache() {
    void cacheDrop(publicContentRedisKey.siteGraph)
}

function buildPublicArticleDetailRedisKey(shareCode: string) {
    return cacheKey("public", "article-detail", shareCode)
}
