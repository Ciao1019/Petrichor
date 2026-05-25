import { describe, expect, it } from "vitest"

import type { PublicArticleListItem } from "@/lib/api"
import { buildAtomFeedXml, buildRssFeedXml, escapeXml } from "@/server/public-site/feed"
import { getPublicBaseUrl, toAbsolutePublicUrl } from "@/server/public-site/site-url"

function article(overrides: Partial<PublicArticleListItem>): PublicArticleListItem {
    return {
        articleId: "1",
        shareCode: "share-1",
        title: "文章",
        excerpt: "摘要",
        updatedAt: "2026-05-01T00:00:00.000Z",
        readingMinutes: 3,
        tags: ["AI"],
        href: "/p/share-1",
        expired: false,
        expiresAt: null,
        hasPassword: false,
        isRepost: false,
        ...overrides,
    }
}

describe("public site feed utilities", () => {
    it("转义 XML 特殊字符", () => {
        expect(escapeXml(`A&B <tag> "quote" 'single'`)).toBe("A&amp;B &lt;tag&gt; &quot;quote&quot; &apos;single&apos;")
    })

    it("生成 Atom 和 RSS 条目链接", () => {
        const articles = [
            article({
                title: "AI & 知识库",
                excerpt: "摘要 <重要>",
                href: "/p/share-1",
            }),
        ]

        const atom = buildAtomFeedXml(articles, "https://example.com")
        const rss = buildRssFeedXml(articles, "https://example.com")

        expect(atom).toContain('<link rel="self" href="https://example.com/atom.xml" />')
        expect(atom).toContain("<title>AI &amp; 知识库</title>")
        expect(rss).toContain("<link>https://example.com/p/share-1</link>")
        expect(rss).toContain("<description>摘要 &lt;重要&gt;</description>")
    })

    it("解析公开站基础 URL 并生成绝对地址", () => {
        expect(getPublicBaseUrl({ NEXT_PUBLIC_APP_URL: "https://petrichor.example/path" })).toBe("https://petrichor.example")
        expect(getPublicBaseUrl({ VERCEL_URL: "petrichor.vercel.app" })).toBe("https://petrichor.vercel.app")
        expect(toAbsolutePublicUrl("/tags", "https://petrichor.example")).toBe("https://petrichor.example/tags")
    })
})
