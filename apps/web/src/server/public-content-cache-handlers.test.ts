import type { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const authMocks = vi.hoisted(() => ({
    requireCurrentUser: vi.fn(),
}))

const dbMocks = vi.hoisted(() => ({
    getDb: vi.fn(),
}))

const cacheMocks = vi.hoisted(() => ({
    cachePublicArticleDetail: vi.fn((_shareCode: string, loader: () => Promise<unknown>) => loader),
    cachePublicContent: vi.fn((_key: string, loader: () => Promise<unknown>) => loader),
    invalidatePublicAboutProfileCache: vi.fn(),
    invalidatePublicArticleDetailCache: vi.fn(),
    invalidatePublicArticleListCache: vi.fn(),
}))

const aiMocks = vi.hoisted(() => ({
    callChatCompletion: vi.fn(),
}))

vi.mock("@/server/auth/current-user", () => authMocks)
vi.mock("@/server/db/client", () => dbMocks)
vi.mock("@/server/public-content-cache", () => cacheMocks)
vi.mock("@/server/ai/generation", () => aiMocks)

import { adminAboutProfileUpdate } from "@/server/about/handlers"
import { deleteArticle, deleteFolder, deleteKnowledgeBase, refreshArticlePublicCache, updateArticle } from "@/server/kb/handlers"
import { generateArticleMindmap } from "@/server/kb/mindmap-handlers"
import {
    articleShareInfo,
    createArticleShare,
    publicArticleList,
    publicShareDetailGet,
    revokeArticleShare,
} from "@/server/kb/share-handlers"

type QueryChain = {
    from: ReturnType<typeof vi.fn>
    innerJoin: ReturnType<typeof vi.fn>
    limit: ReturnType<typeof vi.fn>
    onConflictDoUpdate: ReturnType<typeof vi.fn>
    orderBy: ReturnType<typeof vi.fn>
    returning: ReturnType<typeof vi.fn>
    set: ReturnType<typeof vi.fn>
    values: ReturnType<typeof vi.fn>
    where: ReturnType<typeof vi.fn>
    then: Promise<unknown>["then"]
}

function createQueryChain(result: unknown): QueryChain {
    const chain = {} as QueryChain
    chain.from = vi.fn(() => chain)
    chain.innerJoin = vi.fn(() => chain)
    chain.limit = vi.fn(async () => result)
    chain.onConflictDoUpdate = vi.fn(() => chain)
    chain.orderBy = vi.fn(() => chain)
    chain.returning = vi.fn(async () => result)
    chain.set = vi.fn(() => chain)
    chain.values = vi.fn(() => chain)
    chain.where = vi.fn(() => chain)
    chain.then = (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected)
    return chain
}

function createDbMock({
    deleteResults = [],
    insertResults = [],
    selectResults = [],
    updateResults = [],
}: {
    deleteResults?: unknown[]
    insertResults?: unknown[]
    selectResults?: unknown[]
    updateResults?: unknown[]
}) {
    let deleteIndex = 0
    let insertIndex = 0
    let selectIndex = 0
    let updateIndex = 0

    return {
        delete: vi.fn(() => createQueryChain(deleteResults[deleteIndex++] ?? [])),
        insert: vi.fn(() => createQueryChain(insertResults[insertIndex++] ?? [])),
        select: vi.fn(() => createQueryChain(selectResults[selectIndex++] ?? [])),
        update: vi.fn(() => createQueryChain(updateResults[updateIndex++] ?? [])),
    }
}

function createJsonRequest(body: unknown, pathname = "/test") {
    return {
        json: vi.fn(async () => body),
        nextUrl: { pathname },
    } as unknown as NextRequest
}

function createGetRequest(url: string) {
    const nextUrl = new URL(url)
    return {
        nextUrl,
    } as unknown as NextRequest
}

function createArticleAccessRow() {
    return {
        article: {
            id: 9,
            knowledgeBaseId: 3,
            nodeId: 5,
            userId: 1,
        },
        kb: {
            id: 3,
            name: "知识库",
            userId: 1,
        },
        node: {
            id: 5,
            knowledgeBaseId: 3,
        },
        owner: {
            email: "owner@example.com",
            id: 1,
            nickname: null,
            username: "owner",
        },
    }
}

function createArticleRecord() {
    return {
        id: 9,
        knowledgeBaseId: 3,
        nodeId: 5,
        userId: 1,
    }
}

describe("public content cache invalidation points", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        authMocks.requireCurrentUser.mockResolvedValue({ id: 1 })
        aiMocks.callChatCompletion.mockResolvedValue({
            answer: JSON.stringify({
                nodeData: {
                    root: true,
                    topic: "新标题",
                },
            }),
        })
    })

    it("后台保存关于我配置成功后失效关于我公开缓存", async () => {
        const profile = {
            createdAt: new Date("2026-04-28T00:00:00.000Z"),
            displayName: "CiZai",
            expertiseJson: "[\"AI\"]",
            id: 1,
            intro: "新的介绍",
            quote: "Code",
            roleTitle: "Developer",
            toolkitJson: "[\"TypeScript\"]",
            updatedAt: new Date("2026-04-28T01:00:00.000Z"),
        }
        const db = createDbMock({
            insertResults: [[profile]],
            selectResults: [[{ id: 1, systemRole: "SUPER_ADMIN" }]],
        })
        dbMocks.getDb.mockReturnValue(db)

        const response = await adminAboutProfileUpdate(createJsonRequest({
            displayName: "CiZai",
            expertise: ["AI"],
            intro: "新的介绍",
            quote: "Code",
            roleTitle: "Developer",
            toolkit: ["TypeScript"],
        }))

        await expect(response.json()).resolves.toMatchObject({ displayName: "CiZai" })
        expect(cacheMocks.invalidatePublicAboutProfileCache).toHaveBeenCalledTimes(1)
        expect(cacheMocks.invalidatePublicArticleListCache).not.toHaveBeenCalled()
        expect(cacheMocks.invalidatePublicArticleDetailCache).not.toHaveBeenCalled()
    })

    it("创建公开分享成功后失效公开文章列表缓存", async () => {
        const db = createDbMock({
            insertResults: [[{
                articleId: 9,
                enabled: true,
                expiresAt: null,
                id: 11,
                isRepost: false,
                passwordHash: null,
                shareCode: "shareCode123",
                updatedAt: new Date("2026-04-28T01:00:00.000Z"),
            }]],
            selectResults: [[createArticleAccessRow()], []],
        })
        dbMocks.getDb.mockReturnValue(db)

        const response = await createArticleShare(createJsonRequest({
            articleId: "9",
            passwordEnabled: false,
        }))

        await expect(response.json()).resolves.toMatchObject({ articleId: "9", shareCode: "shareCode123" })
        expect(cacheMocks.invalidatePublicArticleListCache).toHaveBeenCalledTimes(1)
        expect(cacheMocks.invalidatePublicArticleDetailCache).toHaveBeenCalledWith("shareCode123")
    })

    it("创建公开分享时保存并返回转载来源", async () => {
        const db = createDbMock({
            insertResults: [[{
                articleId: 9,
                enabled: true,
                expiresAt: null,
                id: 11,
                isRepost: true,
                originalAuthorName: "原作者",
                originalUrl: "https://example.com/article",
                passwordHash: null,
                shareCode: "shareCode123",
                updatedAt: new Date("2026-04-28T01:00:00.000Z"),
            }]],
            selectResults: [[createArticleAccessRow()], []],
        })
        dbMocks.getDb.mockReturnValue(db)

        const response = await createArticleShare(createJsonRequest({
            articleId: "9",
            isRepost: true,
            originalAuthorName: " 原作者 ",
            originalUrl: " https://example.com/article ",
            passwordEnabled: false,
        }))

        await expect(response.json()).resolves.toMatchObject({
            articleId: "9",
            isRepost: true,
            originalAuthorName: "原作者",
            originalUrl: "https://example.com/article",
            shareCode: "shareCode123",
        })
        const insertChain = db.insert.mock.results[0]?.value as QueryChain
        expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({
            isRepost: true,
            originalAuthorName: "原作者",
            originalUrl: "https://example.com/article",
        }))
    })

    it("公开分享信息返回转载来源以支持弹窗回显", async () => {
        const db = createDbMock({
            selectResults: [
                [createArticleAccessRow()],
                [{
                    articleId: 9,
                    enabled: true,
                    expiresAt: null,
                    id: 11,
                    isRepost: true,
                    originalAuthorName: "原作者",
                    originalUrl: "https://example.com/article",
                    passwordHash: null,
                    shareCode: "shareCode123",
                    updatedAt: new Date("2026-04-28T01:00:00.000Z"),
                }],
            ],
        })
        dbMocks.getDb.mockReturnValue(db)

        const response = await articleShareInfo(createJsonRequest({ articleId: "9" }))

        await expect(response.json()).resolves.toMatchObject({
            articleId: "9",
            enabled: true,
            isRepost: true,
            originalAuthorName: "原作者",
            originalUrl: "https://example.com/article",
            shareCode: "shareCode123",
        })
    })

    it("创建公开分享拒绝非法转载来源链接", async () => {
        const response = await createArticleShare(createJsonRequest({
            articleId: "9",
            isRepost: true,
            originalAuthorName: "原作者",
            originalUrl: "ftp://example.com/article",
            passwordEnabled: false,
        }))

        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toMatchObject({
            msg: "原文链接必须是有效的 http:// 或 https:// 地址",
        })
    })

    it("公开文章列表响应使用预计算字段并设置公共缓存头", async () => {
        const db = createDbMock({
            selectResults: [
                [{
                    articleId: 9,
                    enabled: true,
                    expiresAt: null,
                    isRepost: true,
                    originalAuthorName: "原作者",
                    originalUrl: "https://example.com/article",
                    passwordHash: null,
                    publicExcerpt: "预计算摘要",
                    readingMinutes: 3,
                    revokedAt: null,
                    shareCode: "shareCode123",
                    shareId: 11,
                    title: "公开文章",
                    updatedAt: new Date("2026-04-28T01:00:00.000Z"),
                }],
                [{ articleId: 9, tag: "AI" }],
            ],
        })
        dbMocks.getDb.mockReturnValue(db)

        const response = await publicArticleList(createGetRequest("https://petrichor.test/api/public/article/list"))

        expect(response.headers.get("Cache-Control")).toContain("s-maxage=60")
        await expect(response.json()).resolves.toMatchObject({
            items: [{
                articleId: "9",
                excerpt: "预计算摘要",
                hasPassword: false,
                isRepost: true,
                readingMinutes: 3,
                shareCode: "shareCode123",
                tags: ["AI"],
                title: "公开文章",
            }],
        })
    })

    it("公开文章列表在 AI 总结过期时仍优先展示旧总结", async () => {
        const db = createDbMock({
            selectResults: [
                [{
                    aiSummary: "旧 AI 总结",
                    aiSummaryContentHash: "old-hash",
                    articleId: 9,
                    enabled: true,
                    expiresAt: null,
                    isRepost: false,
                    originalAuthorName: null,
                    originalUrl: null,
                    passwordHash: null,
                    publicContentHash: "current-hash",
                    publicExcerpt: "预计算摘要",
                    readingMinutes: 3,
                    revokedAt: null,
                    shareCode: "shareCode123",
                    title: "公开文章",
                    updatedAt: new Date("2026-04-28T01:00:00.000Z"),
                }],
                [{ articleId: 9, tag: "AI" }],
            ],
        })
        dbMocks.getDb.mockReturnValue(db)

        const response = await publicArticleList(createGetRequest("https://petrichor.test/api/public/article/list"))

        await expect(response.json()).resolves.toMatchObject({
            items: [{
                articleId: "9",
                excerpt: "旧 AI 总结",
                shareCode: "shareCode123",
                title: "公开文章",
            }],
        })
    })

    it("无密码公开详情 GET 返回正文、服务端 TOC 和公共缓存头", async () => {
        const db = createDbMock({
            selectResults: [
                [{
                    articleId: 9,
                    enabled: true,
                    expiresAt: null,
                    id: 11,
                    isRepost: true,
                    originalAuthorName: "原作者",
                    originalUrl: "https://example.com/article",
                    passwordHash: null,
                    shareCode: "shareCode123",
                }],
                [{
                    aiSummary: "旧 AI 总结",
                    aiSummaryContentHash: "old-hash",
                    aiSummaryGeneratedAt: new Date("2026-04-27T01:00:00.000Z"),
                    contentJson: null,
                    contentMd: "## 章节\n\n内容",
                    contentMetaJson: null,
                    createdAt: new Date("2026-04-28T00:00:00.000Z"),
                    id: 9,
                    mindmapGeneratedAt: null,
                    mindmapJson: null,
                    mindmapKgGeneratedAt: null,
                    mindmapKgJson: null,
                    publicContentHash: null,
                    title: "公开文章",
                    tocJson: null,
                    updatedAt: new Date("2026-04-28T01:00:00.000Z"),
                }],
                [{ tag: "AI" }],
            ],
        })
        dbMocks.getDb.mockReturnValue(db)

        const response = await publicShareDetailGet(createGetRequest("https://petrichor.test/api/public/article/share/detail?shareCode=shareCode123"))

        expect(response.headers.get("Cache-Control")).toContain("s-maxage=300")
        await expect(response.json()).resolves.toMatchObject({
            contentMd: "## 章节\n\n内容",
            aiSummary: "旧 AI 总结",
            aiSummaryGeneratedAt: "2026-04-27T01:00:00.000Z",
            aiSummaryStale: true,
            isRepost: true,
            originalAuthorName: "原作者",
            originalUrl: "https://example.com/article",
            tags: ["AI"],
            title: "公开文章",
            tocJson: [{ id: "章节", level: 2, text: "章节" }],
        })
        expect(cacheMocks.cachePublicArticleDetail).toHaveBeenCalledWith("shareCode123", expect.any(Function))
    })

    it("有密码公开详情 GET 不返回正文", async () => {
        const db = createDbMock({
            selectResults: [
                [{
                    articleId: 9,
                    enabled: true,
                    expiresAt: null,
                    id: 11,
                    passwordHash: "hashed-password",
                    shareCode: "shareCode123",
                }],
            ],
        })
        dbMocks.getDb.mockReturnValue(db)

        const response = await publicShareDetailGet(createGetRequest("https://petrichor.test/api/public/article/share/detail?shareCode=shareCode123"))

        expect(response.status).toBe(403)
        await expect(response.json()).resolves.not.toHaveProperty("contentMd")
    })

    it("撤销公开分享成功后失效公开文章列表缓存", async () => {
        const db = createDbMock({
            selectResults: [[createArticleAccessRow()], [{
                articleId: 9,
                enabled: true,
                expiresAt: null,
                id: 11,
                passwordHash: null,
                revokedAt: null,
                shareCode: "shareCode123",
                updatedAt: new Date("2026-04-28T01:00:00.000Z"),
            }]],
        })
        dbMocks.getDb.mockReturnValue(db)

        const response = await revokeArticleShare(createJsonRequest({ articleId: "9" }))

        await expect(response.json()).resolves.toMatchObject({ articleId: "9", enabled: false })
        expect(cacheMocks.invalidatePublicArticleListCache).toHaveBeenCalledTimes(1)
        expect(cacheMocks.invalidatePublicArticleDetailCache).toHaveBeenCalledWith("shareCode123")
    })

    it("更新文章内容和标签成功后失效公开文章列表缓存", async () => {
        const db = createDbMock({
            selectResults: [[createArticleRecord()]],
        })
        dbMocks.getDb.mockReturnValue(db)

        const response = await updateArticle(createJsonRequest({
            articleId: "9",
            contentJson: null,
            contentMd: "# 新内容",
            contentMetaJson: null,
            tags: ["AI", "Next.js"],
            title: "新标题",
        }))

        await expect(response.json()).resolves.toMatchObject({ articleId: "9", nodeId: "5" })
        expect(cacheMocks.invalidatePublicArticleListCache).toHaveBeenCalledTimes(1)
        expect(cacheMocks.invalidatePublicArticleDetailCache).toHaveBeenCalledTimes(1)
    })

    it("手动刷新公开文章缓存时失效公开文章列表和详情缓存", async () => {
        const db = createDbMock({
            selectResults: [[createArticleRecord()]],
        })
        dbMocks.getDb.mockReturnValue(db)

        const response = await refreshArticlePublicCache(createJsonRequest({ articleId: "9" }))

        await expect(response.json()).resolves.toMatchObject({ articleId: "9" })
        expect(cacheMocks.invalidatePublicArticleListCache).toHaveBeenCalledTimes(1)
        expect(cacheMocks.invalidatePublicArticleDetailCache).toHaveBeenCalledTimes(1)
    })

    it("删除文章成功后失效公开文章列表缓存", async () => {
        const db = createDbMock({
            selectResults: [[createArticleRecord()]],
        })
        dbMocks.getDb.mockReturnValue(db)

        const response = await deleteArticle(createJsonRequest({ articleId: "9" }))

        await expect(response.json()).resolves.toMatchObject({ articleId: "9", nodeId: "5" })
        expect(cacheMocks.invalidatePublicArticleListCache).toHaveBeenCalledTimes(1)
        expect(cacheMocks.invalidatePublicArticleDetailCache).toHaveBeenCalledTimes(1)
    })

    it("删除包含文章的文件夹成功后失效公开文章列表缓存", async () => {
        const db = createDbMock({
            selectResults: [
                [{
                    id: 5,
                    knowledgeBaseId: 3,
                    parentId: null,
                    type: "FOLDER",
                    userId: 1,
                }],
                [
                    { id: 5, parentId: null, type: "FOLDER" },
                    { id: 6, parentId: 5, type: "ARTICLE" },
                ],
                [{ id: 9 }],
            ],
        })
        dbMocks.getDb.mockReturnValue(db)

        const response = await deleteFolder(createJsonRequest({ nodeId: "5" }))

        await expect(response.json()).resolves.toMatchObject({ nodeId: "5" })
        expect(cacheMocks.invalidatePublicArticleListCache).toHaveBeenCalledTimes(1)
        expect(cacheMocks.invalidatePublicArticleDetailCache).toHaveBeenCalledTimes(1)
    })

    it("删除知识库成功后失效公开文章列表缓存", async () => {
        const db = createDbMock({
            selectResults: [[{ id: 3, userId: 1 }]],
        })
        dbMocks.getDb.mockReturnValue(db)

        const response = await deleteKnowledgeBase(createJsonRequest({ knowledgeBaseId: "3" }))

        await expect(response.json()).resolves.toMatchObject({ knowledgeBaseId: "3" })
        expect(cacheMocks.invalidatePublicArticleListCache).toHaveBeenCalledTimes(1)
        expect(cacheMocks.invalidatePublicArticleDetailCache).toHaveBeenCalledTimes(1)
    })

    it("生成文章思维导图成功更新文章元数据后失效公开文章列表缓存", async () => {
        const db = createDbMock({
            selectResults: [
                [{
                    contentMd: "# 新内容",
                    id: 9,
                    knowledgeBaseId: 3,
                    mindmapContentHash: null,
                    mindmapGeneratedAt: null,
                    mindmapJson: null,
                    mindmapKgContentHash: null,
                    mindmapKgGeneratedAt: null,
                    mindmapKgJson: null,
                    nodeId: 5,
                    title: "新标题",
                    updatedAt: new Date("2026-04-28T01:00:00.000Z"),
                    userId: 1,
                }],
                [{ id: 3, name: "知识库" }],
            ],
        })
        dbMocks.getDb.mockReturnValue(db)

        const response = await generateArticleMindmap(createJsonRequest({
            articleId: "9",
            forceRebuild: true,
            mode: "MINDMAP",
        }))

        await expect(response.json()).resolves.toMatchObject({ articleId: "9", fromCache: false })
        expect(cacheMocks.invalidatePublicArticleListCache).toHaveBeenCalledTimes(1)
        expect(cacheMocks.invalidatePublicArticleDetailCache).toHaveBeenCalledTimes(1)
    })

    it("非文章所有者不能通过后台授权生成文章思维导图", async () => {
        const db = createDbMock({
            selectResults: [[{
                contentMd: "# 新内容",
                id: 9,
                knowledgeBaseId: 3,
                mindmapContentHash: null,
                mindmapGeneratedAt: null,
                mindmapJson: null,
                mindmapKgContentHash: null,
                mindmapKgGeneratedAt: null,
                mindmapKgJson: null,
                nodeId: 5,
                title: "新标题",
                updatedAt: new Date("2026-04-28T01:00:00.000Z"),
                userId: 2,
            }]],
        })
        dbMocks.getDb.mockReturnValue(db)

        const response = await generateArticleMindmap(createJsonRequest({
            articleId: "9",
            forceRebuild: true,
            mode: "MINDMAP",
        }))

        expect(response.status).toBe(404)
        await expect(response.json()).resolves.toMatchObject({ msg: "文章不存在" })
        expect(db.select).toHaveBeenCalledTimes(1)
        expect(db.update).not.toHaveBeenCalled()
        expect(aiMocks.callChatCompletion).not.toHaveBeenCalled()
        expect(cacheMocks.invalidatePublicArticleListCache).not.toHaveBeenCalled()
        expect(cacheMocks.invalidatePublicArticleDetailCache).not.toHaveBeenCalled()
    })
})
