import { revalidateTag, unstable_cache } from "next/cache"

import { cacheDrop, cacheDropByPrefix, cacheKey, cacheReadThrough } from "@/server/cache"
import { getRedis } from "@/server/cache/redis"

export const PUBLIC_CONTENT_CACHE_TAGS = {
    articleDetail: "public:article:detail",
    articleList: "public:article:list",
    aboutProfile: "public:about:profile",
    projectShowcase: "public:project:showcase",
    siteAppearance: "public:site:appearance",
    siteGraph: "public:site:graph",
} as const

// 公开内容缓存统一 TTL：1 天。写操作都会主动失效（invalidate* + revalidateTag），
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

type PublicContentCacheKey = keyof typeof PUBLIC_CONTENT_CACHE_TAGS

const publicContentCacheKeyParts: Record<PublicContentCacheKey, string[]> = {
    articleDetail: ["public-content", "article-detail"],
    articleList: ["public-content", "article-list"],
    aboutProfile: ["public-content", "about-profile"],
    projectShowcase: ["public-content", "project-showcase"],
    siteAppearance: ["public-content", "site-appearance"],
    siteGraph: ["public-content", "site-graph"],
}

// Redis 缓存键：与 unstable_cache 的键各自独立，二选一启用（配置了 Upstash 即走 Redis）
const publicContentRedisKey: Record<PublicContentCacheKey, string> = {
    articleDetail: cacheKey("public", "article-detail"),
    articleList: cacheKey("public", "article-list"),
    aboutProfile: cacheKey("public", "about-profile"),
    projectShowcase: cacheKey("public", "project-showcase"),
    siteAppearance: cacheKey("public", "site-appearance"),
    siteGraph: cacheKey("public", "site-graph"),
}

export function cachePublicContent<T>(key: PublicContentCacheKey, loader: () => Promise<T>) {
    const nextCached = unstable_cache(loader, publicContentCacheKeyParts[key], {
        revalidate: PUBLIC_CONTENT_CACHE_TTL_SECONDS[key],
        tags: [PUBLIC_CONTENT_CACHE_TAGS[key]],
    })

    return async (): Promise<T> => {
        // 配置了 Upstash 时走 Redis 共享缓存；否则回退到 Next.js 数据缓存（保持原有行为）
        if (!getRedis()) {
            return nextCached() as Promise<T>
        }
        return cacheReadThrough(publicContentRedisKey[key], PUBLIC_CONTENT_CACHE_TTL_SECONDS[key], loader)
    }
}

export function cachePublicArticleDetail<T>(shareCode: string, loader: () => Promise<T>) {
    const nextCached = unstable_cache(loader, [...publicContentCacheKeyParts.articleDetail, shareCode], {
        revalidate: PUBLIC_CONTENT_CACHE_TTL_SECONDS.articleDetail,
        tags: [PUBLIC_CONTENT_CACHE_TAGS.articleDetail, buildPublicArticleDetailCacheTag(shareCode)],
    })

    return async (): Promise<T> => {
        if (!getRedis()) {
            return nextCached() as Promise<T>
        }
        return cacheReadThrough(
            buildPublicArticleDetailRedisKey(shareCode),
            PUBLIC_CONTENT_CACHE_TTL_SECONDS.articleDetail,
            loader,
        )
    }
}

export function invalidatePublicArticleListCache() {
    revalidateTag(PUBLIC_CONTENT_CACHE_TAGS.articleList, "max")
    void cacheDrop(publicContentRedisKey.articleList)
}

export function invalidatePublicArticleDetailCache(shareCode?: string | null) {
    const normalizedShareCode = shareCode?.trim()
    revalidateTag(
        normalizedShareCode ? buildPublicArticleDetailCacheTag(normalizedShareCode) : PUBLIC_CONTENT_CACHE_TAGS.articleDetail,
        "max",
    )
    if (normalizedShareCode) {
        void cacheDrop(buildPublicArticleDetailRedisKey(normalizedShareCode))
    } else {
        // 未指定 shareCode：失效全部文章详情缓存
        void cacheDropByPrefix(`${publicContentRedisKey.articleDetail}:`)
    }
}

export function invalidatePublicAboutProfileCache() {
    revalidateTag(PUBLIC_CONTENT_CACHE_TAGS.aboutProfile, "max")
    void cacheDrop(publicContentRedisKey.aboutProfile)
}

export function invalidatePublicProjectShowcaseCache() {
    revalidateTag(PUBLIC_CONTENT_CACHE_TAGS.projectShowcase, "max")
    void cacheDrop(publicContentRedisKey.projectShowcase)
}

export function invalidatePublicSiteAppearanceCache() {
    revalidateTag(PUBLIC_CONTENT_CACHE_TAGS.siteAppearance, "max")
    void cacheDrop(publicContentRedisKey.siteAppearance)
}

export function invalidatePublicSiteGraphCache() {
    revalidateTag(PUBLIC_CONTENT_CACHE_TAGS.siteGraph, "max")
    void cacheDrop(publicContentRedisKey.siteGraph)
}

function buildPublicArticleDetailCacheTag(shareCode: string) {
    return `${PUBLIC_CONTENT_CACHE_TAGS.articleDetail}:${shareCode}`
}

function buildPublicArticleDetailRedisKey(shareCode: string) {
    return cacheKey("public", "article-detail", shareCode)
}
