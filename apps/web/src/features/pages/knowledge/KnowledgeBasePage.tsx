"use client"

import * as React from "react"
import { MoreHorizontal, Book as BookIcon } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import {
  ModernBookCover,
  BookHeader,
  BookTitle,
  BookDescription,
} from "@/cuicui/other/books/modern-book-cover/modern-book-cover"
import { KbDialog } from "@/components/shadcn-studio/dialog/dialog-09"
import { KbDropdownMenu } from "@/components/shadcn-studio/dropdown-menu/dropdown-menu-09"
import { toastWithIcon } from "@/components/shadcn-studio/sonner/sonner-03"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import { AppPagination } from "@/components/app-pagination"
import { Input } from "@/components/ui/input"
import {
  knowledgeBaseApi,
  type KnowledgeBaseResponse,
} from "@/lib/api"
import { knowledgeBasePath } from "@/lib/dashboard-routes"

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

function KnowledgeBaseCard({
  kb,
  onClick,
  onEdit,
  onDelete,
}: {
  kb: KnowledgeBaseResponse
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
      onKeyDown={(e) => {
        if (e.currentTarget !== e.target) return
        if (e.key !== "Enter" && e.key !== " ") return
        e.preventDefault()
        onClick()
      }}
    >
      <ModernBookCover size="sm" color={pickBookColor(kb.id)} className="w-min">
        <BookHeader className="w-full items-start justify-between gap-3">
          <BookIcon size={20} className="text-white/90 shrink-0" />
          <KbDropdownMenu
            trigger={
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-8 w-8 shrink-0 text-white/80",
                  "hover:bg-white/10 hover:text-white",
                  "focus-visible:ring-2 focus-visible:ring-white/30"
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
                void navigator.clipboard.writeText(kb.id)
                  .then(() => toastWithIcon("已复制知识库 ID"))
                  .catch(() => toast.error("复制失败"))
              }}
            >
              复制 ID
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onEdit}>编辑</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              删除
            </DropdownMenuItem>
          </KbDropdownMenu>
        </BookHeader>

        <BookTitle className="line-clamp-2 text-lg">{kb.name}</BookTitle>
        <BookDescription className="line-clamp-2 min-h-[2.5rem]">
          {kb.description || "暂无描述"}
        </BookDescription>
        <div className="mt-3 text-[11px] opacity-70 select-none">
          更新于 {new Date(kb.updatedAt).toLocaleDateString()}
        </div>
      </ModernBookCover>
    </div>
  )
}

export function KnowledgeBasePage() {
  const [data, setData] = React.useState<KnowledgeBaseResponse[]>([])
  const [total, setTotal] = React.useState(0)
  const [pageIndex, setPageIndex] = React.useState(0)
  const [pageSize] = React.useState(12)
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [dialogMode, setDialogMode] = React.useState<"create" | "edit">("create")
  const [activeKb, setActiveKb] = React.useState<KnowledgeBaseResponse | null>(null)
  const [kbName, setKbName] = React.useState("")
  const [kbDescription, setKbDescription] = React.useState("")
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const navigate = useNavigate()

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = pageIndex + 1

  const fetchData = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await knowledgeBaseApi.list({
        pageNum: pageIndex + 1,
        pageSize,
      })
      setData(res.data.rows)
      setTotal(res.data.total)
    } catch (error) {
      console.error("Failed to fetch knowledge bases:", error)
      toast.error("加载知识库失败")
    } finally {
      setLoading(false)
    }
  }, [pageIndex, pageSize])

  React.useEffect(() => {
    fetchData()
  }, [fetchData])

  React.useEffect(() => {
    if (pageIndex > totalPages - 1) {
      setPageIndex(totalPages - 1)
    }
  }, [pageIndex, totalPages])

  const handlePageChange = React.useCallback(
    (nextPageIndex: number) => {
      if (nextPageIndex < 0 || nextPageIndex >= totalPages) return
      setPageIndex(nextPageIndex)
    },
    [totalPages],
  )

  const openCreate = React.useCallback(() => {
    setDialogMode("create")
    setActiveKb(null)
    setKbName("")
    setKbDescription("")
    setDialogOpen(true)
  }, [])

  const openEdit = React.useCallback((kb: KnowledgeBaseResponse) => {
    setDialogMode("edit")
    setActiveKb(kb)
    setKbName(kb.name || "")
    setKbDescription(kb.description || "")
    setDialogOpen(true)
  }, [])

  const submitKb = React.useCallback(async () => {
    const name = kbName.trim()
    const description = kbDescription.trim()
    if (!name) {
      toast.error("知识库名称不能为空")
      return
    }
    if (saving) return

    setSaving(true)
    try {
      if (dialogMode === "create") {
        await knowledgeBaseApi.create({
          name,
          description: description ? description : null,
        })
        toast.success("知识库已创建")
      } else if (activeKb) {
        await knowledgeBaseApi.update({
          knowledgeBaseId: activeKb.id,
          name,
          description: description ? description : null,
        })
        toast.success("知识库已更新")
      }
      setDialogOpen(false)
      await fetchData()
    } catch (e: unknown) {
      const msg = (() => {
        if (typeof e === "object" && e && "response" in e) {
          const response = (e as { response?: { data?: { msg?: unknown } } })
            .response
          const apiMsg = response?.data?.msg
          if (typeof apiMsg === "string" && apiMsg) {
            return apiMsg
          }
        }
        if (e instanceof Error && e.message) return e.message
        return "操作失败"
      })()
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }, [activeKb, dialogMode, fetchData, kbDescription, kbName, saving])

  const confirmDelete = React.useCallback(async () => {
    if (!activeKb) return
    if (saving) return
    setSaving(true)
    try {
      await knowledgeBaseApi.delete(activeKb.id)
      toast.success("知识库已删除")
      setDeleteOpen(false)
      setDialogOpen(false)
      await fetchData()
    } catch (e: unknown) {
      const msg = (() => {
        if (typeof e === "object" && e && "response" in e) {
          const response = (e as { response?: { data?: { msg?: unknown } } })
            .response
          const apiMsg = response?.data?.msg
          if (typeof apiMsg === "string" && apiMsg) {
            return apiMsg
          }
        }
        if (e instanceof Error && e.message) return e.message
        return "删除失败"
      })()
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }, [activeKb, fetchData, saving])

  return (
    <div className="w-full p-4 lg:p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">知识库</h1>
        <Button onClick={openCreate}>新建知识库</Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <span className="text-muted-foreground">加载中...</span>
        </div>
      ) : data.length === 0 ? (
        <div className="flex items-center justify-center h-64">
          <span className="text-muted-foreground">暂无数据</span>
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 justify-items-center">
          {data.map((kb) => (
            <KnowledgeBaseCard
              key={kb.id}
              kb={kb}
              onClick={() => navigate(knowledgeBasePath(kb.id))}
              onEdit={() => openEdit(kb)}
              onDelete={() => {
                setActiveKb(kb)
                setDeleteOpen(true)
              }}
            />
          ))}
        </div>
      )}

      <div className="py-3 mt-4">
        <AppPagination
          page={pageIndex}
          totalPages={totalPages}
          total={total}
          pageSize={pageSize}
          onChange={handlePageChange}
        />
      </div>

      <KbDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open && saving) return
          setDialogOpen(open)
        }}
        disableClose={saving}
        title={dialogMode === "create" ? "新建知识库" : "编辑知识库"}
        description={
          dialogMode === "create"
            ? "创建一个新的知识库，用于归档你的文档与文章。"
            : "修改知识库的名称与描述。"
        }
        footer={
          <>
            {dialogMode === "edit" ? (
              <Button
                type="button"
                variant="destructive"
                disabled={saving || !activeKb}
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
            <Button type="button" disabled={saving} onClick={submitKb}>
              {saving ? "处理中..." : dialogMode === "create" ? "创建" : "保存"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="kb-name">名称</Label>
            <Input
              id="kb-name"
              value={kbName}
              placeholder="例如：产品设计文档"
              disabled={saving}
              onChange={(e) => setKbName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="kb-desc">描述（可选）</Label>
            <Textarea
              id="kb-desc"
              value={kbDescription}
              placeholder="简单描述一下这个知识库的用途"
              disabled={saving}
              onChange={(e) => setKbDescription(e.target.value)}
              className="min-h-24"
            />
          </div>
        </div>
      </KbDialog>

      <KbDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open && saving) return
          setDeleteOpen(open)
        }}
        disableClose={saving}
        title="确认删除知识库？"
        description={
          activeKb?.name
            ? `将删除“${activeKb.name}”，并级联删除其下所有文件夹与文章。`
            : "将删除该知识库，并级联删除其下所有文件夹与文章。"
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
              disabled={saving || !activeKb}
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
