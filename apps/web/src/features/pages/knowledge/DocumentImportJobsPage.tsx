"use client"

import * as React from "react"
import { useNavigate, useParams } from "react-router-dom"
import type { ColumnDef, PaginationState, RowSelectionState, SortingState } from "@tanstack/react-table"
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import {
  ArrowLeft,
  ChevronDownIcon,
  ChevronUpIcon,
  Eye,
  Loader2,
  RefreshCw,
  Trash2,
} from "@/components/iconimate"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AppPagination } from "@/components/app-pagination"
import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import {
  importJobDetailPath,
  knowledgeBasePath,
} from "@/lib/dashboard-routes"
import {
  documentImportApi,
  type DocumentImportJobResponse,
} from "@/lib/api"
import {
  StatusBadge,
  STATUS_META,
  isJobActive,
  formatDateTime,
  resolveApiErrorMessage,
  resolveTargetText,
} from "@/features/pages/knowledge/document-import-job-shared"
import { DocumentImportMethods, DocumentImportProgress } from "./document-import-job-components"

export function DocumentImportJobsPage() {
  const { knowledgeBaseId: routeKnowledgeBaseId } = useParams<{ knowledgeBaseId: string }>()
  return <DocumentImportJobsTable key={routeKnowledgeBaseId ?? "all"} routeKnowledgeBaseId={routeKnowledgeBaseId} />
}

function DocumentImportJobsTable({ routeKnowledgeBaseId }: { routeKnowledgeBaseId?: string }) {
  const navigate = useNavigate()
  const [jobs, setJobs] = React.useState<DocumentImportJobResponse[]>([])
  const [total, setTotal] = React.useState(0)
  const [loading, setLoading] = React.useState(false)
  const [pagination, setPagination] = React.useState<PaginationState>({ pageIndex: 0, pageSize: 10 })
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({})
  const [keyword, setKeyword] = React.useState("")
  const [statusFilter, setStatusFilter] = React.useState("all")
  const { pageIndex, pageSize } = pagination
  const scope = React.useMemo(() => ({
    query: { knowledgeBaseId: routeKnowledgeBaseId, pageNum: pageIndex + 1, pageSize },
    active: false, request: 0,
  }), [routeKnowledgeBaseId, pageIndex, pageSize])
  React.useLayoutEffect(() => {
    scope.active = true
    setJobs([])
    setRowSelection({})
    return () => { scope.active = false; scope.request += 1 }
  }, [scope])

  const fetchJobs = React.useCallback(async () => {
    if (!scope.active) return
    const request = ++scope.request
    const isCurrent = () => scope.active && request === scope.request
    setLoading(true)
    try {
      const res = await documentImportApi.list(scope.query)
      if (!isCurrent()) return
      setTotal(res.data.total)
      const lastPage = Math.max(0, Math.ceil(res.data.total / pageSize) - 1)
      if (pageIndex > lastPage) setPagination((current) => ({ ...current, pageIndex: lastPage }))
      else setJobs(res.data.rows || [])
    } catch (error) {
      if (isCurrent()) toast.error(resolveApiErrorMessage(error, "加载导入任务失败"))
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [pageIndex, pageSize, scope])

  React.useEffect(() => {
    void (async () => {
      await fetchJobs()
    })()
  }, [fetchJobs])

  const openDetail = React.useCallback((jobId: string) => {
    navigate(importJobDetailPath(jobId))
  }, [navigate])

  React.useEffect(() => {
    if (!jobs.some(isJobActive)) {
      return
    }
    const timer = window.setInterval(() => {
      void fetchJobs()
    }, 4000)
    return () => window.clearInterval(timer)
  }, [jobs, fetchJobs])

  const [sorting, setSorting] = React.useState<SortingState>([{ id: "createdAt", desc: true }])
  const filteredJobs = React.useMemo(() => {
    const query = keyword.trim().toLocaleLowerCase()
    return jobs.filter((job) => (statusFilter === "all" || job.status === statusFilter)
      && (!query || `${job.title} ${job.fileName}`.toLocaleLowerCase().includes(query)))
  }, [jobs, keyword, statusFilter])
  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)

  const columns = React.useMemo<ColumnDef<DocumentImportJobResponse>[]>(() => [
    {
      id: "select",
      size: 36,
      enableSorting: false,
      header: ({ table }) => (
        <Checkbox
          checked={
            table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && "indeterminate")
          }
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
          aria-label="全选"
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          aria-label="选择该行"
        />
      ),
    },
    {
      header: "文章标题",
      accessorKey: "title",
      cell: ({ row }) => {
        const job = row.original
        return (
          <div className="min-w-0">
            <div className="truncate font-medium">{job.title}</div>
            <div className="truncate text-xs text-muted-foreground">
              {job.sourceType.toUpperCase()} · {job.fileName}
            </div>
          </div>
        )
      },
    },
    {
      header: "导入到",
      id: "target",
      accessorFn: (job) => resolveTargetText(job),
      enableSorting: false,
      cell: ({ row }) => (
        <span className="truncate text-sm text-muted-foreground">{resolveTargetText(row.original)}</span>
      ),
    },
    {
      header: "进度",
      id: "progress",
      enableSorting: false,
      cell: ({ row }) => <div className="w-48 max-w-full"><DocumentImportProgress job={row.original} /></div>,
    },
    {
      header: "识别来源",
      id: "methods",
      enableSorting: false,
      cell: ({ row }) => <div className="w-60 max-w-full"><DocumentImportMethods job={row.original} /></div>,
    },
    {
      header: "状态",
      accessorKey: "status",
      cell: ({ row }) => <StatusBadge job={row.original} />,
    },
    {
      header: "创建时间",
      accessorKey: "createdAt",
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(row.original.createdAt)}</span>
      ),
    },
    {
      header: () => <span className="sr-only">操作</span>,
      id: "actions",
      size: 56,
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <Button
            size="icon"
            variant="ghost"
            className="size-8 text-muted-foreground hover:text-foreground"
            title="查看详情"
            onClick={() => openDetail(row.original.id)}
          >
            <Eye className="size-4" />
          </Button>
        </div>
      ),
    },
  ], [openDetail])

  const table = useReactTable({
    data: filteredJobs,
    columns,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    enableSortingRemoval: false,
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    manualPagination: true,
    rowCount: total,
    onPaginationChange: setPagination,
    state: { sorting, pagination, rowSelection },
  })

  const selectedIds = React.useMemo(
    () => Object.keys(rowSelection).filter((id) => rowSelection[id]),
    [rowSelection],
  )

  const deleteSelected = React.useCallback(async () => {
    if (selectedIds.length === 0) return
    setDeleting(true)
    try {
      await documentImportApi.deleteMany({ ids: selectedIds })
      toast.success(`已删除 ${selectedIds.length} 个任务`)
      setRowSelection({})
      setDeleteConfirmOpen(false)
      await fetchJobs()
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "删除失败"))
    } finally {
      setDeleting(false)
    }
  }, [selectedIds, fetchJobs])

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-10">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">文档导入任务</h1>
          <p className="text-sm text-muted-foreground">查看自己已提交的文档，在详情中重试失败步骤。自动重试耗尽的任务也会进入管理员死信队列。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selectedIds.length > 0 ? (
            <Button
              variant="destructive"
              onClick={() => setDeleteConfirmOpen(true)}
              disabled={deleting}
            >
              <Trash2 className="mr-2 size-4" />
              删除所选（{selectedIds.length}）
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => fetchJobs()} disabled={loading}>
            <RefreshCw className={cn("mr-2 size-4", loading && "animate-spin")} />
            刷新
          </Button>
          {routeKnowledgeBaseId ? (
            <Button
              variant="outline"
              onClick={() => navigate(knowledgeBasePath(routeKnowledgeBaseId))}
            >
              <ArrowLeft className="mr-2 size-4" />
              返回知识库
            </Button>
          ) : null}
        </div>
      </div>

      <div className="w-full space-y-4">
        <div className="flex flex-wrap gap-2">
          <Input className="w-full sm:w-72" aria-label="筛选当前页标题或文件名" placeholder="筛选当前页标题或文件名" value={keyword} onChange={(event) => { setKeyword(event.target.value); setRowSelection({}) }} />
          <Select value={statusFilter} onValueChange={(value) => { setStatusFilter(value); setRowSelection({}) }}>
            <SelectTrigger className="w-48" aria-label="筛选当前页状态"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">当前页全部状态</SelectItem>{Object.entries(STATUS_META).map(([value, meta]) => <SelectItem key={value} value={value}>{meta.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">筛选与排序仅作用于当前页（匹配 {filteredJobs.length} / {jobs.length} 条）；下方总数为全部任务，可翻页继续查找及进入详情重试。</p>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} className="hover:bg-transparent">
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id} style={{ width: header.getSize() ? `${header.getSize()}px` : undefined }} className="h-11">
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <button
                          type="button"
                          className="flex h-full cursor-pointer items-center gap-2 select-none"
                          onClick={header.column.getToggleSortingHandler()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault()
                              header.column.getToggleSortingHandler()?.(e)
                            }
                          }}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {{
                            asc: <ChevronUpIcon className="shrink-0 opacity-60" size={16} aria-hidden="true" />,
                            desc: <ChevronDownIcon className="shrink-0 opacity-60" size={16} aria-hidden="true" />,
                          }[header.column.getIsSorted() as string] ?? null}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {loading && jobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="size-4 animate-spin" />
                      加载中…
                    </span>
                  </TableCell>
                </TableRow>
              ) : table.getRowModel().rows.length ? (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                    {jobs.length > 0 ? "当前页无匹配任务，可清除筛选或翻页查找" : "暂无导入任务"}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <AppPagination
          page={table.getState().pagination.pageIndex}
          totalPages={Math.max(1, table.getPageCount())}
          total={total}
          disabled={loading || deleting}
          pageSize={table.getState().pagination.pageSize}
          onChange={(nextPageIndex) => table.setPageIndex(nextPageIndex)}
        />
      </div>

      <ModalShell
        open={deleteConfirmOpen}
        onOpenChange={(next) => {
          if (deleting) return
          setDeleteConfirmOpen(next)
        }}
        title="删除导入任务"
        description={`确定删除选中的 ${selectedIds.length} 个导入任务吗？此操作不可撤销。`}
        disableClose={deleting}
        contentClassName="sm:max-w-md"
        footer={
          <div className="flex w-full items-center justify-end gap-2">
            <Button variant="outline" disabled={deleting} onClick={() => setDeleteConfirmOpen(false)}>
              取消
            </Button>
            <Button variant="destructive" disabled={deleting} onClick={() => deleteSelected()}>
              {deleting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Trash2 className="mr-2 size-4" />}
              删除
            </Button>
          </div>
        }
      >
        <p className="px-1 py-1 text-sm text-muted-foreground">
          删除后任务及其页面识别记录将被移除；已经生成的文章不会被删除。
        </p>
      </ModalShell>
    </div>
  )
}

export default DocumentImportJobsPage
