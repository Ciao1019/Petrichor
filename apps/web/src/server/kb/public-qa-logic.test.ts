import { beforeEach, describe, expect, it, vi } from "vitest"

const dbMocks = vi.hoisted(() => ({
    getDb: vi.fn(() => {
        throw new Error("getDb 不应在守卫校验阶段被调用")
    }),
}))

vi.mock("@/server/db/client", () => dbMocks)

import {
    buildPublicArticleHref,
    listPublicArticles,
    readPublicSourceArticle,
    readPublicWikiPage,
    retrievePublicTreeNodes,
    type PublicArticleScope,
} from "./public-qa-logic"

const emptyScope: PublicArticleScope = new Map()

async function expectStatus(promise: Promise<unknown>, status: number) {
    try {
        await promise
        throw new Error("预期抛出错误，但未抛出")
    } catch (error) {
        expect((error as { status?: number }).status).toBe(status)
    }
}

describe("公开问答检索守卫", () => {
    beforeEach(() => {
        dbMocks.getDb.mockImplementation(() => {
            throw new Error("getDb 不应在守卫校验阶段被调用")
        })
    })

    it("buildPublicArticleHref 生成公开页路径", () => {
        expect(buildPublicArticleHref("abc123")).toBe("/p/abc123")
    })

    it("list_public_articles 空库时返回 total=0", async () => {
        const selectChain = {
            from: vi.fn().mockReturnThis(),
            innerJoin: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockResolvedValue([]),
        }
        dbMocks.getDb.mockReturnValue({ select: vi.fn(() => selectChain) })
        await expect(listPublicArticles()).resolves.toEqual({ total: 0, items: [] })
    })

    it("list_public_articles 应用层再滤掉带密码/已过期分享", async () => {
        const now = new Date("2026-07-11T12:00:00.000Z")
        const selectChain = {
            from: vi.fn().mockReturnThis(),
            innerJoin: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockResolvedValue([
                {
                    articleId: 1,
                    title: "公开文",
                    updatedAt: now,
                    publicExcerpt: "摘要",
                    aiSummary: null,
                    shareCode: "pub1",
                    enabled: true,
                    revokedAt: null,
                    expiresAt: null,
                    passwordHash: null,
                    pinOrder: null,
                },
                {
                    articleId: 2,
                    title: "密码文",
                    updatedAt: now,
                    publicExcerpt: "密",
                    aiSummary: null,
                    shareCode: "pwd1",
                    enabled: true,
                    revokedAt: null,
                    expiresAt: null,
                    passwordHash: "hash",
                    pinOrder: null,
                },
                {
                    articleId: 3,
                    title: "过期文",
                    updatedAt: now,
                    publicExcerpt: "旧",
                    aiSummary: null,
                    shareCode: "exp1",
                    enabled: true,
                    revokedAt: null,
                    expiresAt: new Date("2026-07-01T00:00:00.000Z"),
                    passwordHash: null,
                    pinOrder: null,
                },
            ]),
        }
        dbMocks.getDb.mockReturnValue({ select: vi.fn(() => selectChain) })
        await expect(listPublicArticles({}, now)).resolves.toEqual({
            total: 1,
            items: [expect.objectContaining({
                articleId: "1",
                shareCode: "pub1",
                href: "/p/pub1",
                title: "公开文",
            })],
        })
    })

    it("read_wiki_page 拒绝非 source-<id> 的 pageKey（400）", async () => {
        await expectStatus(readPublicWikiPage(emptyScope, "topic-overview"), 400)
    })

    it("read_wiki_page 对不在公开范围内的文章返回 404", async () => {
        await expectStatus(readPublicWikiPage(emptyScope, "source-9"), 404)
    })

    it("read_source_article 对不在公开范围内的文章返回 404", async () => {
        await expectStatus(readPublicSourceArticle(emptyScope, 9), 404)
    })

    it("search_document_tree 对不在公开范围内的文章返回 404", async () => {
        await expectStatus(
            retrievePublicTreeNodes({ scope: emptyScope, articleId: 9, query: "x" }),
            404,
        )
    })
})
