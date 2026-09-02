import type {
  AboutProfileResponse,
  ProjectShowcaseResponse,
  PublicArticleListItem,
  PublicSharedArticleDetailResponse,
  SiteGraphPayload,
} from "@/lib/api"

import { demoStore } from "./demo-store"

/** 后台文章与前台分享码的固定映射，保证刷新与预取时 URL 稳定。 */
const SHARE_CODE_BY_ARTICLE_ID: Record<string, string> = {
  "demo-a-mole": "mole-macos-guide",
  "demo-a-fastfetch": "fastfetch-guide",
}

const FEATURED_ARTICLE_IDS = ["demo-a-mole", "demo-a-fastfetch"]

function plainExcerpt(markdown: string) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return Array.from(text).slice(0, 128).join("")
}

export function demoShareCodeForArticle(articleId: string): string | null {
  return SHARE_CODE_BY_ARTICLE_ID[articleId] ?? null
}

export function buildDemoPublicArticleList(): PublicArticleListItem[] {
  return FEATURED_ARTICLE_IDS.flatMap((articleId, index) => {
    const article = demoStore.articles.get(articleId)
    const shareCode = demoShareCodeForArticle(articleId)
    if (!article || !shareCode) return []
    const excerpt = plainExcerpt(article.contentMd).replace(article.title, "").trim()
    return [{
      articleId,
      shareCode,
      title: article.title,
      excerpt,
      updatedAt: article.updatedAt,
      readingMinutes: Math.max(2, Math.ceil(article.contentMd.length / 450)),
      tags: article.tags,
      href: `/p/${shareCode}`,
      expired: false,
      expiresAt: null,
      hasPassword: false,
      isRepost: false,
      isInternalLink: false,
      isPinned: index === 0,
      pinOrder: index === 0 ? 100 : null,
    }]
  })
}

function demoAiSummary(title: string) {
  if (title.includes("Mole")) {
    return "这是一份面向普通 Mac 用户的 Mole 完整手册：从终端与安装开始，覆盖清理、卸载、磁盘分析、优化、状态监控和项目缓存清理，并重点说明 dry-run、备份与白名单等安全边界。"
  }
  return "这份手册系统介绍 Fastfetch 的跨平台安装、常用命令、JSONC 配置、模块系统、Logo 与格式字符串，也包含预设方案、性能统计和常见问题排查。"
}

export function findDemoPublicArticle(shareCode: string): PublicSharedArticleDetailResponse | null {
  const articleId = Object.entries(SHARE_CODE_BY_ARTICLE_ID)
    .find(([, code]) => code === shareCode)?.[0]
  if (!articleId || !FEATURED_ARTICLE_IDS.includes(articleId)) return null
  const article = demoStore.articles.get(articleId)
  if (!article) return null
  return {
    title: article.title,
    contentMd: article.contentMd,
    contentJson: article.contentJson,
    contentMetaJson: article.contentMetaJson,
    tocJson: null,
    aiSummary: demoAiSummary(article.title),
    aiSummaryGeneratedAt: article.updatedAt,
    aiSummaryStale: false,
    tags: article.tags,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
    isRepost: false,
    originalUrl: null,
    originalAuthorName: null,
    mindmapData: null,
    mindmapGeneratedAt: article.updatedAt,
    knowledgeGraphData: null,
    knowledgeGraphGeneratedAt: article.updatedAt,
  }
}

export function searchDemoPublicArticles(keyword: string, offset = 0, limit = 20) {
  const normalized = keyword.trim().toLowerCase()
  const matches = buildDemoPublicArticleList().filter((item) => {
    if (!normalized) return true
    const article = demoStore.articles.get(item.articleId)
    return [item.title, item.excerpt, item.tags.join(" "), article?.contentMd ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(normalized)
  })
  return {
    keyword,
    limit,
    offset,
    items: matches.slice(offset, offset + limit).map((item, index) => ({
      ...item,
      score: Math.max(0.5, 0.98 - index * 0.06),
    })),
    hasMore: offset + limit < matches.length,
  }
}

// 与 202608270002_init.sql 的字段默认值保持一致，演示从真实初始化状态开始。
export const DEMO_ABOUT_PROFILE: AboutProfileResponse = {
  displayName: "CiZai",
  roleTitle: "Creative Dev & Visual Artist",
  intro: "我是 CiZai，是一个普普通通的程序员。\n\n目前就职于金山办公\n\n我的兴趣主要在 Coding / AI 方向。\n\n我喜欢 Minecraft。",
  expertise: ["Frontend Architecture", "AI 应用开发", "Knowledge Systems", "Creative Coding"],
  toolkit: ["TypeScript", "React", "Next.js", "AI", "PostgreSQL", "Minecraft"],
  quote: "Code is just another medium for painting dreams.",
  accents: [
    { phrase: "CiZai", style: "red", note: "yep, that's me" },
    { phrase: "程序员", style: "green", note: "just a dev" },
    { phrase: "金山办公", style: "blue", note: "where I work" },
    { phrase: "Coding / AI", style: "green", note: "my playground" },
    { phrase: "Minecraft", style: "blue", note: "★ my comfort game" },
  ],
  contactText: "想聊点什么？随时",
  contactLabel: "message me",
  contactHref: "mailto:zang@linux.do",
}

export const DEMO_PROJECT_SHOWCASE: ProjectShowcaseResponse = {
  heading: "开源项目",
  intro: "我正在构建与参与的开源项目。点开每一项，可以查看项目简介、技术栈与源码。",
  items: [
    {
      name: "Petrichor",
      year: "2026",
      stack: ["TypeScript", "React", "Go", "PostgreSQL"],
      stamp: "SELF-HOSTED",
      stampColor: "red",
      blurb: "面向人与 AI Agent 的自托管知识平台：从编辑、公开发布和语义 Wiki，到基于证据的 RAG 问答、MCP / REST 接入与可移植 Agent Skill。",
      repoUrl: "https://github.com/Ciao1019/Petrichor",
      siteUrl: "",
    },
    {
      name: "AgentX",
      year: "2025",
      stack: ["Java", "TypeScript", "MCP", "Docker"],
      stamp: "AGENT",
      stampColor: "blue",
      blurb: "通过自然语言与工具集成构建个性化智能 Agent，涵盖 MCP 网关、模型高可用、RAG、长期记忆、定时任务、监控与 OpenAPI。",
      repoUrl: "https://github.com/lucky-aeon/AgentX",
      siteUrl: "",
    },
    {
      name: "stream-query",
      year: "2022",
      stack: ["Java", "MyBatis-Plus", "Stream", "Lambda"],
      stamp: "DROMARA",
      stampColor: "green",
      blurb: "以 Stream 与 Lambda 封装数据查询和结果处理，提供无需手写 Mapper 的 MyBatis-Plus 体验，并支持 Database、OneToOne 与 OneToMany 等流式 API。",
      repoUrl: "https://github.com/dromara/stream-query",
      siteUrl: "",
    },
  ],
}

export function buildDemoSiteGraph(): SiteGraphPayload {
  const articles = buildDemoPublicArticleList()
  const sectionId = "demo-section-open-source"
  const nodes: SiteGraphPayload["nodes"] = [
    {
      id: "demo-graph-root",
      label: "CiZai",
      kind: "root",
      route: "/",
      summary: "Coding、AI 与开源工具的个人知识站。",
      attributes: [{ name: "来源", value: "Petrichor 静态演示" }],
      aliases: ["CiZai's Knowledge Base"],
      parentId: null,
      topSectionId: null,
      weight: 10,
    },
    {
      id: sectionId,
      label: "开源命令行工具",
      kind: "section",
      route: null,
      summary: "面向日常使用的安装、配置、安全实践与问题排查指南。",
      attributes: [],
      aliases: ["CLI 工具"],
      parentId: "demo-graph-root",
      topSectionId: sectionId,
      weight: 8,
    },
    ...articles.map((article, index) => ({
      id: `demo-graph-article-${index + 1}`,
      label: article.title,
      kind: "article" as const,
      route: article.href,
      summary: article.excerpt,
      attributes: article.tags.map((tag) => ({ name: "标签", value: tag })),
      aliases: [],
      parentId: sectionId,
      topSectionId: sectionId,
      weight: 6,
    })),
    {
      id: "demo-concept-safe-cleanup",
      label: "安全清理",
      kind: "concept",
      route: "/p/mole-macos-guide",
      summary: "通过 dry-run、白名单与备份降低系统清理风险。",
      attributes: [{ name: "来源", value: "Mole 指南" }],
      aliases: ["预览模式"],
      parentId: sectionId,
      topSectionId: sectionId,
      weight: 5,
    },
    {
      id: "demo-concept-system-profile",
      label: "系统信息展示",
      kind: "concept",
      route: "/p/fastfetch-guide",
      summary: "使用模块、Logo 与格式字符串构建可定制的终端系统概览。",
      attributes: [{ name: "来源", value: "Fastfetch 指南" }],
      aliases: ["System Fetch"],
      parentId: sectionId,
      topSectionId: sectionId,
      weight: 5,
    },
  ]
  const links: SiteGraphPayload["links"] = [
    { source: "demo-graph-root", target: sectionId, kind: "structure", relation: "包含" },
    ...articles.map((_, index) => ({
      source: sectionId,
      target: `demo-graph-article-${index + 1}`,
      kind: "structure" as const,
      relation: "包含",
    })),
    { source: "demo-graph-article-1", target: "demo-concept-safe-cleanup", kind: "derived", relation: "提炼" },
    { source: "demo-graph-article-2", target: "demo-concept-system-profile", kind: "derived", relation: "提炼" },
    { source: "demo-concept-safe-cleanup", target: "demo-concept-system-profile", kind: "semantic", relation: "共同用于系统维护" },
  ]
  return {
    nodes,
    links,
    stats: {
      nodeCount: nodes.length,
      linkCount: links.length,
      articleCount: articles.length,
      conceptCount: 2,
    },
    generatedAt: new Date().toISOString(),
  }
}
