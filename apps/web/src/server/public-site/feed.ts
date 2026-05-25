import type { PublicArticleListItem } from "@/lib/api"
import { toAbsolutePublicUrl } from "@/server/public-site/site-url"

const feedTitle = "Petrichor"
const feedDescription = "Petrichor 公开文章、知识与灵感更新。"

export function escapeXml(value: string) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;")
}

function formatIsoDate(value: string | Date) {
    const date = value instanceof Date ? value : new Date(value)
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString()
}

function formatRssDate(value: string | Date) {
    const date = value instanceof Date ? value : new Date(value)
    return Number.isNaN(date.getTime()) ? new Date(0).toUTCString() : date.toUTCString()
}

function latestUpdatedAt(articles: readonly PublicArticleListItem[]) {
    const latest = articles
        .map((article) => new Date(article.updatedAt).getTime())
        .filter((time) => Number.isFinite(time))
        .sort((left, right) => right - left)[0]
    return latest ? new Date(latest) : new Date()
}

function renderAtomCategories(article: PublicArticleListItem) {
    return article.tags
        .map((tag) => tag.trim())
        .filter(Boolean)
        .map((tag) => `    <category term="${escapeXml(tag)}" />`)
        .join("\n")
}

function renderRssCategories(article: PublicArticleListItem) {
    return article.tags
        .map((tag) => tag.trim())
        .filter(Boolean)
        .map((tag) => `      <category>${escapeXml(tag)}</category>`)
        .join("\n")
}

export function buildAtomFeedXml(articles: readonly PublicArticleListItem[], baseUrl: string) {
    const siteUrl = toAbsolutePublicUrl("/", baseUrl)
    const selfUrl = toAbsolutePublicUrl("/atom.xml", baseUrl)
    const updatedAt = formatIsoDate(latestUpdatedAt(articles))
    const entries = articles.map((article) => {
        const href = toAbsolutePublicUrl(article.href, baseUrl)
        const categories = renderAtomCategories(article)
        return [
            "  <entry>",
            `    <title>${escapeXml(article.title)}</title>`,
            `    <link href="${escapeXml(href)}" />`,
            `    <id>${escapeXml(href)}</id>`,
            `    <updated>${formatIsoDate(article.updatedAt)}</updated>`,
            `    <summary>${escapeXml(article.excerpt)}</summary>`,
            categories,
            "  </entry>",
        ].filter(Boolean).join("\n")
    }).join("\n")

    return [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<feed xmlns="http://www.w3.org/2005/Atom">',
        `  <title>${escapeXml(feedTitle)}</title>`,
        `  <subtitle>${escapeXml(feedDescription)}</subtitle>`,
        `  <link href="${escapeXml(siteUrl)}" />`,
        `  <link rel="self" href="${escapeXml(selfUrl)}" />`,
        `  <id>${escapeXml(siteUrl)}</id>`,
        `  <updated>${updatedAt}</updated>`,
        entries,
        "</feed>",
        "",
    ].filter(Boolean).join("\n")
}

export function buildRssFeedXml(articles: readonly PublicArticleListItem[], baseUrl: string) {
    const siteUrl = toAbsolutePublicUrl("/", baseUrl)
    const selfUrl = toAbsolutePublicUrl("/rss.xml", baseUrl)
    const items = articles.map((article) => {
        const href = toAbsolutePublicUrl(article.href, baseUrl)
        const categories = renderRssCategories(article)
        return [
            "    <item>",
            `      <title>${escapeXml(article.title)}</title>`,
            `      <link>${escapeXml(href)}</link>`,
            `      <guid isPermaLink="true">${escapeXml(href)}</guid>`,
            `      <pubDate>${formatRssDate(article.updatedAt)}</pubDate>`,
            `      <description>${escapeXml(article.excerpt)}</description>`,
            categories,
            "    </item>",
        ].filter(Boolean).join("\n")
    }).join("\n")

    return [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
        "  <channel>",
        `    <title>${escapeXml(feedTitle)}</title>`,
        `    <link>${escapeXml(siteUrl)}</link>`,
        `    <description>${escapeXml(feedDescription)}</description>`,
        `    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml" />`,
        `    <lastBuildDate>${formatRssDate(latestUpdatedAt(articles))}</lastBuildDate>`,
        items,
        "  </channel>",
        "</rss>",
        "",
    ].filter(Boolean).join("\n")
}
