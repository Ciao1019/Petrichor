"use client"

import * as React from "react"
import { CheckCircle2, FileText, Loader2, RotateCcw, UploadCloud, X } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  BATCH_IMPORT_MAX_FILES,
  dedupeImportFiles,
  resolveDocumentImportKind,
  removeDocumentImportFileExtension,
  validateDocumentImportFile,
} from "@/components/knowledge/article-editor-utils"
import { rasterizeDocument } from "@/components/knowledge/document-rasterizer"
import {
  aiModelConfigApi,
  documentImportApi,
  knowledgeBaseNodeApi,
  uploadApi,
  type AiModelConfigResponse,
  type DocumentImportSourceType,
  type KnowledgeBaseTreeNode,
} from "@/lib/api"

type ImportItemStatus =
  | "pending"
  | "rendering"
  | "uploading"
  | "creating"
  | "done"
  | "failed"

interface ImportItem {
  id: string
  file: File
  title: string
  status: ImportItemStatus
  pageDone: number
  pageTotal: number
  jobId?: string
  error?: string
}

interface FlatFolderOption {
  id: string
  label: string
}

const ITEM_STATUS_LABEL: Record<ImportItemStatus, string> = {
  pending: "等待中",
  rendering: "渲染页面中",
  uploading: "上传页面中",
  creating: "创建任务中",
  done: "已创建",
  failed: "失败",
}

let importItemSeq = 0
function nextImportItemId(): string {
  importItemSeq += 1
  return `import-item-${Date.now()}-${importItemSeq}`
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

function flattenFolders(nodes: KnowledgeBaseTreeNode[], depth = 0, acc: FlatFolderOption[] = []): FlatFolderOption[] {
  for (const node of nodes) {
    if (node.type !== "FOLDER") continue
    acc.push({ id: node.id, label: `${"　".repeat(depth)}${node.name}` })
    if (node.children?.length) {
      flattenFolders(node.children, depth + 1, acc)
    }
  }
  return acc
}

async function uploadPageBlob(blob: Blob, pageNo: number): Promise<string> {
  const presign = await uploadApi.presignPut({ filename: `import-page-${pageNo}.jpg` })
  const putResponse = await fetch(presign.data.presignedUrl, {
    method: "PUT",
    body: blob,
    headers: { "Content-Type": "image/jpeg" },
  })
  if (!putResponse.ok) {
    throw new Error(`第 ${pageNo} 页图片上传失败：HTTP ${putResponse.status}`)
  }
  return presign.data.objectKey
}

const CONCURRENCY_OPTIONS = [1, 2, 3, 4, 6, 8]
const DEFAULT_CONCURRENCY = 4

/** 固定并发度的任务池：最多 limit 个 worker 同时执行，按需从队列取下一项 */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const size = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const current = items[cursor]
      cursor += 1
      await worker(current)
    }
  })
  await Promise.all(runners)
}

export interface DocumentImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  knowledgeBaseId: string
  defaultParentId?: string | null
  onJobCreated?: (jobId: string) => void
  onViewJobs?: () => void
}

export function DocumentImportDialog({
  open,
  onOpenChange,
  knowledgeBaseId,
  defaultParentId = null,
  onJobCreated,
  onViewJobs,
}: DocumentImportDialogProps) {
  const [items, setItems] = React.useState<ImportItem[]>([])
  const [parentId, setParentId] = React.useState<string | null>(defaultParentId)
  const [modelConfigId, setModelConfigId] = React.useState<string | null>(null)
  const [concurrency, setConcurrency] = React.useState(DEFAULT_CONCURRENCY)

  const [folders, setFolders] = React.useState<FlatFolderOption[]>([])
  const [models, setModels] = React.useState<AiModelConfigResponse[]>([])
  const [modelsLoading, setModelsLoading] = React.useState(false)

  const [running, setRunning] = React.useState(false)
  const [notice, setNotice] = React.useState<{ created: number } | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  const busy = running
  const failedCount = items.filter((item) => item.status === "failed").length
  const doneCount = items.filter((item) => item.status === "done").length
  const pendingCount = items.filter((item) => item.status === "pending").length

  const resetState = React.useCallback(() => {
    setItems([])
    setParentId(defaultParentId)
    setRunning(false)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }, [defaultParentId])

  React.useEffect(() => {
    if (!open) return
    let canceled = false
    void (async () => {
      setParentId(defaultParentId)
      try {
        const res = await knowledgeBaseNodeApi.tree(knowledgeBaseId)
        if (!canceled) setFolders(flattenFolders(res.data.roots || []))
      } catch {
        if (!canceled) setFolders([])
      }
    })()
    void (async () => {
      setModelsLoading(true)
      try {
        const res = await aiModelConfigApi.list({ configType: "VISION", pageNum: 1, pageSize: 100, enabled: true })
        if (canceled) return
        const rows = res.data.rows || []
        setModels(rows)
        const preferred = rows.find((row) => row.isDefault) || rows[0]
        setModelConfigId((prev) => prev ?? (preferred ? preferred.id : null))
      } catch {
        if (!canceled) setModels([])
      } finally {
        if (!canceled) setModelsLoading(false)
      }
    })()
    return () => {
      canceled = true
    }
  }, [open, knowledgeBaseId, defaultParentId])

  const updateItem = React.useCallback((id: string, patch: Partial<ImportItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }, [])

  const handlePickFiles = React.useCallback((picked: File[]) => {
    if (picked.length === 0) return

    const valid: File[] = []
    let invalidCount = 0
    for (const file of picked) {
      const validationError = validateDocumentImportFile(file)
      if (validationError) {
        invalidCount += 1
        continue
      }
      valid.push(file)
    }
    if (invalidCount > 0) {
      toast.error(`已忽略 ${invalidCount} 个不支持的文件（仅支持 .pdf / .docx，单个 ≤ 100MB）`)
    }
    if (valid.length === 0) return

    setItems((prev) => {
      const { added, duplicateCount } = dedupeImportFiles(
        prev.map((item) => item.file),
        valid
      )
      if (duplicateCount > 0) {
        toast.info(`已忽略 ${duplicateCount} 个重复文件`)
      }
      if (added.length === 0) {
        return prev
      }
      let accepted = added
      if (prev.length + added.length > BATCH_IMPORT_MAX_FILES) {
        const allowed = Math.max(0, BATCH_IMPORT_MAX_FILES - prev.length)
        if (allowed < added.length) {
          toast.error(`一次最多导入 ${BATCH_IMPORT_MAX_FILES} 个文件，已截断多余文件`)
        }
        accepted = added.slice(0, allowed)
      }
      if (accepted.length === 0) {
        return prev
      }
      return [
        ...prev,
        ...accepted.map((file) => ({
          id: nextImportItemId(),
          file,
          title: removeDocumentImportFileExtension(file.name),
          status: "pending" as ImportItemStatus,
          pageDone: 0,
          pageTotal: 0,
        })),
      ]
    })
  }, [])

  const removeItem = React.useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const processItem = React.useCallback(
    async (item: ImportItem): Promise<boolean> => {
      const kind = resolveDocumentImportKind(item.file.name)
      if (!kind) {
        updateItem(item.id, { status: "failed", error: "仅支持 .pdf 或 .docx 格式" })
        return false
      }
      const trimmedTitle = item.title.trim() || removeDocumentImportFileExtension(item.file.name) || "未命名文档"

      try {
        updateItem(item.id, { status: "rendering", pageDone: 0, pageTotal: 0, error: undefined })
        const rendered = await rasterizeDocument(item.file, kind, {
          onProgress: (done, total) => {
            updateItem(item.id, { pageDone: done, pageTotal: total })
          },
        })
        if (rendered.length === 0) {
          throw new Error("未能从文档中解析出任何页面")
        }

        updateItem(item.id, { status: "uploading", pageTotal: rendered.length, pageDone: 0 })
        const pages: { pageNo: number; imageKey: string }[] = []
        let uploaded = 0
        await runPool(rendered, concurrency, async (page) => {
          const imageKey = await uploadPageBlob(page.blob, page.pageNo)
          pages.push({ pageNo: page.pageNo, imageKey })
          uploaded += 1
          updateItem(item.id, { pageDone: uploaded })
        })
        pages.sort((a, b) => a.pageNo - b.pageNo)

        updateItem(item.id, { status: "creating" })
        const createRes = await documentImportApi.createJob({
          knowledgeBaseId,
          parentId,
          sourceType: kind as DocumentImportSourceType,
          fileName: item.file.name,
          title: trimmedTitle,
          modelConfigId,
          concurrency,
          pages,
        })
        const jobId = createRes.data.job.id
        updateItem(item.id, { status: "done", jobId, title: trimmedTitle, error: undefined })
        onJobCreated?.(jobId)
        return true
      } catch (error) {
        const message = resolveApiErrorMessage(error, "导入失败")
        updateItem(item.id, { status: "failed", error: message })
        return false
      }
    },
    [concurrency, knowledgeBaseId, modelConfigId, onJobCreated, parentId, updateItem]
  )

  const runImport = React.useCallback(
    async (targets: ImportItem[]) => {
      if (targets.length === 0) return
      if (!modelConfigId) {
        toast.error("请先选择一个多模态模型（可在「模型配置 → 多模态」中新增）")
        return
      }

      setRunning(true)
      setItems((prev) =>
        prev.map((item) =>
          targets.some((target) => target.id === item.id)
            ? { ...item, status: "pending", pageDone: 0, pageTotal: 0, error: undefined }
            : item
        )
      )

      let succeeded = 0
      let failed = 0
      // 文件之间串行处理，单个文件内部的页面按 concurrency 并行，避免一次性打满上传/识别
      for (const target of targets) {
        const okResult = await processItem(target)
        if (okResult) succeeded += 1
        else failed += 1
      }

      setRunning(false)

      if (failed === 0) {
        toast.success(`已创建 ${succeeded} 个导入任务`)
        setNotice({ created: succeeded })
        onOpenChange(false)
        resetState()
      } else {
        toast.error(`成功 ${succeeded} 个，失败 ${failed} 个，可重试失败项`)
      }
    },
    [modelConfigId, onOpenChange, processItem, resetState]
  )

  const handleStart = React.useCallback(() => {
    const targets = items.filter((item) => item.status !== "done")
    if (targets.length === 0) {
      toast.error("请先选择 PDF 或 Word 文档")
      return
    }
    void runImport(targets)
  }, [items, runImport])

  const handleRetryFailed = React.useCallback(() => {
    const targets = items.filter((item) => item.status === "failed")
    if (targets.length === 0) return
    void runImport(targets)
  }, [items, runImport])

  return (
    <>
    <ModalShell
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        if (!next) resetState()
        onOpenChange(next)
      }}
      title="导入文档（PDF / Word）"
      description="可一次选择多个文件批量导入，每个文档每一页交给多模态模型识别为文章内容。"
      disableClose={busy}
      contentClassName="sm:max-w-xl"
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          {failedCount > 0 && !busy ? (
            <Button variant="outline" onClick={handleRetryFailed}>
              <RotateCcw className="mr-2 size-4" />
              重试失败（{failedCount}）
            </Button>
          ) : null}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              resetState()
              onOpenChange(false)
            }}
          >
            关闭
          </Button>
          <Button onClick={handleStart} disabled={busy || pendingCount === 0}>
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            {busy ? "导入中…" : pendingCount > 0 ? `开始导入（${pendingCount}）` : "开始导入"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 px-1 py-1">
        <div className="space-y-2">
          <Label>文档文件</Label>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={(e) => {
              handlePickFiles(Array.from(e.target.files ?? []))
              e.currentTarget.value = ""
            }}
          />

          {items.length > 0 ? (
            <div className="space-y-2">
              <div className="flex flex-col gap-2 max-h-64 overflow-auto app-scrollbar pr-1">
                {items.map((item) => (
                  <ImportItemRow
                    key={item.id}
                    item={item}
                    busy={busy}
                    onTitleChange={(title) => updateItem(item.id, { title })}
                    onRemove={() => removeItem(item.id)}
                  />
                ))}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
                className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                <UploadCloud className="size-4" />
                继续添加文件
              </button>
              <p className="text-xs text-muted-foreground">
                共 {items.length} 个文件{doneCount > 0 ? `，已创建 ${doneCount} 个` : ""}
                {failedCount > 0 ? `，失败 ${failedCount} 个` : ""}。
              </p>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full flex-col items-center gap-2 rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
            >
              <UploadCloud className="size-6" />
              点击选择 PDF 或 Word 文档（可多选，单个 ≤ 100MB）
            </button>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>导入到文件夹</Label>
            <Select
              value={parentId ?? "__root__"}
              disabled={busy}
              onValueChange={(v) => setParentId(v === "__root__" ? null : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="知识库根目录" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__root__">知识库根目录</SelectItem>
                {folders.map((folder) => (
                  <SelectItem key={folder.id} value={folder.id}>
                    {folder.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>多模态模型</Label>
            <Select
              value={modelConfigId ?? ""}
              disabled={busy || modelsLoading}
              onValueChange={(v) => setModelConfigId(v)}
            >
              <SelectTrigger>
                <SelectValue placeholder={modelsLoading ? "加载中…" : "选择多模态模型"} />
              </SelectTrigger>
              <SelectContent>
                {models.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.name}
                    {model.isDefault ? "（默认）" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!modelsLoading && models.length === 0 ? (
              <p className="text-xs text-destructive">
                还没有多模态模型，请先到「模型配置 → 多模态」新增并启用。
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label>并发页数</Label>
            <Select
              value={String(concurrency)}
              disabled={busy}
              onValueChange={(v) => setConcurrency(Number(v))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONCURRENCY_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} 页并行
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              同时识别的页数。本地 Ollama 受 OLLAMA_NUM_PARALLEL 限制，过高不会更快。
            </p>
          </div>
        </div>
      </div>
    </ModalShell>
    <ModalShell
      open={notice != null}
      onOpenChange={(next) => {
        if (!next) setNotice(null)
      }}
      title="导入任务已创建"
      description="文档会在后台继续识别，全部页面成功后会自动创建文章。"
      contentClassName="sm:max-w-md"
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="outline" onClick={() => setNotice(null)}>
            知道了
          </Button>
          <Button
            onClick={() => {
              setNotice(null)
              onViewJobs?.()
            }}
          >
            查看导入任务列表
          </Button>
        </div>
      }
    >
      <div className="space-y-2 px-1 py-1 text-sm text-muted-foreground">
        <p>
          {notice ? `已创建 ${notice.created} 个导入任务，正在后台排队识别。` : "文档已进入导入队列。"}
        </p>
        <p>
          进度、目标知识库、目标文件夹和失败页重试都可以在左侧菜单的「导入任务列表」中查看。
        </p>
      </div>
    </ModalShell>
    </>
  )
}

function ImportItemRow({
  item,
  busy,
  onTitleChange,
  onRemove,
}: {
  item: ImportItem
  busy: boolean
  onTitleChange: (title: string) => void
  onRemove: () => void
}) {
  const active = item.status === "rendering" || item.status === "uploading" || item.status === "creating"
  const progressPercent =
    item.pageTotal > 0 ? Math.round((item.pageDone / item.pageTotal) * 100) : item.status === "creating" ? 100 : 0

  return (
    <div className="rounded-md border px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          {item.status === "done" ? (
            <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
          ) : active ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <FileText className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{item.file.name}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span
            className={cn(
              "text-xs",
              item.status === "failed" ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {ITEM_STATUS_LABEL[item.status]}
            {(item.status === "rendering" || item.status === "uploading") && item.pageTotal > 0
              ? ` ${item.pageDone}/${item.pageTotal}`
              : ""}
          </span>
          {!busy && item.status !== "done" ? (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              aria-label={`移除 ${item.file.name}`}
              onClick={onRemove}
            >
              <X className="size-4" />
            </button>
          ) : null}
        </span>
      </div>

      {item.status !== "done" && item.status !== "failed" ? (
        <Input
          value={item.title}
          disabled={busy}
          placeholder="导入后生成的文章标题"
          className="mt-2 h-8"
          onChange={(e) => onTitleChange(e.target.value)}
        />
      ) : null}

      {active ? (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${item.status === "rendering" && item.pageTotal === 0 ? 15 : progressPercent}%` }}
          />
        </div>
      ) : null}

      {item.status === "failed" && item.error ? (
        <p className="mt-1.5 text-xs text-destructive">{item.error}</p>
      ) : null}
    </div>
  )
}

export default DocumentImportDialog
