import { describe, expect, it } from "vitest"

import type { PublicArticleListItem } from "@/lib/api"
import { buildPublicTagGroups, resolveSelectedPublicTagGroup } from "./tags-page-utils"

function article(overrides: Partial<PublicArticleListItem>): PublicArticleListItem {
    return {
        articleId: "1",
        shareCode: "share-1",
        title: "文章",
        excerpt: "摘要",
        updatedAt: "2026-04-01T00:00:00.000Z",
        readingMinutes: 3,
        tags: [],
        href: "/p/share-1",
        expired: false,
        expiresAt: null,
        hasPassword: false,
        isRepost: false,
        ...overrides,
    }
}

describe("tags page utilities", () => {
    it("按真实公开文章标签聚合并排序", () => {
        const groups = buildPublicTagGroups([
            article({
                articleId: "1",
                shareCode: "share-1",
                title: "AI 工作流",
                updatedAt: "2026-04-02T00:00:00.000Z",
                tags: [" AI ", "前端", "AI"],
            }),
            article({
                articleId: "2",
                shareCode: "share-2",
                title: "前端导航",
                updatedAt: "2026-04-03T00:00:00.000Z",
                tags: ["前端"],
            }),
            article({
                articleId: "3",
                shareCode: "share-3",
                title: "未打标签文章",
                updatedAt: "2026-04-04T00:00:00.000Z",
                tags: [],
            }),
        ])

        expect(groups.map((group) => ({
            name: group.name,
            articleCount: group.articleCount,
            titles: group.articles.map((item) => item.title),
        }))).toEqual([
            {
                name: "前端",
                articleCount: 2,
                titles: ["前端导航", "AI 工作流"],
            },
            {
                name: "AI",
                articleCount: 1,
                titles: ["AI 工作流"],
            },
        ])
    })

    it("选中标签不存在时回退到第一个标签", () => {
        const groups = buildPublicTagGroups([
            article({ tags: ["知识库"] }),
        ])

        expect(resolveSelectedPublicTagGroup(groups, "missing")?.name).toBe("知识库")
        expect(resolveSelectedPublicTagGroup([], "missing")).toBeNull()
    })
})
