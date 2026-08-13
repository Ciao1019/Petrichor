"use client"

import * as React from "react"
import { MoreHorizontal, Book as BookIcon } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"

import {
  Table,
  useTableSortable,
  useTableSortableState,
  proportional,
  pixel,
  type TableColumn,
} from "@astryxdesign/core/Table"
import { Text } from "@astryxdesign/core/Text"
import { AstryxProvider } from "@/components/astryx/astryx-provider"
import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { ActionMenu } from "@/components/petrichor-ui/action-menu"
import { notify } from "@/components/petrichor-ui/notify"
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

/**
 * Astryx Table 的数据行类型。使用 type 别名（而非 interface）以满足
 * useTableSortable 的 `Record<string, unknown>` 约束。
 */
type KnowledgeBaseRow = {
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
}

type KnowledgeBaseSortKey = "name" | "updatedAt"

function formatDate(value: string): string {
  if (!value) return "-"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString()
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
          chunkStrategy: activeKb.chunkStrategy,
          chunkSize: activeKb.chunkSize,
          chunkOverlap: activeKb.chunkOverlap,
          chunkSeparators: activeKb.chunkSeparators,
          chatModelId: activeKb.chatModelId,
          embeddingModelId: activeKb.embeddingModelId,
          rerankModelId: activeKb.rerankModelId,
          wikiEnabled: activeKb.wikiEnabled,
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
      const response = await knowledgeBaseApi.delete(activeKb.id)
      const cleanupFailures = response.data.storageCleanup.failedObjectKeys.length
      if (cleanupFailures > 0) {
        toast.warning(`知识库已删除，但有 ${cleanupFailures} 个原文件未能从对象存储清理`)
      } else {
        toast.success("知识库已删除")
      }
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

  const rows = React.useMemo<KnowledgeBaseRow[]>(
    () =>
      data.map((kb) => ({
        id: kb.id,
        name: kb.name,
        description: kb.description || "",
        createdAt: kb.createdAt,
        updatedAt: kb.updatedAt,
      })),
    [data],
  )

  const { sortedData, sortConfig } = useTableSortableState<KnowledgeBaseRow, KnowledgeBaseSortKey>({
    data: rows,
    defaultSort: [{ sortKey: "updatedAt", direction: "descending" }],
    comparators: {
      name: (a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"),
      updatedAt: (a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(),
    },
  })
  const sortPlugin = useTableSortable<KnowledgeBaseRow, KnowledgeBaseSortKey>(sortConfig)

  const columns = React.useMemo<TableColumn<KnowledgeBaseRow>[]>(
    () => [
      {
        key: "name",
        header: "名称",
        sortable: true,
        width: proportional(2),
        renderCell: (kb) => (
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 text-left outline-none hover:underline focus-visible:underline"
            onClick={() => navigate(knowledgeBasePath(kb.id))}
          >
            <BookIcon size={16} className="shrink-0 text-muted-foreground" />
            <Text weight="semibold" maxLines={1}>
              {kb.name}
            </Text>
          </button>
        ),
      },
      {
        key: "description",
        header: "描述",
        width: proportional(3),
        renderCell: (kb) => (
          <Text type="supporting" color="secondary" maxLines={2}>
            {kb.description || "暂无描述"}
          </Text>
        ),
      },
      {
        key: "updatedAt",
        header: "更新时间",
        sortable: true,
        width: pixel(140),
        renderCell: (kb) => (
          <Text type="supporting" color="secondary">
            {formatDate(kb.updatedAt)}
          </Text>
        ),
      },
      {
        key: "actions",
        header: "",
        align: "end",
        width: pixel(64),
        resizable: false,
        renderCell: (kb) => (
          <ActionMenu
            trigger={
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
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
                  .then(() => notify("已复制知识库 ID"))
                  .catch(() => toast.error("复制失败"))
              }}
            >
              复制 ID
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => {
              const item = data.find((entry) => entry.id === kb.id)
              if (item) openEdit(item)
            }}>
              编辑
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                const item = data.find((entry) => entry.id === kb.id)
                if (item) {
                  setActiveKb(item)
                  setDeleteOpen(true)
                }
              }}
            >
              删除
            </DropdownMenuItem>
          </ActionMenu>
        ),
      },
    ],
    [data, navigate, openEdit],
  )

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
      ) : (
        <AstryxProvider>
          <Table
            data={sortedData}
            columns={columns}
            idKey="id"
            plugins={{ sort: sortPlugin }}
            density="balanced"
            dividers="rows"
            hasHover
            verticalAlign="middle"
            textOverflow="truncate"
          />
        </AstryxProvider>
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

      <ModalShell
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
      </ModalShell>

      <ModalShell
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
