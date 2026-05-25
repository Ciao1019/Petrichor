import type { Metadata } from "next"
import type { PublicArticleListItem } from "@/lib/api"
import { getPublicBaseUrl, toAbsolutePublicUrl } from "@/server/public-site/site-url"

const siteName = "Petrichor"
const defaultDescription = "Petrichor 公开文章、知识与灵感更新。"

type PublicMetadataOptions = {
    title: string
    description: string
    pathname: string
    index?: boolean
    type?: "website" | "article"
    tags?: string[]
    updatedAt?: string
}

function cleanDescription(value: string) {
    return value.replace(/\s+/g, " ").trim().slice(0, 160) || defaultDescription
}

function withSiteName(title: string) {
    return title === siteName ? siteName : `${title} | ${siteName}`
}

export function buildPublicMetadata({
    title,
    description,
    pathname,
    index = true,
    type = "website",
    tags,
    updatedAt,
}: PublicMetadataOptions): Metadata {
    const baseUrl = getPublicBaseUrl()
    const canonical = toAbsolutePublicUrl(pathname, baseUrl)
    const normalizedTitle = withSiteName(title)
    const normalizedDescription = cleanDescription(description)

    return {
        metadataBase: new URL(baseUrl),
        title: title === siteName ? { absolute: siteName } : title,
        description: normalizedDescription,
        alternates: {
            canonical,
            types: {
                "application/atom+xml": toAbsolutePublicUrl("/atom.xml", baseUrl),
                "application/rss+xml": toAbsolutePublicUrl("/rss.xml", baseUrl),
            },
        },
        openGraph: {
            title: normalizedTitle,
            description: normalizedDescription,
            url: canonical,
            siteName,
            type,
            locale: "zh_CN",
            ...(type === "article" && updatedAt ? { modifiedTime: updatedAt, tags } : {}),
        },
        twitter: {
            card: "summary",
            title: normalizedTitle,
            description: normalizedDescription,
        },
        robots: index
            ? { index: true, follow: true }
            : { index: false, follow: false, googleBot: { index: false, follow: false } },
    }
}

export function buildStaticPublicPageMetadata(pathname: string): Metadata {
    if (pathname === "/tags") {
        return buildPublicMetadata({
            title: "标签",
            description: "按标签浏览 Petrichor 公开文章。",
            pathname,
        })
    }

    if (pathname === "/about") {
        return buildPublicMetadata({
            title: "关于",
            description: "了解 CiZai 的个人介绍、技术栈与创作方向。",
            pathname,
        })
    }

    return buildPublicMetadata({
        title: siteName,
        description: defaultDescription,
        pathname: "/",
    })
}

export function buildDashboardMetadata(pathname: string): Metadata {
    return buildPublicMetadata({
        title: pathname.startsWith("/login") ? "登录" : "工作台",
        description: "Petrichor 私有工作台。",
        pathname,
        index: false,
    })
}

export function buildArticleMetadata(article: PublicArticleListItem | null, pathname: string): Metadata {
    if (!article) {
        return buildPublicMetadata({
            title: "文章不可用",
            description: "这篇公开文章不存在、已撤销或尚未发布。",
            pathname,
            index: false,
            type: "article",
        })
    }

    const index = !article.expired && !article.hasPassword
    return buildPublicMetadata({
        title: article.title,
        description: article.hasPassword ? "这篇文章需要访问密码。" : article.excerpt,
        pathname,
        index,
        type: "article",
        tags: article.tags,
        updatedAt: article.updatedAt,
    })
}

export function resolvePublicRouteMetadata(
    pathSegments: readonly string[],
    articles: readonly PublicArticleListItem[],
): Metadata {
    const [firstSegment, secondSegment] = pathSegments
    const pathname = pathSegments.length > 0 ? `/${pathSegments.join("/")}` : "/"

    if (!firstSegment) {
        return buildStaticPublicPageMetadata("/")
    }
    if (firstSegment === "tags" && pathSegments.length === 1) {
        return buildStaticPublicPageMetadata("/tags")
    }
    if (firstSegment === "about" && pathSegments.length === 1) {
        return buildStaticPublicPageMetadata("/about")
    }
    if (firstSegment === "p" && secondSegment) {
        const article = articles.find((item) => item.shareCode === secondSegment) ?? null
        return buildArticleMetadata(article, pathname)
    }
    if (firstSegment === "dashboard" || firstSegment === "login" || firstSegment === "auth") {
        return buildDashboardMetadata(pathname)
    }

    return buildPublicMetadata({
        title: "页面未找到",
        description: "这个 Petrichor 页面不存在或暂未公开。",
        pathname,
        index: false,
    })
}
