import { describe, expect, it } from "vitest"
import {
    buildHomepageArticleExcerpt,
    buildPublicArticleContentHash,
    buildPublicArticleMetadata,
    estimateReadingMinutes,
    buildArticlePath,
    parseShareExpiresAt,
    buildPublicShareRepostAttribution,
    resolvePublicArticleToc,
    resolvePublicHomepageShareStatus,
    validateArticleSearchInput,
    validatePublicShareDetailInput,
    validatePublicShareRepostAttributionInput,
    validateShareArticleIdInput,
    validateSharePassword,
} from "./share-logic"

describe("kb share/search logic", () => {
    it("校验文章搜索请求和标签限制", () => {
        expect(validateArticleSearchInput({
            knowledgeBaseId: " 1 ",
            keyword: " 文档 ",
            tags: [" a ", "", "a", "b"],
        })).toEqual({
            knowledgeBaseId: 1,
            keyword: "文档",
            tags: ["a", "b"],
        })

        expect(() => validateArticleSearchInput({ knowledgeBaseId: "x" })).toThrow("知识库ID非法")
        expect(() => validateArticleSearchInput({ knowledgeBaseId: "1", tags: Array.from({ length: 21 }, (_, index) => `t${index}`) })).toThrow("标签数量不能超过 20")
    })

    it("校验分享文章 ID、分享码和访问密码", () => {
        expect(validateShareArticleIdInput({ articleId: " 9 " })).toEqual({ articleId: 9 })
        expect(() => validateShareArticleIdInput({ articleId: "" })).toThrow("文章ID不能为空")
        expect(() => validateShareArticleIdInput({ articleId: "abc" })).toThrow("文章ID非法")

        expect(validatePublicShareDetailInput({ shareCode: "abcDEF_12345", accessPassword: "123456" })).toEqual({
            accessPassword: "123456",
            shareCode: "abcDEF_12345",
        })
        expect(() => validatePublicShareDetailInput({ shareCode: "bad!" })).toThrow("分享码非法")
        expect(() => validateSharePassword("12345")).toThrow("访问密码格式非法")
    })

    it("解析分享过期时间", () => {
        const now = new Date("2026-04-27T00:00:00.000Z")
        expect(parseShareExpiresAt(undefined, now)).toBeNull()
        expect(parseShareExpiresAt("2026-04-28T00:00:00", now)?.getFullYear()).toBe(2026)
        expect(() => parseShareExpiresAt("bad", now)).toThrow("到期时间格式非法")
        expect(() => parseShareExpiresAt("2026-04-26T00:00:00", now)).toThrow("到期时间必须晚于当前时间")
    })

    it("校验公开分享转载来源字段", () => {
        expect(validatePublicShareRepostAttributionInput({
            isRepost: false,
            originalUrl: "https://example.com/old",
            originalAuthorName: "旧作者",
        })).toEqual({
            isRepost: false,
            originalUrl: null,
            originalAuthorName: null,
        })

        expect(validatePublicShareRepostAttributionInput({
            isRepost: true,
            originalUrl: " https://example.com/article ",
            originalAuthorName: " 原作者 ",
        })).toEqual({
            isRepost: true,
            originalUrl: "https://example.com/article",
            originalAuthorName: "原作者",
        })

        expect(() => validatePublicShareRepostAttributionInput({ isRepost: true, originalUrl: "", originalAuthorName: "作者" }))
            .toThrow("请填写原文链接")
        expect(() => validatePublicShareRepostAttributionInput({ isRepost: true, originalUrl: "ftp://example.com", originalAuthorName: "作者" }))
            .toThrow("原文链接必须是有效的 http:// 或 https:// 地址")
        expect(() => validatePublicShareRepostAttributionInput({ isRepost: true, originalUrl: "https://example.com", originalAuthorName: "" }))
            .toThrow("请填写原作者名称")

        expect(buildPublicShareRepostAttribution({
            isRepost: true,
            originalUrl: " https://example.com/article ",
            originalAuthorName: " 原作者 ",
        })).toEqual({
            isRepost: true,
            originalUrl: "https://example.com/article",
            originalAuthorName: "原作者",
        })
        expect(buildPublicShareRepostAttribution({ isRepost: true, originalUrl: "", originalAuthorName: "作者" }))
            .toEqual({
                isRepost: false,
                originalUrl: null,
                originalAuthorName: null,
            })
    })

    it("生成 Go 兼容的文章路径", () => {
        const path = buildArticlePath(new Map([
            [1, { id: 1, name: "根", parentId: null }],
            [2, { id: 2, name: "子", parentId: 1 }],
            [3, { id: 3, name: "文档", parentId: 2 }],
        ]), 3)

        expect(path).toBe("/根/子/文档")
    })

    it("从 Markdown 正文生成稳定摘要和阅读时间", () => {
        expect(buildHomepageArticleExcerpt("# 标题\n\n这是一段 [链接](https://example.com) 内容。\n\n```ts\nconst x = 1\n```", 10))
            .toBe("标题 这是一段 链接...")
        expect(buildHomepageArticleExcerpt("")).toBe("暂无摘要")
        expect(estimateReadingMinutes("短文")).toBe(1)
        expect(estimateReadingMinutes("字".repeat(421))).toBe(2)
    })

    it("预计算公开文章摘要、阅读时间、目录和内容哈希", () => {
        const markdown = "# 标题\n\n## 第一节\n\n内容"
        const metadata = buildPublicArticleMetadata(markdown)

        expect(metadata.publicExcerpt).toBe("标题 第一节 内容")
        expect(metadata.readingMinutes).toBe(1)
        expect(JSON.parse(metadata.tocJson)).toEqual([
            { id: "标题", level: 1, text: "标题" },
            { id: "第一节", level: 2, text: "第一节" },
        ])
        expect(metadata.publicContentHash).toBe(buildPublicArticleContentHash(markdown))
    })

    it("公开详情目录优先使用匹配哈希的服务端 TOC，旧数据回退为现场计算", () => {
        const markdown = "## 服务端目录\n\n正文"
        const hash = buildPublicArticleContentHash(markdown)

        expect(resolvePublicArticleToc(markdown, JSON.stringify([
            { id: "cached", level: 2, text: "缓存目录" },
        ]), hash)).toEqual([
            { id: "cached", level: 2, text: "缓存目录" },
        ])

        expect(resolvePublicArticleToc(markdown, null, hash)).toEqual([
            { id: "服务端目录", level: 2, text: "服务端目录" },
        ])
        expect(resolvePublicArticleToc(markdown, "[]", "old-hash")).toEqual([
            { id: "服务端目录", level: 2, text: "服务端目录" },
        ])
    })

    it("判断公开分享首页列表状态", () => {
        const now = new Date("2026-04-27T00:00:00.000Z")

        expect(resolvePublicHomepageShareStatus({
            enabled: true,
            expiresAt: null,
            passwordHash: null,
            revokedAt: null,
        }, now)).toEqual({
            listed: true,
            expired: false,
            hasPassword: false,
        })

        expect(resolvePublicHomepageShareStatus({
            enabled: true,
            expiresAt: "2026-04-26T23:59:59.000Z",
            passwordHash: "hashed-password",
            revokedAt: null,
        }, now)).toEqual({
            listed: true,
            expired: true,
            hasPassword: true,
        })

        expect(resolvePublicHomepageShareStatus({
            enabled: false,
            expiresAt: null,
            passwordHash: "   ",
            revokedAt: null,
        }, now)).toEqual({
            listed: false,
            expired: false,
            hasPassword: false,
        })

        expect(resolvePublicHomepageShareStatus({
            enabled: true,
            expiresAt: "2026-04-28T00:00:00.000Z",
            revokedAt: "2026-04-26T00:00:00.000Z",
        }, now)).toEqual({
            listed: false,
            expired: false,
            hasPassword: false,
        })
    })
})
