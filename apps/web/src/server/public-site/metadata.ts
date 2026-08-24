import type { PublicArticleListItem } from "@/lib/api"
import { getPublicBaseUrl, toAbsolutePublicUrl } from "@/server/public-site/site-url"

const siteName = "Petrichor"
const defaultDescription = "Petrichor 公开文章、知识与灵感更新。"

export type PageMetadata = {
    title: string
    description: string
    canonical: string
    atomUrl: string
    rssUrl: string
    index: boolean
    type: "website" | "article"
    tags?: string[]
    updatedAt?: string
}

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
}: PublicMetadataOptions): PageMetadata {
    const baseUrl = getPublicBaseUrl()
    return {
        title: withSiteName(title),
        description: cleanDescription(description),
        canonical: toAbsolutePublicUrl(pathname, baseUrl),
        atomUrl: toAbsolutePublicUrl("/atom.xml", baseUrl),
        rssUrl: toAbsolutePublicUrl("/rss.xml", baseUrl),
        index,
        type,
        ...(tags?.length ? { tags } : {}),
        ...(updatedAt ? { updatedAt } : {}),
    }
}

export function buildStaticPublicPageMetadata(pathname: string): PageMetadata {
    if (pathname === "/tags") {
        return buildPublicMetadata({ title: "标签", description: "按标签浏览 Petrichor 公开文章。", pathname })
    }
    if (pathname === "/about") {
        return buildPublicMetadata({ title: "关于", description: "了解 CiZai 的个人介绍、技术栈与创作方向。", pathname })
    }
    if (pathname === "/ask") {
        return buildPublicMetadata({ title: "AI 问答", description: "向 AI 提问，基于 Petrichor 公开文章实时检索作答。", pathname })
    }
    if (pathname === "/graph") {
        return buildPublicMetadata({
            title: "全站星图",
            description: "把公开文章、分类、标签以及 AI 抽取的概念与实体连成一张可交互的点群星图。",
            pathname,
        })
    }
    if (pathname === "/projects") {
        return buildPublicMetadata({ title: "开源项目", description: "CiZai 做过、参与过的一些开源项目。", pathname })
    }
    if (pathname === "/petrichor") {
        return buildPublicMetadata({
            title: "Petrichor · 开箱即用的全栈知识库与博客平台",
            description: "Petrichor 把富文本编辑器、多层级知识库、公开博客、AI 助手与 Agent 开放层做进同一个 Bun 全栈应用。",
            pathname,
        })
    }
    return buildPublicMetadata({ title: siteName, description: defaultDescription, pathname: "/" })
}

export function buildDashboardMetadata(pathname: string): PageMetadata {
    return buildPublicMetadata({
        title: pathname.startsWith("/login") ? "登录" : "工作台",
        description: "Petrichor 私有工作台。",
        pathname,
        index: false,
    })
}

export function buildArticleMetadata(article: PublicArticleListItem | null, pathname: string): PageMetadata {
    if (!article) {
        return buildPublicMetadata({
            title: "文章不可用",
            description: "这篇公开文章不存在、已撤销或尚未发布。",
            pathname,
            index: false,
            type: "article",
        })
    }
    return buildPublicMetadata({
        title: article.title,
        description: article.hasPassword ? "这篇文章需要访问密码。" : article.excerpt,
        pathname,
        index: !article.expired && !article.hasPassword,
        type: "article",
        tags: article.tags,
        updatedAt: article.updatedAt,
    })
}

export function resolvePublicRouteMetadata(
    pathSegments: readonly string[],
    articles: readonly PublicArticleListItem[],
): PageMetadata {
    const [firstSegment, secondSegment] = pathSegments
    const pathname = pathSegments.length > 0 ? `/${pathSegments.join("/")}` : "/"

    if (!firstSegment) return buildStaticPublicPageMetadata("/")
    if (["tags", "about", "ask", "graph", "projects", "petrichor"].includes(firstSegment) && pathSegments.length === 1) {
        return buildStaticPublicPageMetadata(pathname)
    }
    if (firstSegment === "demo" && pathSegments.length === 1) {
        return buildPublicMetadata({
            title: "演示模式",
            description: "免登录体验 Petrichor 工作台：知识库、编辑器与 AI 助手，数据仅存于浏览器内存。",
            pathname,
            index: false,
        })
    }
    if (firstSegment === "p" && secondSegment) {
        return buildArticleMetadata(articles.find((item) => item.shareCode === secondSegment) ?? null, pathname)
    }
    if (firstSegment === "dashboard" || firstSegment === "login" || firstSegment === "auth") {
        return buildDashboardMetadata(pathname)
    }
    if (firstSegment === "b" && secondSegment) {
        return buildPublicMetadata({
            title: "私密链接",
            description: "这是一个阅后即焚的私密访问链接。",
            pathname,
            index: false,
        })
    }
    return buildPublicMetadata({
        title: "页面未找到",
        description: "这个 Petrichor 页面不存在或暂未公开。",
        pathname,
        index: false,
    })
}

function escapeHtml(value: string) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;")
}

export function renderMetadataHead(metadata: PageMetadata) {
    const title = escapeHtml(metadata.title)
    const description = escapeHtml(metadata.description)
    const canonical = escapeHtml(metadata.canonical)
    const robots = metadata.index ? "index,follow" : "noindex,nofollow"
    const articleTags = metadata.tags?.map((tag) => `<meta property="article:tag" content="${escapeHtml(tag)}">`).join("") ?? ""
    const modifiedTime = metadata.updatedAt
        ? `<meta property="article:modified_time" content="${escapeHtml(metadata.updatedAt)}">`
        : ""

    return [
        `<title>${title}</title>`,
        `<meta name="description" content="${description}">`,
        `<meta name="robots" content="${robots}">`,
        `<link rel="canonical" href="${canonical}">`,
        `<link rel="alternate" type="application/atom+xml" href="${escapeHtml(metadata.atomUrl)}">`,
        `<link rel="alternate" type="application/rss+xml" href="${escapeHtml(metadata.rssUrl)}">`,
        `<meta property="og:title" content="${title}">`,
        `<meta property="og:description" content="${description}">`,
        `<meta property="og:url" content="${canonical}">`,
        '<meta property="og:site_name" content="Petrichor">',
        `<meta property="og:type" content="${metadata.type}">`,
        '<meta property="og:locale" content="zh_CN">',
        '<meta name="twitter:card" content="summary">',
        `<meta name="twitter:title" content="${title}">`,
        `<meta name="twitter:description" content="${description}">`,
        modifiedTime,
        articleTags,
    ].filter(Boolean).join("\n")
}
