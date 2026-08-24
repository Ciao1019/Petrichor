import { beforeEach, describe, expect, it, vi } from "vitest"

const cacheMocks = vi.hoisted(() => ({
    cacheDrop: vi.fn(async () => undefined),
    cacheDropByPrefix: vi.fn(async () => undefined),
    cacheKey: vi.fn((...parts: Array<string | number>) => ["petrichor", ...parts].join(":")),
    cacheReadThrough: vi.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader()),
}))

vi.mock("@/server/cache", () => cacheMocks)

import {
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

    it("用统一读穿透缓存包装公开文章列表", async () => {
        const loader = vi.fn(async () => ({ items: [] }))
        await expect(cachePublicContent("articleList", loader)()).resolves.toEqual({ items: [] })
        expect(cacheMocks.cacheReadThrough).toHaveBeenCalledWith(
            "petrichor:public:article-list",
            PUBLIC_CONTENT_CACHE_TTL_SECONDS.articleList,
            loader,
        )
    })

    it("用统一读穿透缓存包装关于我公开资料", async () => {
        const loader = vi.fn(async () => ({ displayName: "CiZai" }))
        await expect(cachePublicContent("aboutProfile", loader)()).resolves.toEqual({ displayName: "CiZai" })
        expect(cacheMocks.cacheReadThrough).toHaveBeenCalledWith(
            "petrichor:public:about-profile",
            PUBLIC_CONTENT_CACHE_TTL_SECONDS.aboutProfile,
            loader,
        )
    })

    it("用 shareCode 维度缓存无密码公开文章详情", async () => {
        const loader = vi.fn(async () => ({ title: "公开文章" }))
        await expect(cachePublicArticleDetail("shareCode123", loader)()).resolves.toEqual({ title: "公开文章" })
        expect(cacheMocks.cacheReadThrough).toHaveBeenCalledWith(
            "petrichor:public:article-detail:shareCode123",
            PUBLIC_CONTENT_CACHE_TTL_SECONDS.articleDetail,
            loader,
        )
    })

    it("主动失效精确键与文章详情前缀", () => {
        invalidatePublicArticleListCache()
        invalidatePublicArticleDetailCache()
        invalidatePublicArticleDetailCache("shareCode123")
        invalidatePublicAboutProfileCache()

        expect(cacheMocks.cacheDrop).toHaveBeenCalledWith("petrichor:public:article-list")
        expect(cacheMocks.cacheDropByPrefix).toHaveBeenCalledWith("petrichor:public:article-detail:")
        expect(cacheMocks.cacheDrop).toHaveBeenCalledWith("petrichor:public:article-detail:shareCode123")
        expect(cacheMocks.cacheDrop).toHaveBeenCalledWith("petrichor:public:about-profile")
    })
})
