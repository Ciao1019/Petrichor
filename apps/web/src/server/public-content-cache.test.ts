import { beforeEach, describe, expect, it, vi } from "vitest"

const nextCacheMocks = vi.hoisted(() => ({
    revalidateTag: vi.fn(),
    unstable_cache: vi.fn((loader: () => Promise<unknown>) => loader),
}))

vi.mock("next/cache", () => nextCacheMocks)

import {
    PUBLIC_CONTENT_CACHE_TAGS,
    PUBLIC_CONTENT_CACHE_TTL_SECONDS,
    cachePublicArticleDetail,
    cachePublicContent,
    invalidatePublicAboutProfileCache,
    invalidatePublicArticleDetailCache,
    invalidatePublicArticleListCache,
} from "./public-content-cache"

describe("public content cache", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("用 Next unstable_cache 包装公开文章列表缓存配置", async () => {
        const loader = vi.fn(async () => ({ items: [] }))

        const cachedLoader = cachePublicContent("articleList", loader)
        await expect(cachedLoader()).resolves.toEqual({ items: [] })

        expect(nextCacheMocks.unstable_cache).toHaveBeenCalledWith(loader, ["public-content", "article-list"], {
            revalidate: PUBLIC_CONTENT_CACHE_TTL_SECONDS.articleList,
            tags: [PUBLIC_CONTENT_CACHE_TAGS.articleList],
        })
        expect(loader).toHaveBeenCalledTimes(1)
    })

    it("用 Next unstable_cache 包装关于我公开资料缓存配置", async () => {
        const loader = vi.fn(async () => ({ displayName: "CiZai" }))

        const cachedLoader = cachePublicContent("aboutProfile", loader)
        await expect(cachedLoader()).resolves.toEqual({ displayName: "CiZai" })

        expect(nextCacheMocks.unstable_cache).toHaveBeenCalledWith(loader, ["public-content", "about-profile"], {
            revalidate: PUBLIC_CONTENT_CACHE_TTL_SECONDS.aboutProfile,
            tags: [PUBLIC_CONTENT_CACHE_TAGS.aboutProfile],
        })
        expect(loader).toHaveBeenCalledTimes(1)
    })

    it("用 shareCode 维度包装无密码公开文章详情缓存配置", async () => {
        const loader = vi.fn(async () => ({ title: "公开文章" }))

        const cachedLoader = cachePublicArticleDetail("shareCode123", loader)
        await expect(cachedLoader()).resolves.toEqual({ title: "公开文章" })

        expect(nextCacheMocks.unstable_cache).toHaveBeenCalledWith(loader, ["public-content", "article-detail", "shareCode123"], {
            revalidate: PUBLIC_CONTENT_CACHE_TTL_SECONDS.articleDetail,
            tags: [PUBLIC_CONTENT_CACHE_TAGS.articleDetail, "public:article:detail:shareCode123"],
        })
        expect(loader).toHaveBeenCalledTimes(1)
    })

    it("主动失效使用指定 tag 和 max profile", () => {
        invalidatePublicArticleListCache()
        invalidatePublicArticleDetailCache()
        invalidatePublicArticleDetailCache("shareCode123")
        invalidatePublicAboutProfileCache()

        expect(nextCacheMocks.revalidateTag).toHaveBeenCalledWith(PUBLIC_CONTENT_CACHE_TAGS.articleList, "max")
        expect(nextCacheMocks.revalidateTag).toHaveBeenCalledWith(PUBLIC_CONTENT_CACHE_TAGS.articleDetail, "max")
        expect(nextCacheMocks.revalidateTag).toHaveBeenCalledWith("public:article:detail:shareCode123", "max")
        expect(nextCacheMocks.revalidateTag).toHaveBeenCalledWith(PUBLIC_CONTENT_CACHE_TAGS.aboutProfile, "max")
    })
})
