"use client"

import * as React from "react"
import { CheckCircle2, Eye, FileStack, GitPullRequestArrow, Loader2, RefreshCw, Sparkles, X } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AppPagination } from "@/components/app-pagination"
import { KbDialog } from "@/components/shadcn-studio/dialog/dialog-09"
import {
  knowledgeBaseQaApi,
  knowledgeBaseWikiAgentApi,
  type KnowledgeBaseQaSummary,
  type KnowledgeBaseWikiDashboardResponse,
  type KnowledgeBaseWikiPageDetailResponse,
  type KnowledgeBaseWikiPageKind,
  type KnowledgeBaseWikiPageResponse,
  type KnowledgeBaseWikiPatchResponse,
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

/** 把简化版 unified diff 字符串按行着色渲染 */
function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n")
  return (
    <pre className="app-scrollbar max-h-72 overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-relaxed">
      {lines.map((line, index) => {
        const cls =
          line.startsWith("+") && !line.startsWith("+++")
            ? "text-emerald-600 dark:text-emerald-400"
            : line.startsWith("-") && !line.startsWith("---")
              ? "text-destructive"
              : line.startsWith("@@")
                ? "text-sky-600 dark:text-sky-400"
                : "text-muted-foreground"
        return (
          <div key={index} className={cls}>
            {line || " "}
          </div>
        )
      })}
    </pre>
  )
}

function StatCard({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div className="rounded-lg border px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums", accent && "text-primary")}>{value}</div>
    </div>
  )
}

export function KnowledgeWikiPage() {
  const [knowledgeBases, setKnowledgeBases] = React.useState<KnowledgeBaseQaSummary[]>([])
  const [kbLoading, setKbLoading] = React.useState(true)
  const [selectedKbId, setSelectedKbId] = React.useState<string | null>(null)

  const [dashboard, setDashboard] = React.useState<KnowledgeBaseWikiDashboardResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [ingesting, setIngesting] = React.useState(false)
  const [linting, setLinting] = React.useState(false)
  const [patchBusyId, setPatchBusyId] = React.useState<string | null>(null)

  const [activePatch, setActivePatch] = React.useState<KnowledgeBaseWikiPatchResponse | null>(null)
  const [pageDetail, setPageDetail] = React.useState<KnowledgeBaseWikiPageDetailResponse | null>(null)
  const [pageDetailLoading, setPageDetailLoading] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      setKbLoading(true)
      try {
        const res = await knowledgeBaseQaApi.knowledgeBaseList()
        if (cancelled) return
        const rows = res.data.knowledgeBases || []
        setKnowledgeBases(rows)
        setSelectedKbId((prev) => prev ?? (rows[0]?.id ?? null))
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

  const loadDashboard = React.useCallback(async (knowledgeBaseId: string) => {
    setLoading(true)
    try {
      const res = await knowledgeBaseWikiAgentApi.dashboard(knowledgeBaseId)
      setDashboard(res.data)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "加载 Wiki 仪表盘失败"))
      setDashboard(null)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (selectedKbId) void loadDashboard(selectedKbId)
  }, [selectedKbId, loadDashboard])

  const runIngest = React.useCallback(async () => {
    if (!selectedKbId) return
    setIngesting(true)
    try {
      const res = await knowledgeBaseWikiAgentApi.ingest({ knowledgeBaseId: selectedKbId })
      toast.success(`已生成 ${res.data.pages.length} 个 Wiki 页面`)
      if (res.data.warnings?.length) {
        toast.warning(res.data.warnings[0])
      }
      await loadDashboard(selectedKbId)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "生成 Wiki 失败"))
    } finally {
      setIngesting(false)
    }
  }, [selectedKbId, loadDashboard])

  const runLint = React.useCallback(async () => {
    if (!selectedKbId) return
    setLinting(true)
    try {
      const res = await knowledgeBaseWikiAgentApi.lint(selectedKbId)
      toast.success(`Lint 完成，得分 ${res.data.score}，发现 ${res.data.issueCount} 个问题`)
      await loadDashboard(selectedKbId)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "Lint 检查失败"))
    } finally {
      setLinting(false)
    }
  }, [selectedKbId, loadDashboard])

  const applyPatch = React.useCallback(async (patchId: string) => {
    if (!selectedKbId) return
    setPatchBusyId(patchId)
    try {
      await knowledgeBaseWikiAgentApi.applyPatch(selectedKbId, patchId)
      toast.success("补丁已合并到 Wiki 页面")
      setActivePatch(null)
      await loadDashboard(selectedKbId)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "合并补丁失败"))
    } finally {
      setPatchBusyId(null)
    }
  }, [selectedKbId, loadDashboard])

  const rejectPatch = React.useCallback(async (patchId: string) => {
    if (!selectedKbId) return
    setPatchBusyId(patchId)
    try {
      await knowledgeBaseWikiAgentApi.rejectPatch(selectedKbId, patchId)
      toast.success("补丁已驳回")
      setActivePatch(null)
      await loadDashboard(selectedKbId)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "驳回补丁失败"))
    } finally {
      setPatchBusyId(null)
    }
  }, [selectedKbId, loadDashboard])

  const openPageDetail = React.useCallback(async (page: KnowledgeBaseWikiPageResponse) => {
    if (!selectedKbId) return
    setPageDetailLoading(true)
    setPageDetail({ ...page, sourceRefs: [], links: [] })
    try {
      const res = await knowledgeBaseWikiAgentApi.pageDetail(selectedKbId, page.pageKey)
      setPageDetail(res.data)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "加载页面详情失败"))
    } finally {
      setPageDetailLoading(false)
    }
  }, [selectedKbId])

  const lint = dashboard?.lint
  const pendingPatches = dashboard?.pendingPatches ?? []
  const pages = dashboard?.pages ?? []
  const busy = ingesting || linting

  const PAGE_SIZE = 10
  const [pageIndex, setPageIndex] = React.useState(0)
  const pageCount = Math.max(1, Math.ceil(pages.length / PAGE_SIZE))
  // 切换知识库 / 刷新后把越界页码夹回有效范围
  React.useEffect(() => {
    setPageIndex((current) => Math.min(current, pageCount - 1))
  }, [pageCount])
  const visiblePages = React.useMemo(
    () => pages.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE),
    [pages, pageIndex],
  )

  return (
    <div className="flex w-full flex-col gap-6 px-6 py-6 lg:px-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">知识 Wiki</h1>
          <p className="text-sm text-muted-foreground">
            Agent 在问答中沉淀的结论以补丁形式提交，确认后写入 Wiki，越用越聪明。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={selectedKbId ?? ""} onValueChange={(v) => setSelectedKbId(v)} disabled={kbLoading}>
            <SelectTrigger className="w-52">
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
          <Button variant="outline" onClick={() => selectedKbId && loadDashboard(selectedKbId)} disabled={!selectedKbId || loading}>
            <RefreshCw className={cn("mr-2 size-4", loading && "animate-spin")} />
            刷新
          </Button>
          <Button variant="outline" onClick={() => runLint()} disabled={!selectedKbId || busy}>
            <CheckCircle2 className={cn("mr-2 size-4", linting && "animate-spin")} />
            Lint 检查
          </Button>
          <Button onClick={() => runIngest()} disabled={!selectedKbId || busy}>
            <Sparkles className={cn("mr-2 size-4", ingesting && "animate-spin")} />
            重新生成 Wiki
          </Button>
        </div>
      </div>

      {!selectedKbId && !kbLoading ? (
        <div className="rounded-lg border py-16 text-center text-sm text-muted-foreground">
          还没有知识库，先去「知识库」里创建一个吧。
        </div>
      ) : loading && !dashboard ? (
        <div className="flex items-center justify-center rounded-lg border py-16 text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          加载中…
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard label="Wiki 页面" value={lint?.pageCount ?? pages.length} />
            <StatCard label="页面链接" value={lint?.linkCount ?? 0} />
            <StatCard label="来源引用" value={lint?.sourceRefCount ?? 0} />
            <StatCard label="Lint 得分" value={lint ? lint.score : "-"} />
            <StatCard label="待审批补丁" value={pendingPatches.length} accent={pendingPatches.length > 0} />
          </div>

          {/* 待审批补丁 —— 沉淀回路的核心 */}
          <section className="rounded-lg border">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <GitPullRequestArrow className="size-4 text-primary" />
              <span className="text-sm font-medium">待审批补丁</span>
              {pendingPatches.length > 0 ? (
                <Badge variant="secondary" className="ml-1">{pendingPatches.length}</Badge>
              ) : null}
            </div>
            {pendingPatches.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                暂无待审批补丁。Agent 在问答中发现值得沉淀的结论时会自动提交到这里。
              </div>
            ) : (
              <ul className="divide-y">
                {pendingPatches.map((patch) => (
                  <li key={patch.id} className="flex flex-col gap-2 px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate font-medium">{patch.title}</span>
                        <Badge variant="outline" className="font-mono text-[11px]">{patch.pageKey}</Badge>
                        <Badge
                          className={cn(
                            "text-[11px]",
                            patch.operation === "CREATE"
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                              : "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                          )}
                        >
                          {patch.operation === "CREATE" ? "新建" : "更新"}
                        </Badge>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setActivePatch(patch)}>
                          <Eye className="mr-1 size-4" />
                          查看差异
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={patchBusyId === patch.id}
                          onClick={() => rejectPatch(patch.id)}
                        >
                          <X className="mr-1 size-4" />
                          驳回
                        </Button>
                        <Button
                          size="sm"
                          disabled={patchBusyId === patch.id}
                          onClick={() => applyPatch(patch.id)}
                        >
                          {patchBusyId === patch.id ? (
                            <Loader2 className="mr-1 size-4 animate-spin" />
                          ) : (
                            <CheckCircle2 className="mr-1 size-4" />
                          )}
                          确认合并
                        </Button>
                      </div>
                    </div>
                    {patch.reason ? (
                      <p className="text-xs text-muted-foreground">变更原因：{patch.reason}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Wiki 页面列表 */}
          <section className="rounded-lg border">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <FileStack className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">Wiki 页面</span>
              <Badge variant="secondary" className="ml-1">{pages.length}</Badge>
            </div>
            {pages.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                还没有 Wiki 页面。点右上角「重新生成 Wiki」从知识库文章构建索引。
              </div>
            ) : (
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
            )}
            {pages.length > PAGE_SIZE ? (
              <div className="border-t px-4 py-3">
                <AppPagination
                  page={pageIndex}
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

      {/* 补丁差异弹窗 */}
      <KbDialog
        open={activePatch != null}
        onOpenChange={(next) => {
          if (!next) setActivePatch(null)
        }}
        title={activePatch ? activePatch.title : "补丁差异"}
        description={activePatch ? `${activePatch.pageKey} · ${activePatch.operation === "CREATE" ? "新建" : "更新"}` : undefined}
        contentClassName="sm:max-w-3xl"
        footer={
          activePatch ? (
            <div className="flex w-full items-center justify-end gap-2">
              <Button
                variant="outline"
                disabled={patchBusyId === activePatch.id}
                onClick={() => rejectPatch(activePatch.id)}
              >
                <X className="mr-1 size-4" />
                驳回
              </Button>
              <Button disabled={patchBusyId === activePatch.id} onClick={() => applyPatch(activePatch.id)}>
                {patchBusyId === activePatch.id ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-1 size-4" />
                )}
                确认合并
              </Button>
            </div>
          ) : null
        }
      >
        {activePatch ? (
          <div className="flex flex-col gap-3 px-1 py-1">
            {activePatch.reason ? (
              <p className="text-sm text-muted-foreground">变更原因：{activePatch.reason}</p>
            ) : null}
            <DiffView diff={activePatch.diffText || "（无差异内容）"} />
          </div>
        ) : null}
      </KbDialog>

      {/* 页面详情弹窗 */}
      <KbDialog
        open={pageDetail != null}
        onOpenChange={(next) => {
          if (!next) setPageDetail(null)
        }}
        title={pageDetail ? pageDetail.title : "页面详情"}
        description={pageDetail ? `${pageDetail.pageKey} · ${kindLabel(pageDetail.kind)} · v${pageDetail.version}` : undefined}
        contentClassName="sm:max-w-3xl"
      >
        {pageDetail ? (
          <div className="flex flex-col gap-4 px-1 py-1">
            {pageDetail.summary ? (
              <p className="text-sm text-muted-foreground">{pageDetail.summary}</p>
            ) : null}
            <pre className="app-scrollbar max-h-[40vh] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm leading-relaxed">
              {pageDetail.contentMd}
            </pre>
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
      </KbDialog>
    </div>
  )
}

export default KnowledgeWikiPage
