"use client"

import * as React from "react"
import { useNavigate } from "react-router-dom"
import {
  ArrowLeft,
  BookOpen,
  Clock,
  FileText,
  Folder,
  FolderOpen,
  LightbulbIcon,
  Loader2,
  Search,
  Sparkles,
  Tags,
} from "@/components/iconimate"
import { toast } from "sonner"

import { MarkdownPreview } from "@/components/markdown/MarkdownPreview"
import { wikiScribbleStyle } from "@/components/markdown/wiki-scribble"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { NativeNestedList, type ListItem } from "@/components/uitripled/native-nested-list-shadcnui"
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

type RelatedKnowledgeGroup = {
  label: string
  items: RelatedKnowledge[]
}

/** 出链的 relationType 是模型写的自由文本，常见的几个翻成中文，其余原样显示。 */
const RELATION_LABEL: Record<string, string> = {
  index: "相关知识",
  extracts: "摘录",
  related: "相关",
  mentions: "提及",
  contains: "包含",
  part_of: "属于",
  compares: "对比",
  answers: "解答",
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

const FOLDER_ITEM_PREFIX = "folder:"
const PAGE_ITEM_PREFIX = "page:"

/** 把知识文件夹树摊成 NativeNestedList 的 items：文件夹在前、页面在后。 */
function toKnowledgeListItems(
  folders: KnowledgeFolder[],
  expandedKeys: Set<string>,
  onSelectPage: (page: KnowledgeBaseWikiPageResponse) => void,
): ListItem[] {
  return folders.map((folder) => {
    const open = expandedKeys.has(folder.key)
    return {
      id: `${FOLDER_ITEM_PREFIX}${folder.key}`,
      label: folder.depth === 0 ? <span className="font-semibold">{folder.name}</span> : folder.name,
      icon: open ? (
        <FolderOpen className="size-4 text-yellow-500" />
      ) : (
        <Folder className="size-4 text-blue-500" />
      ),
      hasChildren: folder.children.length > 0 || folder.pages.length > 0,
      trailing: <span className="pr-1 text-xs text-muted-foreground">{countFolderPages(folder)}</span>,
      children: [
        ...toKnowledgeListItems(folder.children, expandedKeys, onSelectPage),
        ...folder.pages.map<ListItem>((page) => ({
          id: `${PAGE_ITEM_PREFIX}${page.pageKey}`,
          label: page.title,
          icon: page.kind === "entity" ? (
            <Tags className="size-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
          ) : (
            <LightbulbIcon className="size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
          ),
          onClick: () => onSelectPage(page),
        })),
      ],
    }
  })
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

function groupRelatedKnowledge(items: RelatedKnowledge[]): RelatedKnowledgeGroup[] {
  const groups = new Map<string, RelatedKnowledgeGroup>()
  for (const item of items) {
    // 出链按关系类型各占一行；入链无论什么关系都收进「被链接」，免得页脚被反向关系拆成一堆小分组
    const label = item.direction === "out"
      ? RELATION_LABEL[item.relationType] ?? item.relationType
      : "被链接"
    const group = groups.get(label)
    if (group) group.items.push(item)
    else groups.set(label, { label, items: [item] })
  }
  return [...groups.values()]
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
  const relatedKnowledgeGroups = React.useMemo(() => groupRelatedKnowledge(relatedKnowledge), [relatedKnowledge])
  // pageKey → 标题，用来把正文里的 [[source-9]] 渲染成真实页面名
  const pageTitleByKey = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const page of pages) map.set(page.pageKey, page.title)
    return map
  }, [pages])
  const resolvePageTitle = React.useCallback(
    (pageKey: string) => pageTitleByKey.get(pageKey),
    [pageTitleByKey],
  )

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

  const folderItems = React.useMemo(
    () => toKnowledgeListItems(folders, effectiveExpanded, (page) => void selectPageKey(page.pageKey)),
    [folders, effectiveExpanded, selectPageKey],
  )
  const expandedItemIds = React.useMemo(() => {
    const next = new Set<string>()
    for (const key of effectiveExpanded) next.add(`${FOLDER_ITEM_PREFIX}${key}`)
    return next
  }, [effectiveExpanded])
  const handleFolderExpandedChange = React.useCallback((id: string, nextExpanded: boolean) => {
    if (!id.startsWith(FOLDER_ITEM_PREFIX)) return
    const key = id.slice(FOLDER_ITEM_PREFIX.length)
    setExpanded((current) => {
      const next = new Set(current)
      if (nextExpanded) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])
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
                {folderItems.length > 0 ? (
                  <NativeNestedList
                    items={folderItems}
                    activeId={detail ? `${PAGE_ITEM_PREFIX}${detail.pageKey}` : undefined}
                    expandedIds={expandedItemIds}
                    onExpandedChange={handleFolderExpandedChange}
                  />
                ) : null}
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
                      value={prepareWikiMarkdown(detail.contentMd, detail.title, relatedKnowledge, resolvePageTitle)}
                      variant="typography"
                    />
                  </div>

                  {relatedKnowledgeGroups.length > 0 || detail.sourceRefs.length > 0 ? (
                    <section className="mt-10 border-t pt-5 text-sm">
                      <dl className="space-y-4">
                        {relatedKnowledgeGroups.map((group) => (
                          <div key={group.label} className="flex flex-col gap-2 sm:flex-row sm:gap-6">
                            <dt className="shrink-0 text-muted-foreground sm:w-20">{group.label}</dt>
                            <dd className="flex min-w-0 flex-wrap gap-x-6 gap-y-3">
                              {group.items.map((item) => (
                                <button
                                  key={item.key}
                                  type="button"
                                  title={item.description || item.summary || undefined}
                                  className="cursor-pointer text-left font-medium text-foreground transition-colors hover:text-primary focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  style={wikiScribbleStyle(item.pageKey)}
                                  onClick={() => void selectPageKey(item.pageKey)}
                                >
                                  {item.title}
                                </button>
                              ))}
                            </dd>
                          </div>
                        ))}
                        {detail.sourceRefs.length > 0 ? (
                          <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
                            <dt className="shrink-0 text-muted-foreground sm:w-20">来源文档</dt>
                            <dd className="flex min-w-0 flex-wrap gap-x-6 gap-y-3">
                              {detail.sourceRefs.map((ref) => (
                                <button
                                  key={ref.id}
                                  type="button"
                                  className="cursor-pointer text-left font-medium text-foreground transition-colors hover:text-primary focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  style={wikiScribbleStyle(ref.articleId)}
                                  onClick={() => openSourceArticle(ref.articleId)}
                                >
                                  {ref.articleTitle}
                                </button>
                              ))}
                            </dd>
                          </div>
                        ) : null}
                      </dl>
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
