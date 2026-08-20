"use client"

import * as React from "react"
import { useNavigate } from "react-router-dom"
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  Link2,
  LightbulbIcon,
  Loader2,
  Search,
  Sparkles,
  Tags,
} from "@/components/iconimate"
import { toast } from "sonner"

import { MarkdownPreview } from "@/components/markdown/MarkdownPreview"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  knowledgeBaseWikiAgentApi,
  type KnowledgeBaseWikiPageKind,
  type KnowledgeBaseWikiPageDetailResponse,
  type KnowledgeBaseWikiPageResponse,
} from "@/lib/api"
import { knowledgeBaseArticlePath } from "@/lib/dashboard-routes"
import { cn } from "@/lib/utils"
import { prepareWikiMarkdown } from "@/features/pages/knowledge/knowledge-wiki-markdown"
import {
  filterKnowledgeExplorerPages,
  matchesKnowledgeExplorerQuery,
  resolveDefaultKnowledgeExplorerPage,
  resolveKnowledgeExplorerSection,
  type KnowledgeExplorerSection,
} from "@/features/pages/knowledge/knowledge-explorer-pages"

type KnowledgeFolder = {
  key: string
  name: string
  depth: number
  children: KnowledgeFolder[]
  pages: KnowledgeBaseWikiPageResponse[]
}

type RelatedKnowledge = {
  key: string
  pageKey: string
  title: string
  kind: string | null
  summary: string | null
  relationType: string
  description: string | null
  direction: "out" | "in"
}

const KIND_LABEL: Record<KnowledgeBaseWikiPageKind, string> = {
  index: "Wiki 索引",
  source: "文章摘要",
  entity: "实体",
  concept: "概念",
  comparison: "对比",
  answer: "答案",
  log: "日志",
}

function resolveApiErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "object" && error && "response" in error) {
    const response = (error as { response?: { data?: { msg?: unknown } } }).response
    if (typeof response?.data?.msg === "string" && response.data.msg) return response.data.msg
  }
  return error instanceof Error && error.message ? error.message : fallback
}

function buildKnowledgeFolders(pages: KnowledgeBaseWikiPageResponse[]): KnowledgeFolder[] {
  const roots: KnowledgeFolder[] = []

  for (const page of pages) {
    if (page.archivedAt || (page.kind !== "entity" && page.kind !== "concept")) continue
    const path = page.categoryPath.length > 0 ? page.categoryPath : ["未分类"]
    let siblings = roots
    let parent: KnowledgeFolder | null = null
    for (const [index, name] of path.entries()) {
      const key: string = parent ? `${parent.key}/${name}` : name
      let folder: KnowledgeFolder | undefined = siblings.find((item) => item.key === key)
      if (!folder) {
        folder = { key, name, depth: index, children: [], pages: [] }
        siblings.push(folder)
      }
      parent = folder
      siblings = folder.children
    }
    parent?.pages.push(page)
  }

  const sortFolder = (folder: KnowledgeFolder) => {
    folder.children.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
    folder.pages.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"))
    folder.children.forEach(sortFolder)
  }
  roots.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
  roots.forEach(sortFolder)
  return roots
}

function collectAllFolderKeys(folders: KnowledgeFolder[]) {
  const keys = new Set<string>()
  const walk = (folder: KnowledgeFolder) => {
    keys.add(folder.key)
    folder.children.forEach(walk)
  }
  folders.forEach(walk)
  return keys
}

function countFolderPages(folder: KnowledgeFolder): number {
  return folder.pages.length + folder.children.reduce((sum, child) => sum + countFolderPages(child), 0)
}

function FolderBranch({
  folder,
  expanded,
  selectedPageKey,
  onToggle,
  onSelectPage,
}: {
  folder: KnowledgeFolder
  expanded: Set<string>
  selectedPageKey: string | null
  onToggle: (key: string) => void
  onSelectPage: (page: KnowledgeBaseWikiPageResponse) => void
}) {
  const open = expanded.has(folder.key)
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
        style={{ paddingLeft: `${folder.depth * 12 + 8}px` }}
        aria-expanded={open}
        onClick={() => onToggle(folder.key)}
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {open ? <FolderOpen className="size-4 text-primary" /> : <Folder className="size-4 text-muted-foreground" />}
        <span className={cn("min-w-0 flex-1 truncate", folder.depth === 0 && "font-semibold")}>{folder.name}</span>
        <span className="text-xs text-muted-foreground">{countFolderPages(folder)}</span>
      </button>
      {open ? (
        <div>
          {folder.children.map((child) => (
            <FolderBranch
              key={child.key}
              folder={child}
              expanded={expanded}
              selectedPageKey={selectedPageKey}
              onToggle={onToggle}
              onSelectPage={onSelectPage}
            />
          ))}
          {folder.pages.map((page) => (
            <button
              key={page.pageKey}
              type="button"
              className={cn(
                "flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm hover:bg-accent",
                selectedPageKey === page.pageKey && "bg-primary/10 text-primary",
              )}
              style={{ paddingLeft: `${(folder.depth + 1) * 12 + 14}px` }}
              onClick={() => onSelectPage(page)}
            >
              {page.kind === "entity" ? (
                <Tags className="size-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
              ) : (
                <LightbulbIcon className="size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
              )}
              <span className="truncate">{page.title}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function KnowledgePageRow({
  page,
  selected,
  showSummary = false,
  onSelect,
}: {
  page: KnowledgeBaseWikiPageResponse
  selected: boolean
  showSummary?: boolean
  onSelect: () => void
}) {
  const isIndex = page.kind === "index"
  const isSource = page.kind === "source"

  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent",
        selected && "bg-primary/10 text-primary",
      )}
      onClick={onSelect}
    >
      {isIndex ? (
        <BookOpen className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
      ) : isSource ? (
        <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : (
        <LightbulbIcon className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate", isIndex && "font-semibold")}>{page.title}</span>
        {showSummary && page.summary ? (
          <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-muted-foreground">
            {page.summary}
          </span>
        ) : null}
      </span>
    </button>
  )
}

function formatUpdatedAt(value: string | null | undefined) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function collectRelatedKnowledge(detail: KnowledgeBaseWikiPageDetailResponse): RelatedKnowledge[] {
  const result = [
    ...detail.links.map((link) => ({
      key: `out-${link.id}`,
      pageKey: link.toPageKey,
      title: link.toPageTitle,
      kind: link.toPageKind ?? null,
      summary: link.toPageSummary ?? null,
      relationType: link.linkType,
      description: link.description ?? null,
      direction: "out" as const,
    })),
    ...detail.inLinks
      .filter((link) => Boolean(link.fromPageKey))
      .map((link) => ({
        key: `in-${link.id}`,
        pageKey: link.fromPageKey,
        title: link.fromPageTitle,
        kind: link.fromPageKind ?? null,
        summary: link.fromPageSummary ?? null,
        relationType: link.linkType,
        description: link.description ?? null,
        direction: "in" as const,
      })),
  ]
  const seen = new Set<string>()
  return result.filter((item) => {
    const key = `${item.direction}|${item.pageKey}|${item.relationType}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function KnowledgeExplorerPanel({
  knowledgeBaseId,
}: {
  knowledgeBaseId: string
}) {
  const navigate = useNavigate()
  const [pages, setPages] = React.useState<KnowledgeBaseWikiPageResponse[]>([])
  const [detail, setDetail] = React.useState<KnowledgeBaseWikiPageDetailResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  const [query, setQuery] = React.useState("")
  const [activeSection, setActiveSection] = React.useState<KnowledgeExplorerSection>("knowledge")
  const [history, setHistory] = React.useState<string[]>([])
  const requestRef = React.useRef(0)
  const selectedPageKeyRef = React.useRef<string | null>(null)

  const knowledgePages = React.useMemo(
    () => filterKnowledgeExplorerPages(pages, "knowledge"),
    [pages],
  )
  const summaryPages = React.useMemo(
    () => filterKnowledgeExplorerPages(pages, "summaries"),
    [pages],
  )
  const sectionPages = activeSection === "knowledge" ? knowledgePages : summaryPages
  const visiblePages = React.useMemo(() => {
    return sectionPages.filter((page) => matchesKnowledgeExplorerQuery(page, query))
  }, [query, sectionPages])
  const visibleIndexPages = React.useMemo(
    () => visiblePages.filter((page) => page.kind === "index"),
    [visiblePages],
  )
  const visibleCategorizedPages = React.useMemo(
    () => visiblePages.filter((page) => page.kind === "entity" || page.kind === "concept"),
    [visiblePages],
  )
  const visibleOtherKnowledgePages = React.useMemo(
    () => visiblePages.filter((page) => (
      page.kind !== "index" && page.kind !== "entity" && page.kind !== "concept"
    )),
    [visiblePages],
  )
  const folders = React.useMemo(
    () => buildKnowledgeFolders(visibleCategorizedPages),
    [visibleCategorizedPages],
  )
  const searching = query.trim().length > 0
  const effectiveExpanded = React.useMemo(
    () => (searching ? collectAllFolderKeys(folders) : expanded),
    [searching, folders, expanded],
  )
  const relatedKnowledge = React.useMemo(() => detail ? collectRelatedKnowledge(detail) : [], [detail])

  const selectPageKey = React.useCallback(async (pageKey: string, pushHistory = true) => {
    const previousPageKey = selectedPageKeyRef.current
    if (pushHistory && previousPageKey && previousPageKey !== pageKey) {
      setHistory((current) => [...current, previousPageKey].slice(-30))
    }
    selectedPageKeyRef.current = pageKey
    const requestId = ++requestRef.current
    setDetailLoading(true)
    try {
      const response = await knowledgeBaseWikiAgentApi.pageDetail(knowledgeBaseId, pageKey)
      if (requestId === requestRef.current) {
        setDetail(response.data)
        const nextSection = resolveKnowledgeExplorerSection(response.data)
        if (nextSection) setActiveSection(nextSection)
      }
    } catch (error) {
      if (requestId === requestRef.current) toast.error(resolveApiErrorMessage(error, "知识详情加载失败"))
    } finally {
      if (requestId === requestRef.current) setDetailLoading(false)
    }
  }, [knowledgeBaseId])

  const loadPages = React.useCallback(async () => {
    setHistory([])
    setQuery("")
    setActiveSection("knowledge")
    selectedPageKeyRef.current = null
    setDetail(null)
    setLoading(true)
    try {
      const response = await knowledgeBaseWikiAgentApi.pages(knowledgeBaseId)
      const nextPages = response.data.pages.filter((page) => !page.archivedAt)
      setPages(nextPages)
      setExpanded(new Set())
      const selected = resolveDefaultKnowledgeExplorerPage(nextPages, "knowledge")
      if (selected) await selectPageKey(selected.pageKey, false)
      else {
        requestRef.current += 1
        selectedPageKeyRef.current = null
        setDetail(null)
      }
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "知识空间加载失败"))
      setPages([])
      setDetail(null)
    } finally {
      setLoading(false)
    }
  }, [knowledgeBaseId, selectPageKey])

  const handleSectionChange = React.useCallback((value: string) => {
    const nextSection: KnowledgeExplorerSection = value === "summaries" ? "summaries" : "knowledge"
    setActiveSection(nextSection)
    setQuery("")

    const currentPage = pages.find((page) => page.pageKey === selectedPageKeyRef.current)
    if (currentPage && resolveKnowledgeExplorerSection(currentPage) === nextSection) return

    const nextPage = resolveDefaultKnowledgeExplorerPage(pages, nextSection)
    if (nextPage) {
      void selectPageKey(nextPage.pageKey)
      return
    }

    requestRef.current += 1
    selectedPageKeyRef.current = null
    setDetail(null)
    setDetailLoading(false)
  }, [pages, selectPageKey])

  const goBack = React.useCallback(() => {
    const previous = history.at(-1)
    if (!previous) return
    setHistory((current) => current.slice(0, -1))
    void selectPageKey(previous, false)
  }, [history, selectPageKey])

  const handleMarkdownClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    const anchor = target.closest("a")
    const href = anchor?.getAttribute("href") ?? ""
    if (!href.startsWith("#wiki-page=")) return
    event.preventDefault()
    const pageKey = decodeURIComponent(href.slice("#wiki-page=".length))
    if (pageKey) void selectPageKey(pageKey)
  }, [selectPageKey])

  const openSourceArticle = React.useCallback((articleId: string) => {
    navigate(knowledgeBaseArticlePath(knowledgeBaseId, articleId))
  }, [knowledgeBaseId, navigate])

  React.useEffect(() => {
    const timer = window.setTimeout(() => void loadPages(), 0)
    return () => window.clearTimeout(timer)
  }, [loadPages])

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="grid min-h-[640px] gap-4 lg:h-[calc(100vh-15rem)] lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="flex max-h-[360px] min-h-40 flex-col overflow-hidden rounded-lg border bg-muted/20 lg:max-h-none lg:min-h-0">
          <div className="space-y-3 border-b p-3">
            <Tabs value={activeSection} onValueChange={handleSectionChange}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="knowledge">
                  知识
                  <span className="text-xs text-muted-foreground">{knowledgePages.length}</span>
                </TabsTrigger>
                <TabsTrigger value="summaries">
                  摘要
                  <span className="text-xs text-muted-foreground">{summaryPages.length}</span>
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-9"
                placeholder={activeSection === "knowledge" ? "搜索知识页、概念或别名…" : "搜索文章标题或摘要…"}
                aria-label={activeSection === "knowledge" ? "搜索知识页面" : "搜索文章摘要"}
              />
            </div>
          </div>
          <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
            {loading && pages.length === 0 ? (
              <div className="flex h-full min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                正在加载知识…
              </div>
            ) : sectionPages.length === 0 ? (
              <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
                {activeSection === "knowledge" ? <Sparkles className="size-6" /> : <FileText className="size-6" />}
                <span>
                  {activeSection === "knowledge"
                    ? "暂无知识页面。请先在文章列表点击“构建知识”。"
                    : "暂无文章摘要。完成 Wiki 构建后会显示在这里。"}
                </span>
              </div>
            ) : visiblePages.length === 0 ? (
              <div className="flex h-full min-h-32 items-center justify-center px-4 text-center text-sm text-muted-foreground">
                {activeSection === "knowledge" ? "没有匹配的知识页面。" : "没有匹配的文章摘要。"}
              </div>
            ) : activeSection === "summaries" ? (
              <div className="space-y-1">
                {visiblePages.map((page) => (
                  <KnowledgePageRow
                    key={page.pageKey}
                    page={page}
                    selected={detail?.pageKey === page.pageKey}
                    showSummary
                    onSelect={() => void selectPageKey(page.pageKey)}
                  />
                ))}
              </div>
            ) : (
              <div className="space-y-1">
                {visibleIndexPages.map((page) => (
                  <KnowledgePageRow
                    key={page.pageKey}
                    page={page}
                    selected={detail?.pageKey === page.pageKey}
                    showSummary
                    onSelect={() => void selectPageKey(page.pageKey)}
                  />
                ))}
                {folders.map((folder) => (
                  <FolderBranch
                    key={folder.key}
                    folder={folder}
                    expanded={effectiveExpanded}
                    selectedPageKey={detail?.pageKey ?? null}
                    onToggle={(key) => setExpanded((current) => {
                      const next = new Set(current)
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      return next
                    })}
                    onSelectPage={(page) => void selectPageKey(page.pageKey)}
                  />
                ))}
                {visibleOtherKnowledgePages.length > 0 ? (
                  <div className="pt-2">
                    <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">主题与答案</p>
                    {visibleOtherKnowledgePages.map((page) => (
                      <KnowledgePageRow
                        key={page.pageKey}
                        page={page}
                        selected={detail?.pageKey === page.pageKey}
                        showSummary
                        onSelect={() => void selectPageKey(page.pageKey)}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </aside>

        <section className="app-scrollbar min-h-[420px] overflow-y-auto rounded-lg border bg-card p-4 sm:p-7 lg:min-h-0">
          {!detail ? (
            <div className="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground">
              {activeSection === "knowledge"
                ? "从左侧选择 Wiki 索引或知识页面。"
                : "从左侧选择一篇文章摘要。"}
            </div>
          ) : (
            <>
              <header className="mb-6 border-b pb-5">
                <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn("-ml-2", history.length === 0 && "invisible")}
                    onClick={goBack}
                  >
                    <ArrowLeft className="size-4" />
                    返回
                  </Button>
                  {detail.updatedAt ? (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock className="size-3.5" />
                      {formatUpdatedAt(detail.updatedAt)}
                    </span>
                  ) : null}
                </div>
                <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">{detail.title}</h2>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">
                    {KIND_LABEL[detail.kind] ?? detail.kind}
                  </Badge>
                  <Badge variant="outline">v{detail.version}</Badge>
                  {detail.aliases.map((alias) => <Badge key={alias} variant="outline">{alias}</Badge>)}
                  {detail.categoryPath.map((part) => <Badge key={part} variant="outline">{part}</Badge>)}
                </div>
                {detail.summary ? <p className="mt-4 max-w-4xl text-base leading-7 text-muted-foreground">{detail.summary}</p> : null}
              </header>

              {detailLoading ? (
                <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  正在加载详情…
                </div>
              ) : (
                <>
                  <div onClick={handleMarkdownClick}>
                    <MarkdownPreview
                      value={prepareWikiMarkdown(detail.contentMd, detail.title, relatedKnowledge)}
                      variant="typography"
                    />
                  </div>

                  {relatedKnowledge.length > 0 ? (
                    <section className="mt-8 border-t pt-5">
                      <div className="flex items-center gap-2">
                        <Link2 className="size-4 text-primary" />
                        <h3 className="text-sm font-semibold">相关知识（{relatedKnowledge.length}）</h3>
                      </div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        {relatedKnowledge.map((item) => (
                          <button
                            key={item.key}
                            type="button"
                            className="group rounded-lg border p-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
                            onClick={() => void selectPageKey(item.pageKey)}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <span className="font-medium text-primary group-hover:underline">{item.title}</span>
                              <Badge variant="outline" className="shrink-0 text-[11px]">
                                {item.direction === "out" ? item.relationType : `${item.relationType} · 反向`}
                              </Badge>
                            </div>
                            {item.description || item.summary ? (
                              <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                                {item.description || item.summary}
                              </p>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {detail.sourceRefs.length > 0 ? (
                    <section className="mt-6 border-t pt-5">
                      <p className="text-sm font-semibold">来源文章</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {detail.sourceRefs.map((ref) => (
                          <button
                            key={ref.id}
                            type="button"
                            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-primary transition-colors hover:bg-primary/5 hover:underline"
                            onClick={() => openSourceArticle(ref.articleId)}
                          >
                            {ref.articleTitle}
                            <ExternalLink className="size-3.5" />
                          </button>
                        ))}
                      </div>
                    </section>
                  ) : null}
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
