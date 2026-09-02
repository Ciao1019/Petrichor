import type {
  KbWikiEmbeddingRunResult,
  KnowledgeBaseWikiDashboardResponse,
  KnowledgeBaseWikiGraphResponse,
  KnowledgeBaseWikiGuideResponse,
  KnowledgeBaseWikiIngestResponse,
  KnowledgeBaseWikiLintResponse,
  KnowledgeBaseWikiPageDetailResponse,
  KnowledgeBaseWikiPageKind,
  KnowledgeBaseWikiPageResponse,
  KnowledgeBaseWikiTreeResponse,
  PublicWikiPageDetail,
} from "@/lib/api"

import { demoShareCodeForArticle } from "./demo-public-data"
import { demoStore, kbById } from "./demo-store"

interface WikiSeed {
  pageKey: string
  title: string
  kind: KnowledgeBaseWikiPageKind
  summary: string
  categoryPath?: string[]
  aliases?: string[]
  contentMd: string
  sourceArticleIds?: string[]
  links?: string[]
}

const PRODUCT_KB = "demo-kb-product"
const ENGINEERING_KB = "demo-kb-engineering"
const READING_KB = "demo-kb-reading"

const TOOL_WIKI: WikiSeed[] = [
  {
    pageKey: "index",
    title: "开源命令行工具知识索引",
    kind: "index",
    summary: "从 Mole 的 macOS 清理能力到 Fastfetch 的跨平台系统信息展示。",
    aliases: ["CLI 工具索引", "开源工具 Wiki"],
    contentMd: `# 开源命令行工具知识索引

这个知识空间由两篇完整使用手册编译而来，把安装步骤、关键命令、安全边界和配置方法整理成可关联的 Wiki 页面。

## 主题导航

- [[entity-mole|Mole]]：macOS 上的清理、卸载、磁盘分析、优化与状态监控
- [[concept-safe-cleanup|安全清理流程]]：先预览、再白名单、最后执行
- [[entity-fastfetch|Fastfetch]]：跨平台系统信息展示工具
- [[concept-jsonc-config|JSONC 配置]]：模块、Logo、显示格式和自定义输出
- [[comparison-mole-fastfetch|Mole 与 Fastfetch]]：一个维护系统，一个观察系统

## 推荐阅读路径

Mac 用户可以先看 Mole 的安全清理流程；需要定制终端启动画面时，再进入 Fastfetch 的 JSONC 配置页面。`,
    links: ["entity-mole", "concept-safe-cleanup", "entity-fastfetch", "concept-jsonc-config", "comparison-mole-fastfetch"],
  },
  {
    pageKey: "entity-mole",
    title: "Mole",
    kind: "entity",
    summary: "专为 macOS 设计的免费开源命令行清理和系统维护工具。",
    categoryPath: ["开源工具", "macOS"],
    aliases: ["小鼹鼠", "mo"],
    contentMd: `# Mole

Mole（小鼹鼠）是一款专为 macOS 设计的开源命令行工具，覆盖深度清理、智能卸载、磁盘分析、系统优化、系统状态和项目清理。

## 六个主要入口

| 命令 | 用途 |
| --- | --- |
| \`mo clean\` | 清理缓存、日志和临时文件 |
| \`mo uninstall\` | 连同配置与残留彻底卸载应用 |
| \`mo analyze\` | 交互式查看磁盘空间 |
| \`mo optimize\` | 执行系统维护任务 |
| \`mo status\` | 查看 CPU、内存、磁盘和网络 |
| \`mo purge\` | 清理开发项目构建产物 |

第一次执行删除类命令前，应遵循 [[concept-safe-cleanup|安全清理流程]]。`,
    sourceArticleIds: ["demo-a-mole"],
    links: ["concept-safe-cleanup", "concept-mole-whitelist", "comparison-mole-fastfetch"],
  },
  {
    pageKey: "concept-safe-cleanup",
    title: "安全清理流程",
    kind: "concept",
    summary: "使用 dry-run、备份和白名单建立可检查、可控制的系统清理流程。",
    categoryPath: ["系统维护", "安全"],
    aliases: ["Mole dry-run", "预览模式"],
    contentMd: `# 安全清理流程

Mole 的清理能力很强，推荐把清理动作拆成四步：

1. 使用 Time Machine 或其他方式备份重要数据
2. 先执行 \`mo clean --dry-run\` 查看候选文件
3. 将重要缓存加入 [[concept-mole-whitelist|Mole 白名单]]
4. 确认范围后再运行 \`mo clean\`

开发者需要特别留意 Xcode DerivedData、Node.js、Python、Rust 和 Go 的构建缓存；清理后首次构建可能变慢。`,
    sourceArticleIds: ["demo-a-mole"],
    links: ["entity-mole", "concept-mole-whitelist"],
  },
  {
    pageKey: "concept-mole-whitelist",
    title: "Mole 白名单",
    kind: "concept",
    summary: "保护设计素材、机器学习模型和其他不应被自动清理的缓存目录。",
    categoryPath: ["系统维护", "安全"],
    aliases: ["whitelist"],
    contentMd: `# Mole 白名单

运行 \`mo clean --whitelist\` 或编辑 \`~/.config/mole/whitelist\`，每行写一个需要保护的路径。

白名单适合保存设计软件素材缓存、机器学习模型缓存以及工作项目依赖。它和 [[concept-safe-cleanup|预览模式]] 配合使用，能显著降低误删风险。`,
    sourceArticleIds: ["demo-a-mole"],
    links: ["entity-mole", "concept-safe-cleanup"],
  },
  {
    pageKey: "entity-fastfetch",
    title: "Fastfetch",
    kind: "entity",
    summary: "强调性能和可定制性的跨平台系统信息展示工具。",
    categoryPath: ["开源工具", "跨平台"],
    aliases: ["System fetch", "Neofetch alternative"],
    contentMd: `# Fastfetch

Fastfetch 使用 C 语言实现，是仍在积极维护的 Neofetch 替代方案。它支持 Linux、macOS、Windows、Android 与多种 BSD 系统。

## 关键能力

- 更快的系统信息采集
- 模块化的硬件、软件和网络信息
- 多种 ASCII 或图片 Logo 协议
- [[concept-jsonc-config|JSONC 配置]]与 JSON Schema 智能提示
- JSON 输出和每模块性能统计

直接运行 \`fastfetch\` 即可查看默认系统概览。`,
    sourceArticleIds: ["demo-a-fastfetch"],
    links: ["concept-jsonc-config", "concept-fastfetch-modules", "comparison-mole-fastfetch"],
  },
  {
    pageKey: "concept-jsonc-config",
    title: "Fastfetch JSONC 配置",
    kind: "concept",
    summary: "通过带注释的 JSON 配置模块顺序、Logo、颜色与格式字符串。",
    categoryPath: ["Fastfetch", "配置"],
    aliases: ["config.jsonc", "JSON with Comments"],
    contentMd: `# Fastfetch JSONC 配置

默认配置文件位于 \`~/.config/fastfetch/config.jsonc\`。可用 \`fastfetch --gen-config\` 生成最小配置，或用 \`--gen-config-full\` 查看完整选项。

\`modules\` 数组决定展示顺序；对象形式还能配置 key、颜色和 format。加入官方 \`$schema\` 后，VS Code 等编辑器可以提供智能提示。

> Command 模块能够执行任意 Shell 命令，不应加载来源不可信的配置文件。`,
    sourceArticleIds: ["demo-a-fastfetch"],
    links: ["entity-fastfetch", "concept-fastfetch-modules"],
  },
  {
    pageKey: "concept-fastfetch-modules",
    title: "Fastfetch 模块系统",
    kind: "concept",
    summary: "用 OS、CPU、GPU、Memory、Disk、Command 等模块组合终端系统概览。",
    categoryPath: ["Fastfetch", "模块"],
    aliases: ["modules", "structure"],
    contentMd: `# Fastfetch 模块系统

常用模块分为系统信息、硬件信息、软件环境、网络与自定义输出。可以用 \`fastfetch --list-modules\` 查看完整清单，或用 \`-s os:kernel:memory\` 临时指定结构。

模块对象支持格式占位符、条件内容、切片、填充和 ANSI 颜色。复杂配置应写入 [[concept-jsonc-config|JSONC 配置文件]]。`,
    sourceArticleIds: ["demo-a-fastfetch"],
    links: ["entity-fastfetch", "concept-jsonc-config"],
  },
  {
    pageKey: "comparison-mole-fastfetch",
    title: "Mole 与 Fastfetch",
    kind: "comparison",
    summary: "两款命令行工具分别负责系统维护与系统信息展示。",
    categoryPath: ["开源工具", "对比"],
    aliases: ["系统维护工具组合"],
    contentMd: `# Mole 与 Fastfetch

| 工具 | 核心目标 | 典型入口 | 平台 |
| --- | --- | --- | --- |
| [[entity-mole|Mole]] | 清理、卸载、优化和监控 | \`mo clean\` | macOS |
| [[entity-fastfetch|Fastfetch]] | 获取并展示系统信息 | \`fastfetch\` | 跨平台 |

它们不是替代关系：Fastfetch 适合快速观察系统状态和环境，Mole 适合在确认范围后执行维护动作。`,
    sourceArticleIds: ["demo-a-mole", "demo-a-fastfetch"],
    links: ["entity-mole", "entity-fastfetch", "concept-safe-cleanup"],
  },
  {
    pageKey: "source-mole-guide",
    title: "小鼹鼠 Mole：macOS 清理工具完整使用指南",
    kind: "source",
    summary: "涵盖 Mole 的安装、六项核心功能、安全注意事项和常见问题。",
    contentMd: `# Mole 完整指南 · 来源摘要

文章从终端基础开始，依次介绍安装、清理、卸载、分析、优化、监控和项目清理，并重点强调 [[concept-safe-cleanup|dry-run 安全流程]]与 [[concept-mole-whitelist|白名单]]。`,
    sourceArticleIds: ["demo-a-mole"],
    links: ["entity-mole", "concept-safe-cleanup", "concept-mole-whitelist"],
  },
  {
    pageKey: "source-fastfetch-guide",
    title: "Fastfetch 使用说明：安装、配置与高级技巧",
    kind: "source",
    summary: "覆盖跨平台安装、JSONC 配置、模块、Logo、格式字符串和问题排查。",
    contentMd: `# Fastfetch 完整指南 · 来源摘要

文章系统梳理跨平台安装、常用命令、[[concept-jsonc-config|JSONC 配置]]、[[concept-fastfetch-modules|模块系统]]、Logo、格式字符串、预设与高级技巧。`,
    sourceArticleIds: ["demo-a-fastfetch"],
    links: ["entity-fastfetch", "concept-jsonc-config", "concept-fastfetch-modules"],
  },
]

function fallbackWiki(title: string, articleIds: string[]): WikiSeed[] {
  return [
    {
      pageKey: "index",
      title: `${title}知识索引`,
      kind: "index",
      summary: `从「${title}」中的文章自动整理出的演示索引。`,
      contentMd: `# ${title}知识索引\n\n此空间展示来源文章、目录树、质量检查和向量化状态。`,
    },
    ...articleIds.flatMap((articleId, index): WikiSeed[] => {
      const article = demoStore.articles.get(articleId)
      if (!article) return []
      return [{
        pageKey: `source-${index + 1}`,
        title: article.title,
        kind: "source",
        summary: article.contentMd.replace(/[#>*_`|~-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100),
        contentMd: `# ${article.title} · 来源摘要\n\n该页面由演示文章自动编译，用于展示 Wiki 来源追踪。`,
        sourceArticleIds: [articleId],
      }]
    }),
  ]
}

const WIKI_BY_KB: Record<string, WikiSeed[]> = {
  [PRODUCT_KB]: TOOL_WIKI,
  [ENGINEERING_KB]: fallbackWiki("前端工程", ["demo-a-rsc", "demo-a-ts-narrow", "demo-a-vite-chunk"]),
  [READING_KB]: fallbackWiki("阅读", ["demo-a-thinking-fast", "demo-a-staff-eng"]),
}

function wikiTimestamp(index: number) {
  return new Date(Date.now() - (index + 1) * 3_600_000).toISOString()
}

function toPage(knowledgeBaseId: string, seed: WikiSeed, index: number): KnowledgeBaseWikiPageResponse {
  return {
    id: `demo-wiki-${knowledgeBaseId}-${index + 1}`,
    knowledgeBaseId,
    pageKey: seed.pageKey,
    title: seed.title,
    kind: seed.kind,
    contentMd: seed.contentMd,
    frontmatter: { demo: true, kind: seed.kind },
    categoryPath: seed.categoryPath ?? [],
    aliases: seed.aliases ?? [],
    summary: seed.summary,
    contentHash: `demo-hash-${index + 1}`,
    version: 1,
    archivedAt: null,
    createdAt: wikiTimestamp(index + 6),
    updatedAt: wikiTimestamp(index),
  }
}

export function demoWikiPages(knowledgeBaseId: string): KnowledgeBaseWikiPageResponse[] {
  return (WIKI_BY_KB[knowledgeBaseId] ?? []).map((seed, index) => toPage(knowledgeBaseId, seed, index))
}

export function demoWikiPageDetail(
  knowledgeBaseId: string,
  pageKey: string,
): KnowledgeBaseWikiPageDetailResponse | null {
  const seeds = WIKI_BY_KB[knowledgeBaseId] ?? []
  const seedIndex = seeds.findIndex((item) => item.pageKey === pageKey)
  const seed = seeds[seedIndex]
  if (!seed) return null
  const page = toPage(knowledgeBaseId, seed, seedIndex)
  const sourceRefs = (seed.sourceArticleIds ?? []).flatMap((articleId, index) => {
    const article = demoStore.articles.get(articleId)
    if (!article) return []
    return [{
      id: `demo-ref-${pageKey}-${index + 1}`,
      articleId,
      articleTitle: article.title,
      anchor: null,
      note: "演示数据中的来源文章",
    }]
  })
  const links = (seed.links ?? []).flatMap((targetKey, index) => {
    const target = seeds.find((item) => item.pageKey === targetKey)
    if (!target) return []
    return [{
      id: `demo-link-${pageKey}-${index + 1}`,
      toPageKey: target.pageKey,
      toPageTitle: target.title,
      toPageKind: target.kind,
      toPageSummary: target.summary,
      linkType: "related",
      description: "知识页面关联",
    }]
  })
  const inLinks = seeds.flatMap((candidate, index) => {
    if (!(candidate.links ?? []).includes(pageKey)) return []
    return [{
      id: `demo-backlink-${pageKey}-${index + 1}`,
      fromPageKey: candidate.pageKey,
      fromPageTitle: candidate.title,
      fromPageKind: candidate.kind,
      fromPageSummary: candidate.summary,
      linkType: "related",
      description: "反向引用",
    }]
  })
  return { ...page, sourceRefs, links, inLinks }
}

export function demoWikiLint(knowledgeBaseId: string): KnowledgeBaseWikiLintResponse {
  const pages = demoWikiPages(knowledgeBaseId)
  const linkCount = (WIKI_BY_KB[knowledgeBaseId] ?? []).reduce((sum, page) => sum + (page.links?.length ?? 0), 0)
  const sourceRefCount = (WIKI_BY_KB[knowledgeBaseId] ?? []).reduce((sum, page) => sum + (page.sourceArticleIds?.length ?? 0), 0)
  return {
    score: pages.length > 0 ? 98 : 0,
    pageCount: pages.length,
    linkCount,
    sourceRefCount,
    stalePageCount: 0,
    issueCount: 0,
    issues: [],
    checkedAt: new Date().toISOString(),
  }
}

export function demoWikiDashboard(knowledgeBaseId: string): KnowledgeBaseWikiDashboardResponse {
  const pages = demoWikiPages(knowledgeBaseId)
  const chunkCount = pages.filter((page) => page.kind === "source").length * 18
  const questionCount = pages.filter((page) => page.kind !== "source").length * 3
  const total = chunkCount + questionCount
  return {
    pages,
    lint: demoWikiLint(knowledgeBaseId),
    chunkCount,
    treeNodeCount: chunkCount,
    embedding: {
      supported: true,
      total,
      embedded: total,
      pending: 0,
      failed: 0,
      chunk: { total: chunkCount, embedded: chunkCount, pending: 0, failed: 0 },
      question: { total: questionCount, embedded: questionCount, pending: 0, failed: 0 },
      model: "text-embedding-3-small",
      dimensions: 1536,
      version: 1,
    },
  }
}

export function demoWikiTree(knowledgeBaseId: string, articleId: string): KnowledgeBaseWikiTreeResponse {
  const article = demoStore.articles.get(articleId)
  const title = article?.title ?? "演示源文档"
  const headings = article?.contentMd
    .split("\n")
    .filter((line) => /^#{1,3}\s/.test(line))
    .slice(0, 36)
    .map((line) => ({ depth: Math.max(0, (line.match(/^#+/)?.[0].length ?? 1) - 1), title: line.replace(/^#+\s*/, "") })) ?? []
  return {
    knowledgeBaseId,
    articleId,
    nodes: headings.map((heading, index) => ({
      nodeKey: `demo-tree-${index + 1}`,
      articleId,
      parentKey: heading.depth === 0 ? null : "demo-tree-1",
      depth: heading.depth,
      title: heading.title || title,
      summary: heading.depth === 0 ? "源文章目录" : null,
      tokenEstimate: 120 + index * 45,
    })),
  }
}

export function demoWikiGraph(knowledgeBaseId: string): KnowledgeBaseWikiGraphResponse {
  const pages = demoWikiPages(knowledgeBaseId)
  const seeds = WIKI_BY_KB[knowledgeBaseId] ?? []
  const links = seeds.flatMap((seed, seedIndex) => (seed.links ?? []).map((targetKey, linkIndex) => ({
    id: `demo-graph-link-${seedIndex + 1}-${linkIndex + 1}`,
    fromPageKey: seed.pageKey,
    toPageKey: targetKey,
    linkType: "related",
    description: "知识页面关联",
  })))
  return {
    knowledgeBaseId,
    knowledgeBaseName: kbById(knowledgeBaseId)?.name ?? "演示知识库",
    nodes: pages.map((page) => ({
      pageKey: page.pageKey,
      title: page.title,
      kind: page.kind,
      summary: page.summary ?? null,
      categoryPath: page.categoryPath,
      aliases: page.aliases,
      sourceCount: demoWikiPageDetail(knowledgeBaseId, page.pageKey)?.sourceRefs.length ?? 0,
      updatedAt: page.updatedAt ?? new Date().toISOString(),
    })),
    links,
    stats: {
      pageCount: pages.length,
      linkCount: links.length,
      conceptCount: pages.filter((page) => page.kind === "concept").length,
      entityCount: pages.filter((page) => page.kind === "entity").length,
      sourceCount: pages.filter((page) => page.kind === "source").length,
    },
    generatedAt: new Date().toISOString(),
  }
}

export function demoPublicWikiPage(pageKey: string): PublicWikiPageDetail | null {
  for (const knowledgeBaseId of Object.keys(WIKI_BY_KB)) {
    const detail = demoWikiPageDetail(knowledgeBaseId, pageKey)
    if (!detail) continue
    return {
      pageKey: detail.pageKey,
      title: detail.title,
      kind: detail.kind,
      summary: detail.summary ?? "",
      aliases: detail.aliases,
      contentMd: detail.contentMd,
      links: detail.links.map((link) => ({
        pageKey: link.toPageKey,
        title: link.toPageTitle,
        kind: link.toPageKind ?? null,
        summary: link.toPageSummary ?? null,
        linkType: link.linkType,
      })),
      inLinks: detail.inLinks.map((link) => ({
        pageKey: link.fromPageKey,
        title: link.fromPageTitle,
        kind: link.fromPageKind ?? null,
        summary: link.fromPageSummary ?? null,
        linkType: link.linkType,
      })),
      sourceArticles: detail.sourceRefs.map((ref) => {
        const shareCode = demoShareCodeForArticle(ref.articleId)
        return {
          articleId: ref.articleId,
          title: ref.articleTitle,
          href: shareCode ? `/p/${shareCode}` : "/",
          note: ref.note ?? null,
        }
      }),
    }
  }
  return null
}

export function demoWikiIngest(knowledgeBaseId: string): KnowledgeBaseWikiIngestResponse | null {
  const pages = demoWikiPages(knowledgeBaseId)
  const indexPage = pages.find((page) => page.kind === "index")
  if (!indexPage) return null
  return { knowledgeBaseId, indexPage, pages, purged: null, warnings: [] }
}

export function demoWikiEmbedding(knowledgeBaseId: string): KbWikiEmbeddingRunResult {
  const status = demoWikiDashboard(knowledgeBaseId).embedding
  return {
    embedded: 0,
    embeddedChunks: 0,
    embeddedQuestions: 0,
    ready: status.embedded,
    total: status.total,
    pending: 0,
    failed: 0,
    chunk: status.chunk,
    question: status.question,
    model: status.model,
    dimensions: status.dimensions,
    version: status.version,
  }
}

export function demoWikiGuide(knowledgeBaseId: string, contentMd?: string): KnowledgeBaseWikiGuideResponse {
  const saved = contentMd?.trim()
  const template = `# 编译目标\n\n- 保留安装命令、关键参数与安全警告\n- 抽取可复用的工具概念和对比页面\n- 每项结论都回链到 Mole 或 Fastfetch 来源文章`
  return {
    knowledgeBaseId,
    pageKey: "__guide__",
    title: "演示编译说明书",
    enabled: Boolean(saved),
    contentMd: saved || template,
    templateMd: template,
    maxLength: 12_000,
    updatedAt: saved ? new Date().toISOString() : null,
  }
}
