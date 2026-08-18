"use client"

import * as React from "react"
import { FileText, MoreHorizontal } from "@/components/iconimate"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { AppPagination } from "@/components/app-pagination"
import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { ActionMenu } from "@/components/petrichor-ui/action-menu"
import { notify } from "@/components/petrichor-ui/notify"
import { Button } from "@/components/ui/button"
import {
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  BookDescription,
  BookHeader,
  BookTitle,
  ModernBookCover,
} from "@/cuicui/other/books/modern-book-cover/modern-book-cover"
import { docLibraryApi, type DocDeleteResponse, type DocLibrary } from "@/lib/api"
import { docLibraryBrowsePath } from "@/lib/dashboard-routes"
import { cn } from "@/lib/utils"

const BOOK_COLORS = [
  "neutral",
  "amber",
  "blue",
  "emerald",
  "violet",
  "rose",
  "sky",
  "orange",
] as const

type BookColor = (typeof BOOK_COLORS)[number]

function pickBookColor(id: string): BookColor {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  }
  return BOOK_COLORS[hash % BOOK_COLORS.length]
}

function resolveApiErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error && "response" in error) {
    const response = (error as { response?: { data?: { msg?: unknown } } }).response
    const apiMsg = response?.data?.msg
    if (typeof apiMsg === "string" && apiMsg) {
      return apiMsg
    }
  }
  if (error instanceof Error && error.message) return error.message
  return fallback
}

function toastDeleteResult(result: DocDeleteResponse, successMessage: string) {
  const failedCount = result.storageCleanup.failedObjectKeys.length
  if (failedCount > 0) {
    toast.warning(`${successMessage}，但有 ${failedCount} 个远程文件清理失败`)
    return
  }
  toast.success(successMessage)
}

function DocLibraryCard({
  library,
  onClick,
  onEdit,
  onDelete,
}: {
  library: DocLibrary
  onClick: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div
      className={cn(
        "group cursor-pointer outline-hidden rounded-xl transform-gpu transition-transform hover:scale-[1.02]",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      )}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.currentTarget !== event.target) return
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        onClick()
      }}
    >
      <ModernBookCover size="sm" color={pickBookColor(library.id)} className="w-min">
        <BookHeader className="w-full items-start justify-between gap-3">
          <FileText size={20} className="shrink-0 text-white/90" />
          <ActionMenu
            trigger={
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-8 w-8 shrink-0 text-white/80",
                  "hover:bg-white/10 hover:text-white",
                  "focus-visible:ring-2 focus-visible:ring-white/30",
                )}
                aria-label="更多操作"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            }
            align="end"
          >
            <DropdownMenuItem
              onClick={() => {
                void navigator.clipboard.writeText(library.id)
                  .then(() => notify("已复制文档库 ID"))
                  .catch(() => toast.error("复制失败"))
              }}
            >
              复制 ID
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onEdit}>编辑</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              删除
            </DropdownMenuItem>
          </ActionMenu>
        </BookHeader>

        <BookTitle className="line-clamp-2 text-lg">{library.name}</BookTitle>
        <BookDescription className="line-clamp-2 min-h-[2.5rem]">
          {library.description || "暂无描述"}
        </BookDescription>
        <div className="mt-3 flex items-center justify-between gap-3 text-[11px] opacity-70 select-none">
          <span>{library.documentCount} 个文件</span>
          <span>更新于 {new Date(library.updatedAt).toLocaleDateString()}</span>
        </div>
      </ModernBookCover>
    </div>
  )
}

export function DocLibraryListPage() {
  const navigate = useNavigate()
  const [libraries, setLibraries] = React.useState<DocLibrary[]>([])
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [pageIndex, setPageIndex] = React.useState(0)
  const [pageSize] = React.useState(12)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [dialogMode, setDialogMode] = React.useState<"create" | "edit">("create")
  const [activeLibrary, setActiveLibrary] = React.useState<DocLibrary | null>(null)
  const [libraryName, setLibraryName] = React.useState("")
  const [libraryDescription, setLibraryDescription] = React.useState("")
  const [deleteOpen, setDeleteOpen] = React.useState(false)

  const total = libraries.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const currentPageIndex = Math.min(pageIndex, totalPages - 1)
  const visibleLibraries = React.useMemo(
    () => libraries.slice(currentPageIndex * pageSize, currentPageIndex * pageSize + pageSize),
    [currentPageIndex, libraries, pageSize],
  )

  const fetchData = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await docLibraryApi.listLibraries()
      setLibraries(res.data.libraries)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "加载文档库失败"))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void fetchData()
    })
    return () => {
      cancelled = true
    }
  }, [fetchData])

  const handlePageChange = React.useCallback(
    (nextPageIndex: number) => {
      if (nextPageIndex < 0 || nextPageIndex >= totalPages) return
      setPageIndex(nextPageIndex)
    },
    [totalPages],
  )

  const openCreate = React.useCallback(() => {
    setDialogMode("create")
    setActiveLibrary(null)
    setLibraryName("")
    setLibraryDescription("")
    setDialogOpen(true)
  }, [])

  const openEdit = React.useCallback((library: DocLibrary) => {
    setDialogMode("edit")
    setActiveLibrary(library)
    setLibraryName(library.name || "")
    setLibraryDescription(library.description || "")
    setDialogOpen(true)
  }, [])

  const submitLibrary = React.useCallback(async () => {
    const name = libraryName.trim()
    const description = libraryDescription.trim()
    if (!name) {
      toast.error("文档库名称不能为空")
      return
    }
    if (saving) return

    setSaving(true)
    try {
      await docLibraryApi.saveLibrary({
        id: dialogMode === "edit" ? activeLibrary?.id : null,
        name,
        description: description ? description : null,
      })
      toast.success(dialogMode === "create" ? "文档库已创建" : "文档库已更新")
      setDialogOpen(false)
      await fetchData()
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "保存失败"))
    } finally {
      setSaving(false)
    }
  }, [activeLibrary, dialogMode, fetchData, libraryDescription, libraryName, saving])

  const confirmDelete = React.useCallback(async () => {
    if (!activeLibrary) return
    if (saving) return

    setSaving(true)
    try {
      const response = await docLibraryApi.deleteLibrary(activeLibrary.id)
      toastDeleteResult(response.data, "文档库已删除")
      setDeleteOpen(false)
      setDialogOpen(false)
      await fetchData()
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "删除失败"))
    } finally {
      setSaving(false)
    }
  }, [activeLibrary, fetchData, saving])

  return (
    <div className="w-full p-4 lg:p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">文档库</h1>
        <Button onClick={openCreate}>新建文档库</Button>
      </div>

      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <span className="text-muted-foreground">加载中...</span>
        </div>
      ) : visibleLibraries.length === 0 ? (
        <div className="flex h-64 items-center justify-center">
          <span className="text-muted-foreground">暂无数据</span>
        </div>
      ) : (
        <div className="grid justify-items-center gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visibleLibraries.map((library) => (
            <DocLibraryCard
              key={library.id}
              library={library}
              onClick={() => navigate(docLibraryBrowsePath(library.id))}
              onEdit={() => openEdit(library)}
              onDelete={() => {
                setActiveLibrary(library)
                setDeleteOpen(true)
              }}
            />
          ))}
        </div>
      )}

      <div className="mt-4 py-3">
        <AppPagination
          page={currentPageIndex}
          totalPages={totalPages}
          total={total}
          pageSize={pageSize}
          onChange={handlePageChange}
        />
      </div>

      <ModalShell
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open && saving) return
          setDialogOpen(open)
        }}
        disableClose={saving}
        title={dialogMode === "create" ? "新建文档库" : "编辑文档库"}
        description={
          dialogMode === "create"
            ? "创建一个新的文档库，用于归档原始文件并进行问答。"
            : "修改文档库的名称与描述。"
        }
        footer={
          <>
            {dialogMode === "edit" ? (
              <Button
                type="button"
                variant="destructive"
                disabled={saving || !activeLibrary}
                onClick={() => setDeleteOpen(true)}
              >
                删除
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => setDialogOpen(false)}
            >
              取消
            </Button>
            <Button type="button" disabled={saving} onClick={submitLibrary}>
              {saving ? "处理中..." : dialogMode === "create" ? "创建" : "保存"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="doc-library-name">名称</Label>
            <Input
              id="doc-library-name"
              value={libraryName}
              placeholder="例如：合同库 / 论文库"
              disabled={saving}
              onChange={(event) => setLibraryName(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="doc-library-desc">描述（可选）</Label>
            <Textarea
              id="doc-library-desc"
              value={libraryDescription}
              placeholder="简单描述一下这个文档库的用途"
              disabled={saving}
              onChange={(event) => setLibraryDescription(event.target.value)}
              className="min-h-24"
            />
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open && saving) return
          setDeleteOpen(open)
        }}
        disableClose={saving}
        title="确认删除文档库？"
        description={
          activeLibrary?.name
            ? `将删除“${activeLibrary.name}”，并级联删除其下所有文件、远程对象、文本片段与相关问答数据。`
            : "将删除该文档库，并级联删除其下所有文件、远程对象、文本片段与相关问答数据。"
        }
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => setDeleteOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={saving || !activeLibrary}
              onClick={confirmDelete}
            >
              {saving ? "删除中..." : "确认删除"}
            </Button>
          </>
        }
      />
    </div>
  )
}
