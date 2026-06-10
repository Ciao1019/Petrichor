import { describe, expect, it, vi } from "vitest"

const dbMocks = vi.hoisted(() => ({
    getDb: vi.fn(() => {
        throw new Error("getDb 不应在守卫校验阶段被调用")
    }),
}))

vi.mock("@/server/db/client", () => dbMocks)

import {
    buildPublicArticleHref,
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
    it("buildPublicArticleHref 生成公开页路径", () => {
        expect(buildPublicArticleHref("abc123")).toBe("/p/abc123")
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
