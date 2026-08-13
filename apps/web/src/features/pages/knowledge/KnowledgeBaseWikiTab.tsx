"use client"

import * as React from "react"
import { ListTree, Loader2, PanelLeftClose, PanelLeftOpen, RefreshCw, Rows3, Search, Sparkles } from "lucide-react"
import { toast } from "sonner"

import { WikiMarkdown } from "@/components/markdown/WikiMarkdown"
import { WikiDirectory, WikiKindIcon, wikiKindLabel } from "@/features/pages/knowledge/wiki/WikiDirectory"
import { buildWikiGraphData, isWikiGraphFolderId, wikiGraphNodeColor } from "@/features/pages/knowledge/wiki/graph"
import { buildWikiTree, collectFolderIds, filterWikiPages, folderIdsForPage } from "@/features/pages/knowledge/wiki/tree"
import { KnowledgeGraph, KnowledgeGraphControls } from "@/components/ui/knowledge-graph"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  knowledgeBaseWikiAgentApi,
  type KnowledgeBaseResponse,
  type KnowledgeBaseWikiGraphEdge,
  type KnowledgeBaseWikiDocumentRef,
  type KnowledgeBaseWikiGraphNode,
  type KnowledgeBaseWikiIngestJob,
  type KnowledgeBaseWikiPageDetailResponse,
  type KnowledgeBaseWikiPageResponse,
} from "@/lib/api"
import { knowledgeBasePath } from "@/lib/dashboard-routes"
import { cn } from "@/lib/utils"

function errorMessage(error: unknown, fallback: string) {
  return (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
    (error instanceof Error ? error.message : fallback)
}

function jobProgress(job: KnowledgeBaseWikiIngestJob) {
  if (job.status === "pending" || job.phase === "queued") {
    return { label: "等待处理", detail: "上传批次正在合并，任务会在后台自动开始", current: 0, total: Math.max(job.totalDocuments, 1) }
  }
  if (job.phase === "mapping") {
    return { label: "抽取页面候选与证据", detail: job.currentDocument || "正在读取文档分片", current: job.processedDocuments, total: Math.max(job.totalDocuments, 1) }
  }
  if (job.phase === "applying") {
    return { label: "写入文档贡献", detail: job.currentDocument || "正在关联证据分片", current: job.processedDocuments, total: Math.max(job.totalDocuments, 1) }
  }
  if (job.phase === "reducing") {
    return { label: "汇总 Wiki 页面", detail: job.currentDocument || "正在合并多文档内容", current: job.processedPages, total: Math.max(job.totalPages, 1) }
  }
  if (job.phase === "organizing") {
    return { label: "规划 Wiki 目录", detail: "正在把页面归入目录树", current: 1, total: 1 }
  }
  if (job.phase === "finalizing") {
    return { label: "生成双链与索引", detail: "正在整理页面之间的引用关系", current: 1, total: 1 }
  }
  return { label: "正在构建", detail: job.currentDocument || "后台任务运行中", current: job.processedDocuments, total: Math.max(job.totalDocuments, 1) }
}

function WikiGraphLegend() {
  const items: Array<[string, string]> = [["index", "索引"], ["summary", "摘要"], ["entity", "实体"], ["concept", "概念"]]
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-background/85 px-2.5 py-1.5 text-xs shadow-sm backdrop-blur">
      {items.map(([kind, label]) => (
        <span key={kind} className="flex items-center gap-1.5 text-muted-foreground">
          <span className="size-2 rounded-full" style={{ background: wikiGraphNodeColor(kind) }} />
          {label}
        </span>
      ))}
      <span className="text-muted-foreground/70">灰色节点为目录</span>
    </div>
  )
}

export function KnowledgeBaseWikiTab({
  knowledgeBase,
  onChanged,
  mode = "browser",
  selectedPageKey,
  onOpenPage,
}: {
  knowledgeBase: KnowledgeBaseResponse
  onChanged: () => Promise<void>
  mode?: "browser" | "links"
  selectedPageKey?: string | null
  onOpenPage?: (pageKey: string) => void
}) {
  const [pages, setPages] = React.useState<KnowledgeBaseWikiPageResponse[]>([])
  const [nodes, setNodes] = React.useState<KnowledgeBaseWikiGraphNode[]>([])
  const [edges, setEdges] = React.useState<KnowledgeBaseWikiGraphEdge[]>([])
  const [selected, setSelected] = React.useState<KnowledgeBaseWikiPageDetailResponse | null>(null)
  const [search, setSearch] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [building, setBuilding] = React.useState(false)
  const [activeJob, setActiveJob] = React.useState<KnowledgeBaseWikiIngestJob | null>(null)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [directoryCollapsed, setDirectoryCollapsed] = React.useState(false)
  const [directoryView, setDirectoryView] = React.useState<"tree" | "list">("tree")
  const [directoryTab, setDirectoryTab] = React.useState<"knowledge" | "summary">("knowledge")
  const [expandedFolders, setExpandedFolders] = React.useState<ReadonlySet<string>>(() => new Set())

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const [pageResponse, graphResponse] = await Promise.all([
        knowledgeBaseWikiAgentApi.pages(knowledgeBase.id),
        knowledgeBaseWikiAgentApi.graph(knowledgeBase.id),
      ])
      setPages(pageResponse.data.pages)
      setNodes(graphResponse.data.nodes)
      setEdges(graphResponse.data.edges)
      const first = pageResponse.data.pages.find((page) => page.pageKey === selectedPageKey) ?? pageResponse.data.pages.find((page) => page.kind === "index") ?? pageResponse.data.pages[0]
      if (first) {
        const detail = await knowledgeBaseWikiAgentApi.pageDetail(knowledgeBase.id, first.pageKey)
        setSelected(detail.data)
      } else {
        setSelected(null)
      }
    } catch (error) {
      toast.error(errorMessage(error, "加载 Wiki 失败"))
    } finally {
      setLoading(false)
    }
  }, [knowledgeBase.id, selectedPageKey])

  React.useEffect(() => {
    void load()
  }, [load])

  const pollJob = React.useCallback(async (jobId?: string) => {
    const response = await knowledgeBaseWikiAgentApi.ingestStatus(knowledgeBase.id, jobId)
    const job = response.data.job
    setActiveJob(job)
    setBuilding(job?.status === "pending" || job?.status === "running")
    return job
  }, [knowledgeBase.id])

  React.useEffect(() => {
    void pollJob().catch(() => undefined)
  }, [pollJob])

  React.useEffect(() => {
    if (!building || !activeJob) return
    const timer = window.setInterval(() => {
      void pollJob(activeJob.jobId).then(async (job) => {
        if (!job || job.status === "pending" || job.status === "running") return
        window.clearInterval(timer)
        if (job.status === "completed") {
          if (job.warnings.length > 0) toast.warning(job.warnings.join("；"))
          toast.success(`Wiki 已从 ${job.processedDocuments} 个文档完成构建`)
          await Promise.all([load(), onChanged()])
        } else {
          toast.error(job.error || "Wiki 构建失败")
        }
      }).catch(() => undefined)
    }, 2000)
    return () => window.clearInterval(timer)
  }, [activeJob, building, load, onChanged, pollJob])

  const openPage = React.useCallback(async (pageKey: string) => {
    setDetailLoading(true)
    try {
      const response = await knowledgeBaseWikiAgentApi.pageDetail(knowledgeBase.id, pageKey)
      setSelected(response.data)
    } catch (error) {
      toast.error(errorMessage(error, "加载 Wiki 页面失败"))
    } finally {
      setDetailLoading(false)
    }
  }, [knowledgeBase.id])

  const buildWiki = React.useCallback(async () => {
    setBuilding(true)
    try {
      const response = await knowledgeBaseWikiAgentApi.documentIngest({ knowledgeBaseId: knowledgeBase.id, forceRebuild: true })
      setActiveJob(response.data)
      toast.success("Wiki 构建任务已提交")
    } catch (error) {
      toast.error(errorMessage(error, "Wiki 构建失败"))
      setBuilding(false)
    }
  }, [knowledgeBase.id])

  const filteredPages = React.useMemo(() => filterWikiPages(pages, search), [pages, search])
  // 索引页固定置顶；实体/概念进"知识"目录树；每个文档一页的摘要单独一档。
  const indexPages = React.useMemo(() => filteredPages.filter((page) => page.kind === "index"), [filteredPages])
  const knowledgePages = React.useMemo(() => filteredPages.filter((page) => page.kind === "entity" || page.kind === "concept"), [filteredPages])
  const summaryPages = React.useMemo(() => filteredPages.filter((page) => page.kind === "summary"), [filteredPages])
  const tree = React.useMemo(() => buildWikiTree(knowledgePages), [knowledgePages])
  const pageTitles = React.useMemo(() => new Map(pages.map((page) => [page.pageKey, page.title])), [pages])
  const resolveWikiTitle = React.useCallback((pageKey: string) => pageTitles.get(pageKey), [pageTitles])

  // 目录默认全部折叠：页面一多，展开的树会长到需要反复滚动，先看清顶层分类再往下钻更省力。
  // 下面两个副作用负责在需要时自动展开：搜索命中、以及跳转到某个页面。

  // 搜索时把命中页面所在的目录全部展开，否则结果会藏在折叠的目录里。
  React.useEffect(() => {
    if (!search.trim()) return
    setExpandedFolders((current) => new Set([...current, ...collectFolderIds(tree)]))
  }, [search, tree])

  // 从图谱或双链跳转过来时，自动展开到目标页面所在的目录。
  React.useEffect(() => {
    const ancestors = folderIdsForPage(pages.find((page) => page.pageKey === selected?.pageKey))
    if (ancestors.length === 0) return
    setExpandedFolders((current) => {
      if (ancestors.every((id) => current.has(id))) return current
      return new Set([...current, ...ancestors])
    })
  }, [pages, selected?.pageKey])

  const toggleFolder = React.useCallback((folderId: string) => {
    setExpandedFolders((current) => {
      const next = new Set(current)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }, [])

  const backlinks = React.useMemo(() => {
    if (!selected) return []
    const byKey = new Map(nodes.map((node) => [node.pageKey, node]))
    return edges.filter((edge) => edge.target === selected.pageKey).map((edge) => byKey.get(edge.source)).filter((node): node is KnowledgeBaseWikiGraphNode => Boolean(node))
  }, [edges, nodes, selected])

  const categoryPaths = React.useMemo(() => new Map(pages.map((page) => [page.pageKey, page.categoryPath ?? []])), [pages])
  const graphData = React.useMemo(
    () => buildWikiGraphData(knowledgeBase.name, nodes, edges, categoryPaths),
    [categoryPaths, edges, knowledgeBase.name, nodes],
  )
  const openGraphPage = React.useCallback((pageKey: string) => {
    // 目录节点只是层级容器，没有对应的 Wiki 正文，点击时忽略。
    if (isWikiGraphFolderId(pageKey)) return
    if (onOpenPage) {
      onOpenPage(pageKey)
      return
    }
    void openPage(pageKey)
  }, [onOpenPage, openPage])
  const openDocumentRef = React.useCallback((documentId: string, chunkIndexes: number[]) => {
    const params = new URLSearchParams({ tab: "documents", documentId, chunk: String(chunkIndexes[0] ?? 0) })
    window.location.assign(`${knowledgeBasePath(knowledgeBase.id)}?${params.toString()}`)
  }, [knowledgeBase.id])

  if (loading) return <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />正在加载 Wiki…</div>

  if (mode === "links") {
    return (
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-between pb-3">
          <div><h2 className="text-sm font-semibold">Wiki 页面双链</h2><p className="mt-1 text-xs text-muted-foreground">展示页面之间的引用关系，不构建实体知识图谱。</p></div>
          <BuildButton pages={pages} building={building} disabled={knowledgeBase.documentCount === 0} onClick={() => void buildWiki()} />
        </div>
        {nodes.length === 0 ? <WikiEmpty building={building} disabled={knowledgeBase.documentCount === 0} onBuild={() => void buildWiki()} /> : <div className="relative min-h-0 flex-1 overflow-hidden border-t bg-background"><WikiGraphLegend /><KnowledgeGraph data={graphData} onNodeClick={openGraphPage}><KnowledgeGraphControls /></KnowledgeGraph></div>}
      </section>
    )
  }

  if (pages.length === 0) {
    return <section className="flex min-h-0 flex-1 flex-col"><div className="flex justify-end pb-3"><BuildButton pages={pages} building={building} disabled={knowledgeBase.documentCount === 0} onClick={() => void buildWiki()} /></div><WikiEmpty building={building} disabled={knowledgeBase.documentCount === 0} onBuild={() => void buildWiki()} /></section>
  }

  return (
    <section className="flex min-h-0 flex-1 overflow-hidden">
      <aside className={cn("hidden min-h-0 shrink-0 flex-col border-r pr-3 lg:flex", directoryCollapsed ? "w-11" : "w-[268px]")}>
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 px-1">
          {!directoryCollapsed ? <span className="text-sm font-semibold">Wiki 目录</span> : null}
          <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={() => setDirectoryCollapsed((value) => !value)} aria-label={directoryCollapsed ? "展开目录" : "收起目录"}>{directoryCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}</Button>
        </div>
        {!directoryCollapsed ? (
          <>
            <div className="relative my-2">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 Wiki 页面…" className="h-9 border-transparent bg-muted/70 pl-9 shadow-none" />
            </div>
            {indexPages.map((page) => (
              <button
                key={page.id}
                type="button"
                className={cn("mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm font-medium", selected?.pageKey === page.pageKey ? "bg-muted text-primary" : "hover:bg-muted/70")}
                onClick={() => void openPage(page.pageKey)}
              >
                <WikiKindIcon kind="index" />
                <span className="min-w-0 flex-1 truncate">{page.title}</span>
              </button>
            ))}

            {/* 摘要是"每个文档一页"，知识是从文档里抽出的实体与概念——两种东西按不同方式浏览，混在一棵树里会互相淹没。 */}
            <div className="flex shrink-0 items-center gap-3 border-b pb-1.5">
              <DirectoryTab label="知识" count={knowledgePages.length} active={directoryTab === "knowledge"} onClick={() => setDirectoryTab("knowledge")} />
              <DirectoryTab label="摘要" count={summaryPages.length} active={directoryTab === "summary"} onClick={() => setDirectoryTab("summary")} />
              {directoryTab === "knowledge" ? (
                <div className="ml-auto flex items-center rounded-md border p-0.5">
                  <Button variant={directoryView === "tree" ? "secondary" : "ghost"} size="icon-sm" className="size-6" aria-label="目录树" aria-pressed={directoryView === "tree"} onClick={() => setDirectoryView("tree")}><ListTree className="size-3.5" /></Button>
                  <Button variant={directoryView === "list" ? "secondary" : "ghost"} size="icon-sm" className="size-6" aria-label="平铺列表" aria-pressed={directoryView === "list"} onClick={() => setDirectoryView("list")}><Rows3 className="size-3.5" /></Button>
                </div>
              ) : null}
            </div>

            <ScrollArea className="min-h-0 flex-1 pt-1">
              {directoryTab === "knowledge" && directoryView === "tree" ? (
                <WikiDirectory
                  nodes={tree}
                  selectedPageKey={selected?.pageKey}
                  expandedFolders={expandedFolders}
                  onToggleFolder={toggleFolder}
                  onSelectPage={(page) => void openPage(page.pageKey)}
                />
              ) : (
                <nav className="space-y-0.5 pr-1">
                  {(directoryTab === "knowledge" ? knowledgePages : summaryPages).map((page) => (
                    <button key={page.id} type="button" title={page.title} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm", selected?.pageKey === page.pageKey ? "bg-muted text-primary" : "hover:bg-muted/70")} onClick={() => void openPage(page.pageKey)}>
                      <WikiKindIcon kind={page.kind} />
                      <span className="min-w-0 flex-1 truncate">{page.title}</span>
                      {directoryTab === "knowledge" ? <span className="text-[10px] text-muted-foreground">{wikiKindLabel(page.kind)}</span> : null}
                    </button>
                  ))}
                  {(directoryTab === "knowledge" ? knowledgePages : summaryPages).length === 0 ? (
                    <p className="px-2 py-6 text-center text-xs text-muted-foreground">没有匹配的页面</p>
                  ) : null}
                </nav>
              )}
            </ScrollArea>
          </>
        ) : null}
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:pl-4">
        <div className="flex shrink-0 items-center justify-between border-b pb-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              {selected ? <WikiKindIcon kind={selected.kind} /> : null}
              <h2 className="truncate text-base font-semibold">{selected?.title ?? "Wiki"}</h2>
              {selected ? <Badge variant="secondary" className="shrink-0 text-[10px]">{wikiKindLabel(selected.kind)}</Badge> : null}
            </div>
            {selected?.categoryPath?.length ? <p className="mt-1 truncate text-xs text-muted-foreground">{selected.categoryPath.join(" / ")}</p> : null}
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{selected?.summary || "由知识库文件与分片生成"}</p>
          </div>
          <BuildButton pages={pages} building={building} disabled={knowledgeBase.documentCount === 0} onClick={() => void buildWiki()} />
        </div>
        {!knowledgeBase.wikiEnabled ? <div className="my-3 shrink-0 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">当前知识库未启用自动 Wiki，仍可手动构建。</div> : null}
        {building && activeJob ? <WikiJobProgress job={activeJob} /> : null}
        <div className="min-h-0 flex-1 overflow-hidden">
          {detailLoading ? <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin" /></div> : selected ? (
            <ScrollArea className="h-full">
              <article className="mx-auto max-w-4xl px-4 py-6 sm:px-8">
                <WikiMarkdown value={selected.contentMd} className="max-w-none" resolveTitle={resolveWikiTitle} onOpenPage={(pageKey) => void openPage(pageKey)} />
                <WikiPageFooter
                  backlinks={backlinks}
                  documentRefs={selected.documentRefs}
                  onOpenPage={(pageKey) => void openPage(pageKey)}
                  onOpenDocument={openDocumentRef}
                />
              </article>
            </ScrollArea>
          ) : null}
        </div>
      </main>
    </section>
  )
}

function BuildButton({ pages, building, disabled, onClick }: { pages: KnowledgeBaseWikiPageResponse[]; building: boolean; disabled: boolean; onClick: () => void }) {
  return <Button size="sm" className="shrink-0" disabled={building || disabled} onClick={onClick}>{building ? <Loader2 className="size-4 animate-spin" /> : pages.length ? <RefreshCw className="size-4" /> : <Sparkles className="size-4" />}{pages.length ? "重建 Wiki" : "从文件构建"}</Button>
}

function WikiJobProgress({ job }: { job: KnowledgeBaseWikiIngestJob }) {
  const progress = jobProgress(job)
  const percentage = Math.max(2, Math.min(100, Math.round(progress.current / progress.total * 100)))
  return <div className="my-3 shrink-0 rounded-lg border border-primary/15 bg-primary/5 px-3 py-3 text-xs"><div className="flex items-center gap-2"><Loader2 className="size-3.5 animate-spin text-primary" /><span className="font-medium text-foreground">{progress.label}</span><span className="ml-auto tabular-nums text-muted-foreground">{progress.current}/{progress.total}</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-primary/10"><div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${percentage}%` }} /></div><p className="mt-2 truncate text-muted-foreground" title={progress.detail}>{progress.detail}</p></div>
}

function WikiEmpty({ building, disabled, onBuild }: { building: boolean; disabled: boolean; onBuild: () => void }) {
  return <div className="flex min-h-0 flex-1 items-center justify-center border-t"><div className="max-w-md px-6 text-center"><Sparkles className="mx-auto size-10 text-primary/50" /><h3 className="mt-4 text-base font-semibold">还没有 Wiki 页面</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">上传文件后，系统会生成文档摘要、实体页、概念页，并把每页精确关联到证据分片。</p><Button className="mt-5" disabled={building || disabled} onClick={onBuild}>{building ? "正在构建…" : "开始构建"}</Button></div></div>
}

/** 侧栏分档按钮：显示名称与数量，当前档位加下划线强调。 */
function DirectoryTab({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "-mb-[7px] border-b-2 pb-1.5 text-sm transition-colors",
        active ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
    >
      {label} <span className="text-xs tabular-nums">{count}</span>
    </button>
  )
}

/**
 * 正文末尾的关系脚注：哪些页面引用了本页，以及本页的证据来自哪些文件。
 *
 * 放在正文里而不是右侧独立面板——面板在窄屏会被整体隐藏，等于这些信息在
 * 笔记本屏幕上根本看不到。脚注跟着正文走，任何宽度都在。
 * 出链不在这里重复：它们已经作为高亮链接出现在正文中了。
 */
function WikiPageFooter({
  backlinks,
  documentRefs,
  onOpenPage,
  onOpenDocument,
}: {
  backlinks: KnowledgeBaseWikiGraphNode[]
  documentRefs?: KnowledgeBaseWikiDocumentRef[]
  onOpenPage: (pageKey: string) => void
  onOpenDocument: (documentId: string, chunkIndexes: number[]) => void
}) {
  const refs = documentRefs ?? []
  if (backlinks.length === 0 && refs.length === 0) return null
  return (
    <footer className="mt-10 space-y-2 border-t pt-4 text-sm">
      {backlinks.length > 0 ? (
        <FooterRow label="被链接">
          {backlinks.map((node) => (
            <WikiFooterLink key={node.pageKey} title={node.title} onClick={() => onOpenPage(node.pageKey)} />
          ))}
        </FooterRow>
      ) : null}
      {refs.length > 0 ? (
        <FooterRow label="来源文档">
          {refs.map((ref) => (
            <WikiFooterLink
              key={ref.id}
              title={ref.documentTitle || ref.fileName}
              hint={`${ref.chunkIndexes.length} 个分片 · 查看原文`}
              onClick={() => onOpenDocument(ref.documentId, ref.chunkIndexes)}
            />
          ))}
        </FooterRow>
      ) : null}
    </footer>
  )
}

function FooterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-5 gap-y-2">{children}</span>
    </div>
  )
}

/** 与正文内双链一致的样式，让"可点"这件事在整页保持同一种视觉语言。 */
function WikiFooterLink({ title, hint, onClick }: { title: string; hint?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={hint ? `${title} · ${hint}` : title}
      className="max-w-full truncate font-medium text-primary underline decoration-dashed decoration-primary/60 underline-offset-4 transition-colors hover:decoration-solid hover:text-primary/80"
      onClick={onClick}
    >
      {title}
    </button>
  )
}
