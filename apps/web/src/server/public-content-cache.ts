import { revalidateTag, unstable_cache } from "next/cache"

export const PUBLIC_CONTENT_CACHE_TAGS = {
    articleDetail: "public:article:detail",
    articleList: "public:article:list",
    aboutProfile: "public:about:profile",
    siteAppearance: "public:site:appearance",
} as const

export const PUBLIC_CONTENT_CACHE_TTL_SECONDS = {
    articleDetail: 300,
    articleList: 60,
    aboutProfile: 300,
    siteAppearance: 300,
} as const

type PublicContentCacheKey = keyof typeof PUBLIC_CONTENT_CACHE_TAGS

const publicContentCacheKeyParts: Record<PublicContentCacheKey, string[]> = {
    articleDetail: ["public-content", "article-detail"],
    articleList: ["public-content", "article-list"],
    aboutProfile: ["public-content", "about-profile"],
    siteAppearance: ["public-content", "site-appearance"],
}

export function cachePublicContent<T>(key: PublicContentCacheKey, loader: () => Promise<T>) {
    return unstable_cache(loader, publicContentCacheKeyParts[key], {
        revalidate: PUBLIC_CONTENT_CACHE_TTL_SECONDS[key],
        tags: [PUBLIC_CONTENT_CACHE_TAGS[key]],
    })
}

export function cachePublicArticleDetail<T>(shareCode: string, loader: () => Promise<T>) {
    return unstable_cache(loader, [...publicContentCacheKeyParts.articleDetail, shareCode], {
        revalidate: PUBLIC_CONTENT_CACHE_TTL_SECONDS.articleDetail,
        tags: [PUBLIC_CONTENT_CACHE_TAGS.articleDetail, buildPublicArticleDetailCacheTag(shareCode)],
    })
}

export function invalidatePublicArticleListCache() {
    revalidateTag(PUBLIC_CONTENT_CACHE_TAGS.articleList, "max")
}

export function invalidatePublicArticleDetailCache(shareCode?: string | null) {
    const normalizedShareCode = shareCode?.trim()
    revalidateTag(
        normalizedShareCode ? buildPublicArticleDetailCacheTag(normalizedShareCode) : PUBLIC_CONTENT_CACHE_TAGS.articleDetail,
        "max",
    )
}

export function invalidatePublicAboutProfileCache() {
    revalidateTag(PUBLIC_CONTENT_CACHE_TAGS.aboutProfile, "max")
}

export function invalidatePublicSiteAppearanceCache() {
    revalidateTag(PUBLIC_CONTENT_CACHE_TAGS.siteAppearance, "max")
}

function buildPublicArticleDetailCacheTag(shareCode: string) {
    return `${PUBLIC_CONTENT_CACHE_TAGS.articleDetail}:${shareCode}`
}
