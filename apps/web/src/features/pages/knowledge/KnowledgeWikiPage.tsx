"use client"

import * as React from "react"
import { BookOpen, CheckCircle2, Eye, FileStack, Link2, ListTree, Loader2, RefreshCw, RotateCcw, Sparkles, Wand2 } from "@/components/iconimate"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { MarkdownPreview } from "@/components/markdown/MarkdownPreview"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AppPagination } from "@/components/app-pagination"
import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import {
  knowledgeBaseNodeApi,
  knowledgeBaseQaApi,
  knowledgeBaseWikiAgentApi,
  type KnowledgeBaseQaSummary,
  type KnowledgeBaseTreeNode,
  type KnowledgeBaseWikiDashboardResponse,
  type KnowledgeBaseWikiPageDetailResponse,
  type KnowledgeBaseWikiPageKind,
  type KnowledgeBaseWikiPageResponse,
  type KnowledgeBaseWikiTreeNode,
} from "@/lib/api"

const KIND_LABEL: Record<KnowledgeBaseWikiPageKind, string> = {
  index: "索引",
  source: "源文档",
  concept: "概念",
  entity: "实体",
  comparison: "对比",
  answer: "问答",
  log: "日志",
}

const SEVERITY_META: Record<string, { label: string; className: string }> = {
  error: { label: "错误", className: "bg-destructive/10 text-destructive" },
  warning: { label: "警告", className: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  info: { label: "提示", className: "bg-sky-500/10 text-sky-600 dark:text-sky-400" },
}

const EMPTY_WIKI_PAGES: KnowledgeBaseWikiPageResponse[] = []

function resolveApiErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error && "response" in error) {
    const response = (error as { response?: { data?: { msg?: unknown } } }).response
    const apiMsg = response?.data?.msg
    if (typeof apiMsg === "string" && apiMsg) return apiMsg
  }
  if (error instanceof Error && error.message) return error.message
  return fallback
}

function formatDateTime(value?: string | null) {
  if (!value) return "-"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function kindLabel(kind: KnowledgeBaseWikiPageKind) {
  return KIND_LABEL[kind] ?? kind
}

/** 从 `source-<id>` 形式的 pageKey 解析出文章 ID；非源文档页返回 null。 */
function articleIdFromPageKey(pageKey: string): string | null {
  const match = pageKey.match(/^source-(\d+)$/)
  return match ? match[1] : null
}

/** 深度遍历知识库目录树，收集全部文章 ID 及标题映射 */
function collectArticleIds(roots: KnowledgeBaseTreeNode[], titles: Map<string, string>): string[] {
  const ids: string[] = []
  const visit = (node: KnowledgeBaseTreeNode) => {
    if (node.articleId) {
      ids.push(node.articleId)
      titles.set(node.articleId, node.name)
    }
    for (const child of node.children ?? []) visit(child)
  }
  for (const root of roots) visit(root)
  return ids
}

type IngestProgress = { done: number; total: number }

function formatIngestProgress(progress: IngestProgress | null) {
  return progress && progress.total > 0 ? ` (${progress.done}/${progress.total})` : ""
}

/** PageIndex 式文档目录树：把扁平节点按 depth 缩进渲染成层级大纲。 */
function WikiTreeOutline({ nodes }: { nodes: KnowledgeBaseWikiTreeNode[] }) {
  if (nodes.length === 0) {
    return <p className="text-xs text-muted-foreground">该文档暂无目录树节点，重新生成 Wiki 后会自动构建。</p>
  }
  return (
    <ul className="app-scrollbar max-h-[32vh] space-y-0.5 overflow-auto rounded-md border bg-muted/20 p-2">
      {nodes.map((node) => (
        <li
          key={node.nodeKey}
          className="rounded px-2 py-1 hover:bg-accent/60"
          style={{ paddingLeft: `${Math.min(node.depth, 6) * 14 + 8}px` }}
        >
          <div className="flex items-baseline gap-2">
            <span className={cn("truncate text-sm", node.depth === 0 ? "font-semibold" : "font-medium")}>
              {node.title}
            </span>
            {node.tokenEstimate > 0 ? (
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">~{node.tokenEstimate} tok</span>
            ) : null}
          </div>
          {node.summary ? (
            <p className="truncate text-xs text-muted-foreground">{node.summary}</p>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: React.ReactNode
  detail: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-card/60 p-4 shadow-sm shadow-black/[0.02]">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span className="flex size-7 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-3.5" />
        </span>
        {label}
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  )
}

export function KnowledgeWikiPage() {
  const [knowledgeBases, setKnowledgeBases] = React.useState<KnowledgeBaseQaSummary[]>([])
  const [kbLoading, setKbLoading] = React.useState(true)
  const [selectedKbId, setSelectedKbId] = React.useState<string | null>(null)

  const [dashboard, setDashboard] = React.useState<KnowledgeBaseWikiDashboardResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [dashboardError, setDashboardError] = React.useState<string | null>(null)
  const [ingesting, setIngesting] = React.useState(false)
  const [fullRebuilding, setFullRebuilding] = React.useState(false)
  const [ingestProgress, setIngestProgress] = React.useState<IngestProgress | null>(null)
  const [fullRebuildOpen, setFullRebuildOpen] = React.useState(false)
  const [linting, setLinting] = React.useState(false)
  const [embedding, setEmbedding] = React.useState(false)

  const [pageDetail, setPageDetail] = React.useState<KnowledgeBaseWikiPageDetailResponse | null>(null)
  const [pageDetailLoading, setPageDetailLoading] = React.useState(false)
  const [treeNodes, setTreeNodes] = React.useState<KnowledgeBaseWikiTreeNode[]>([])
  const [treeLoading, setTreeLoading] = React.useState(false)
  const dashboardRequestRef = React.useRef(0)
  const pageDetailRequestRef = React.useRef(0)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      setKbLoading(true)
      try {
        const res = await knowledgeBaseQaApi.knowledgeBaseList()
        if (cancelled) return
        const rows = res.data.knowledgeBases || []
        setKnowledgeBases(rows)
        setSelectedKbId((prev) => rows.some((kb) => kb.id === prev) ? prev : (rows[0]?.id ?? null))
      } catch (error) {
        if (!cancelled) toast.error(resolveApiErrorMessage(error, "加载知识库列表失败"))
      } finally {
        if (!cancelled) setKbLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const loadDashboard = React.useCallback(async (knowledgeBaseId: string, options: { reset?: boolean } = {}) => {
    const requestId = ++dashboardRequestRef.current
    if (options.reset) setDashboard(null)
    setLoading(true)
    setDashboardError(null)
    try {
      const res = await knowledgeBaseWikiAgentApi.dashboard(knowledgeBaseId)
      if (requestId !== dashboardRequestRef.current) return
      setDashboard(res.data)
    } catch (error) {
      if (requestId !== dashboardRequestRef.current) return
      const message = resolveApiErrorMessage(error, "加载 Wiki 概览失败")
      toast.error(message)
      setDashboardError(message)
      setDashboard(null)
    } finally {
      if (requestId === dashboardRequestRef.current) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (!selectedKbId) return
    let cancelled = false
    void (async () => {
      await Promise.resolve()
      if (!cancelled) await loadDashboard(selectedKbId, { reset: true })
    })()
    return () => {
      cancelled = true
      dashboardRequestRef.current += 1
    }
  }, [selectedKbId, loadDashboard])

  /**
   * 编译 Wiki。默认增量（命中缓存的文章跳过模型调用），
   * fullRebuild 为 true 时先清空该知识库的全部 Wiki 再从零编译。
   *
   * Serverless 函数有硬时长上限（Hobby 计划 300s），整库一次性编译文章一多必然超时，
   * 因此改为前端逐篇驱动：每篇文章单独请求（缓存命中时只是轻量数据库操作，很快），
   * 全部完成后收尾调用一次统一重建索引页、清理孤儿页并补写目录树向量。
   */
  const runIngest = React.useCallback(async (options: { fullRebuild?: boolean } = {}) => {
    if (!selectedKbId) return
    const fullRebuild = Boolean(options.fullRebuild)
    const setBusy = fullRebuild ? setFullRebuilding : setIngesting
    setBusy(true)
    setIngestProgress(null)
    try {
      let purgedPageCount: number | null = null
      if (fullRebuild) {
        const purgeRes = await knowledgeBaseWikiAgentApi.ingest({ knowledgeBaseId: selectedKbId, purgeOnly: true })
        purgedPageCount = purgeRes.data.purged?.pageCount ?? 0
      }

      const titles = new Map<string, string>()
      const treeRes = await knowledgeBaseNodeApi.tree(selectedKbId)
      const articleIds = collectArticleIds(treeRes.data.roots ?? [], titles)

      const failures: string[] = []
      for (let index = 0; index < articleIds.length; index += 1) {
        const articleId = articleIds[index]
        setIngestProgress({ done: index + 1, total: articleIds.length })
        try {
          await knowledgeBaseWikiAgentApi.ingest({
            knowledgeBaseId: selectedKbId,
            articleIds: [articleId],
            embed: false,
          })
        } catch (error) {
          const title = titles.get(articleId) ?? `#${articleId}`
          failures.push(`《${title}》编译失败：${resolveApiErrorMessage(error, "未知错误")}`)
        }
      }

      // 收尾：重建索引页、清理失去源文章的孤儿页并统一补写向量。
      // 完全重建且知识库没有文章时跳过（服务端会因无可编译内容报错）。
      let pageCount = 0
      let finalWarnings: string[] = []
      if (articleIds.length > 0 || !fullRebuild) {
        const res = await knowledgeBaseWikiAgentApi.ingest({ knowledgeBaseId: selectedKbId })
        pageCount = res.data.pages.length
        finalWarnings = res.data.warnings ?? []
      }

      const prefix = purgedPageCount != null ? `已清空 ${purgedPageCount} 个旧页面，` : ""
      if (failures.length > 0) {
        toast.warning(`${prefix}编译完成：${articleIds.length - failures.length}/${articleIds.length} 篇成功，${failures[0]}`)
      } else {
        toast.success(`${prefix}已生成 ${pageCount} 个 Wiki 页面`)
      }
      if (!failures.length && finalWarnings.length) {
        toast.warning(finalWarnings[0])
      }
      setFullRebuildOpen(false)
      await loadDashboard(selectedKbId)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, fullRebuild ? "完全重建 Wiki 失败" : "生成 Wiki 失败"))
    } finally {
      setBusy(false)
      setIngestProgress(null)
    }
  }, [selectedKbId, loadDashboard])

  const runEmbed = React.useCallback(async () => {
    if (!selectedKbId) return
    setEmbedding(true)
    try {
      const res = await knowledgeBaseWikiAgentApi.embedWiki(selectedKbId)
      const { embedded, embeddedChunks, embeddedQuestions, pending } = res.data
      if (embedded === 0 && pending === 0) {
        toast.success("所有分片与推荐问题均已向量化")
      } else if (pending > 0) {
        toast.success(`已生成 ${embeddedChunks} 个分片向量、${embeddedQuestions} 个问题向量，还剩 ${pending} 个`)
      } else {
        toast.success(`已生成 ${embeddedChunks} 个分片向量、${embeddedQuestions} 个问题向量，全部完成`)
      }
      await loadDashboard(selectedKbId)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "生成向量失败"))
    } finally {
      setEmbedding(false)
    }
  }, [selectedKbId, loadDashboard])

  const runLint = React.useCallback(async () => {
    if (!selectedKbId) return
    setLinting(true)
    try {
      const res = await knowledgeBaseWikiAgentApi.lint(selectedKbId)
      toast.success(`结构检查完成，得分 ${res.data.score}，发现 ${res.data.issueCount} 个问题`)
      setDashboard((current) => current ? { ...current, lint: res.data } : current)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "结构检查失败"))
    } finally {
      setLinting(false)
    }
  }, [selectedKbId])

  const openPageDetail = React.useCallback(async (page: KnowledgeBaseWikiPageResponse) => {
    if (!selectedKbId) return
    const requestId = ++pageDetailRequestRef.current
    setPageDetailLoading(true)
    setPageDetail({ ...page, sourceRefs: [], links: [], inLinks: [] })
    const articleId = articleIdFromPageKey(page.pageKey)
    setTreeNodes([])
    setTreeLoading(articleId != null)
    const detailRequest = knowledgeBaseWikiAgentApi.pageDetail(selectedKbId, page.pageKey)
    const treeRequest = articleId != null
      ? knowledgeBaseWikiAgentApi.tree(selectedKbId, articleId)
      : null
    try {
      const res = await detailRequest
      if (requestId === pageDetailRequestRef.current) setPageDetail(res.data)
    } catch (error) {
      if (requestId === pageDetailRequestRef.current) {
        toast.error(resolveApiErrorMessage(error, "加载页面详情失败"))
      }
    } finally {
      if (requestId === pageDetailRequestRef.current) setPageDetailLoading(false)
    }
    // 源文档页才有对应的目录树，按 articleId 拉取层级大纲。
    if (treeRequest) {
      try {
        const treeRes = await treeRequest
        if (requestId === pageDetailRequestRef.current) setTreeNodes(treeRes.data.nodes)
      } catch {
        if (requestId === pageDetailRequestRef.current) setTreeNodes([])
      } finally {
        if (requestId === pageDetailRequestRef.current) setTreeLoading(false)
      }
    }
  }, [selectedKbId])

  const closePageDetail = React.useCallback(() => {
    pageDetailRequestRef.current += 1
    setPageDetail(null)
    setPageDetailLoading(false)
    setTreeLoading(false)
  }, [])

  const lint = dashboard?.lint
  const pages = dashboard?.pages ?? EMPTY_WIKI_PAGES
  const busy = ingesting || linting || embedding || fullRebuilding
  const embeddingStatus = dashboard?.embedding

  const PAGE_SIZE = 10
  const [pageIndex, setPageIndex] = React.useState(0)
  const pageCount = Math.max(1, Math.ceil(pages.length / PAGE_SIZE))
  const safePageIndex = Math.min(pageIndex, pageCount - 1)
  const visiblePages = React.useMemo(
    () => pages.slice(safePageIndex * PAGE_SIZE, safePageIndex * PAGE_SIZE + PAGE_SIZE),
    [pages, safePageIndex],
  )

  return (
    <div className="flex w-full flex-col gap-5 px-4 py-6 sm:px-6 lg:px-10">
      <header className="relative overflow-hidden rounded-2xl border border-border/70 bg-gradient-to-br from-primary/[0.08] via-card to-card p-5 sm:p-6">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-30 [mask-image:radial-gradient(ellipse_at_top_right,black,transparent_65%)]"
          style={{
            backgroundImage: "linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
            backgroundSize: "32px 32px",
          }}
        />
        <div className="relative flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <BookOpen className="size-5" />
              </span>
              <div>
                <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">知识 Wiki</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  将知识库编译为适合检索的结构化知识层，统一管理目录、引用与质量。
                </p>
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select
            value={selectedKbId ?? ""}
            onValueChange={(value) => {
              setPageIndex(0)
              closePageDetail()
              setSelectedKbId(value)
            }}
            disabled={kbLoading}
          >
            <SelectTrigger className="w-full bg-background/80 sm:w-56">
              <SelectValue placeholder={kbLoading ? "加载中…" : "选择知识库"} />
            </SelectTrigger>
            <SelectContent>
              {knowledgeBases.map((kb) => (
                <SelectItem key={kb.id} value={kb.id}>
                  {kb.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button className="sm:min-w-28" onClick={() => runIngest()} disabled={!selectedKbId || busy}>
            <Sparkles className={cn("mr-2 size-4", ingesting && "animate-spin")} />
            {ingesting ? `更新中${formatIngestProgress(ingestProgress)}…` : "更新 Wiki"}
          </Button>
          </div>
        </div>

        <div className="relative mt-5 flex flex-col gap-3 border-t border-border/60 pt-4 lg:flex-row lg:items-center lg:justify-between">
          <p className="text-xs text-muted-foreground">
            默认仅更新有变化的文章；编译按文章逐篇分批执行，避免单次请求超出部署平台的时长上限。
          </p>
          <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" className="bg-background/70" onClick={() => selectedKbId && loadDashboard(selectedKbId)} disabled={!selectedKbId || loading}>
            <RefreshCw className={cn("mr-1.5 size-3.5", loading && "animate-spin")} />
            刷新
          </Button>
          <Button size="sm" variant="outline" className="bg-background/70" onClick={() => runLint()} disabled={!selectedKbId || busy}>
            <CheckCircle2 className={cn("mr-1.5 size-3.5", linting && "animate-spin")} />
            结构检查
          </Button>
          {embeddingStatus?.supported ? (
            <Button
              size="sm"
              variant="outline"
              className="bg-background/70"
              onClick={() => runEmbed()}
              disabled={!selectedKbId || busy || embeddingStatus.total === 0 || embeddingStatus.pending === 0}
              title={
                embeddingStatus.total === 0
                  ? "请先在文章上执行“构建知识”，再生成分片与问题向量"
                  : embeddingStatus.pending === 0
                    ? "所有分片与推荐问题均已向量化"
                    : `先补齐分片向量，再为对应推荐问题生成向量（剩余 ${embeddingStatus.pending} 条）`
              }
            >
              <Wand2 className={cn("mr-1.5 size-3.5", embedding && "animate-spin")} />
              {embeddingStatus.pending === 0 && embeddingStatus.total > 0
                ? "向量已就绪"
                : embedding
                  ? "生成中…"
                  : `生成向量${embeddingStatus.pending > 0 ? ` (${embeddingStatus.pending})` : ""}`}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setFullRebuildOpen(true)}
            disabled={!selectedKbId || busy}
            title="清空当前知识库的全部 Wiki 页面与目录树，再从源文章从零编译"
          >
            <RotateCcw className={cn("mr-2 size-4", fullRebuilding && "animate-spin")} />
            {fullRebuilding ? `重建中${formatIngestProgress(ingestProgress)}…` : "完全重建"}
          </Button>
          </div>
        </div>
      </header>

      {!selectedKbId && !kbLoading ? (
        <div className="rounded-lg border py-16 text-center text-sm text-muted-foreground">
          还没有知识库，先去「知识库」里创建一个吧。
        </div>
      ) : loading && !dashboard ? (
        <div className="flex items-center justify-center rounded-lg border py-16 text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          加载中…
        </div>
      ) : dashboardError && !dashboard ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-10 text-center">
          <p className="text-sm font-medium">Wiki 概览加载失败</p>
          <p className="mt-1 text-sm text-muted-foreground">{dashboardError}</p>
          <Button className="mt-4" size="sm" variant="outline" onClick={() => selectedKbId && loadDashboard(selectedKbId)}>
            <RefreshCw className="mr-1.5 size-3.5" />
            重新加载
          </Button>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              icon={FileStack}
              label="Wiki 页面"
              value={lint?.pageCount ?? pages.length}
              detail="已编译的知识页面"
            />
            <StatCard
              icon={ListTree}
              label="文章分片索引"
              value={dashboard?.chunkCount ?? 0}
              detail={embeddingStatus?.supported
                ? `分片 ${embeddingStatus.chunk.embedded}/${embeddingStatus.chunk.total} · 问题 ${embeddingStatus.question.embedded}/${embeddingStatus.question.total}`
                : "分片与推荐问题的混合检索入口"}
            />
            <StatCard
              icon={Link2}
              label="知识关联"
              value={(lint?.linkCount ?? 0) + (lint?.sourceRefCount ?? 0)}
              detail={`${lint?.linkCount ?? 0} 条链接 · ${lint?.sourceRefCount ?? 0} 个来源`}
            />
            <StatCard
              icon={CheckCircle2}
              label="结构质量"
              value={lint ? lint.score : "-"}
              detail={lint ? `${lint.issueCount} 个待处理问题` : "尚未完成检查"}
            />
          </div>

          {/* Wiki 页面列表 */}
          <section className="overflow-hidden rounded-xl border border-border/70 bg-card/50">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3.5 sm:px-5">
              <div className="flex items-center gap-2">
                <FileStack className="size-4 text-primary" />
                <span className="text-sm font-medium">Wiki 页面</span>
                <Badge variant="secondary">{pages.length}</Badge>
              </div>
              <span className="text-xs text-muted-foreground">点击页面查看正文、目录与引用</span>
            </div>
            {pages.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                还没有 Wiki 页面。点右上角「更新 Wiki」从知识库文章构建索引。
              </div>
            ) : (
              <>
              <ul className="divide-y md:hidden">
                {visiblePages.map((page) => (
                  <li key={page.id}>
                    <button
                      type="button"
                      className="flex w-full items-start justify-between gap-3 px-4 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={() => openPageDetail(page)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{page.title}</span>
                        {page.summary ? (
                          <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">{page.summary}</span>
                        ) : null}
                        <span className="mt-2 flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="text-[10px]">{kindLabel(page.kind)}</Badge>
                          <span className="text-[11px] text-muted-foreground">v{page.version}</span>
                          <span className="text-[11px] text-muted-foreground">{formatDateTime(page.updatedAt)}</span>
                        </span>
                      </span>
                      <Eye className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto md:block">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>标题</TableHead>
                    <TableHead className="w-40">页面 Key</TableHead>
                    <TableHead className="w-24">类型</TableHead>
                    <TableHead className="w-20 text-right">版本</TableHead>
                    <TableHead className="w-44">更新时间</TableHead>
                    <TableHead className="w-16 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visiblePages.map((page) => (
                    <TableRow key={page.id}>
                      <TableCell className="font-medium">{page.title}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{page.pageKey}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[11px]">{kindLabel(page.kind)}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">v{page.version}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(page.updatedAt)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8 text-muted-foreground hover:text-foreground"
                          title="查看页面"
                          onClick={() => openPageDetail(page)}
                        >
                          <Eye className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
              </>
            )}
            {pages.length > PAGE_SIZE ? (
              <div className="border-t px-4 py-3">
                <AppPagination
                  page={safePageIndex}
                  totalPages={pageCount}
                  total={pages.length}
                  pageSize={PAGE_SIZE}
                  onChange={(nextPageIndex) => setPageIndex(nextPageIndex)}
                />
              </div>
            ) : null}
          </section>

          {/* Lint 问题 */}
          {lint && lint.issues.length > 0 ? (
            <section className="rounded-lg border">
              <div className="border-b px-4 py-3 text-sm font-medium">
                Lint 问题（{lint.issues.length}）
              </div>
              <ul className="divide-y">
                {lint.issues.map((issue, index) => {
                  const meta = SEVERITY_META[issue.severity] ?? SEVERITY_META.info
                  return (
                    <li key={`${issue.code}-${issue.pageKey}-${index}`} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                      <Badge className={cn("text-[11px]", meta.className)}>{meta.label}</Badge>
                      <span className="font-mono text-xs text-muted-foreground">{issue.pageKey}</span>
                      <span className="text-muted-foreground">{issue.message}</span>
                    </li>
                  )
                })}
              </ul>
            </section>
          ) : null}
        </>
      )}

      {/* 完全重建确认弹窗 —— 破坏性操作，必须显式确认 */}
      <ModalShell
        open={fullRebuildOpen}
        onOpenChange={(next) => {
          if (!next && fullRebuilding) return
          setFullRebuildOpen(next)
        }}
        disableClose={fullRebuilding}
        title="确认完全重建 Wiki？"
        description={`将清空「${knowledgeBases.find((kb) => kb.id === selectedKbId)?.name ?? "当前知识库"}」下的全部 Wiki 数据，再从源文章从零编译。`}
        footer={
          <>
            <Button type="button" variant="secondary" disabled={fullRebuilding} onClick={() => setFullRebuildOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!selectedKbId || fullRebuilding}
              onClick={() => runIngest({ fullRebuild: true })}
            >
              {fullRebuilding ? (
                <Loader2 className="mr-1 size-4 animate-spin" />
              ) : (
                <RotateCcw className="mr-1 size-4" />
              )}
              {fullRebuilding ? `重建中${formatIngestProgress(ingestProgress)}…` : "确认完全重建"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 px-1 py-1 text-sm text-muted-foreground">
          <p>会被删除的内容：</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>全部 Wiki 页面，包含索引页、源文档页及其衍生知识页（共 {pages.length} 个）</li>
            <li>全部页面链接与来源引用</li>
            <li>全部文档目录树节点及其向量（共 {dashboard?.treeNodeCount ?? 0} 个，重建后需要重新生成向量）</li>
          </ul>
          <p>会被保留的内容：源文章本身、问答历史与事件日志。</p>
          <p className="text-destructive">此操作不可撤销，且会重新调用模型编译所有文章，可能产生较多耗时与费用。</p>
        </div>
      </ModalShell>

      {/* 页面详情弹窗 */}
      <ModalShell
        open={pageDetail != null}
        onOpenChange={(next) => {
          if (!next) closePageDetail()
        }}
        title={pageDetail ? pageDetail.title : "页面详情"}
        description={pageDetail ? `${pageDetail.pageKey} · ${kindLabel(pageDetail.kind)} · v${pageDetail.version}` : undefined}
        contentClassName="sm:max-w-4xl"
      >
        {pageDetail ? (
          <div className="flex flex-col gap-4 px-1 py-1">
            {pageDetail.summary ? (
              <p className="text-sm text-muted-foreground">{pageDetail.summary}</p>
            ) : null}
            <div className="app-scrollbar max-h-[48vh] overflow-auto rounded-lg border bg-background p-4 sm:p-5">
              <MarkdownPreview
                value={pageDetail.contentMd}
                className="[&_h1]:!mt-0 [&_h1]:!text-2xl [&_h2]:!mt-8 [&_h2]:!text-xl [&_h3]:!mt-6 [&_h3]:!text-lg"
              />
            </div>
            {articleIdFromPageKey(pageDetail.pageKey) != null ? (
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <ListTree className="size-3.5" />
                  文档目录树
                  {treeNodes.length > 0 ? <span className="tabular-nums">（{treeNodes.length}）</span> : null}
                </div>
                {treeLoading ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    加载目录树…
                  </div>
                ) : (
                  <WikiTreeOutline nodes={treeNodes} />
                )}
              </div>
            ) : null}
            {pageDetailLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                加载来源与链接…
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">来源引用（{pageDetail.sourceRefs.length}）</div>
                  {pageDetail.sourceRefs.length === 0 ? (
                    <p className="text-xs text-muted-foreground">无</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {pageDetail.sourceRefs.map((ref) => (
                        <li key={ref.id} className="truncate">· {ref.articleTitle}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">关联页面（{pageDetail.links.length}）</div>
                  {pageDetail.links.length === 0 ? (
                    <p className="text-xs text-muted-foreground">无</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {pageDetail.links.map((link) => (
                        <li key={link.id} className="truncate font-mono text-xs">
                          {link.toPageKey}
                          <span className="ml-1 text-muted-foreground">({link.linkType})</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </ModalShell>
    </div>
  )
}

export default KnowledgeWikiPage
