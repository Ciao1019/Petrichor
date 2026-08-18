"use client"

import * as React from "react"
import { CheckCircle2, FileText, Loader2, RotateCcw, UploadCloud, X } from "@/components/iconimate"
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
import { rasterizePdfPages } from "@/components/knowledge/document-rasterizer"
import {
  aiModelApi,
  aiBindingApi,
  documentImportApi,
  knowledgeBaseNodeApi,
  uploadApi,
  type AiModelResponse,
  type KnowledgeBaseTreeNode,
} from "@/lib/api"

type ImportItemStatus =
  | "pending"
  | "uploading"
  | "extracting"
  | "rendering"
  | "sending"
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
  /** 需要多模态兜底的扫描页数；0 表示纯本地抽取完成 */
  ocrPages?: number
  /** 无扫描页时服务端已直接生成文章 */
  articleId?: string | null
  error?: string
}

interface ImportItemResult {
  ok: boolean
  /** 需要多模态兜底的页数，0 表示纯本地抽取 */
  ocrPages: number
}

interface FlatFolderOption {
  id: string
  label: string
}

const ITEM_STATUS_LABEL: Record<ImportItemStatus, string> = {
  pending: "等待中",
  uploading: "上传文档中",
  extracting: "本地解析中",
  rendering: "渲染扫描页",
  sending: "提交识别任务",
  done: "已完成",
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

async function putToStorage(filename: string, body: Blob, contentType: string, label: string): Promise<string> {
  const presign = await uploadApi.presignPut({ filename })
  const putResponse = await fetch(presign.data.presignedUrl, {
    method: "PUT",
    body,
    headers: { "Content-Type": contentType },
  })
  if (!putResponse.ok) {
    throw new Error(`${label}上传失败：HTTP ${putResponse.status}`)
  }
  return presign.data.objectKey
}

function uploadSourcePdf(file: File): Promise<string> {
  return putToStorage(file.name, file, "application/pdf", "文档")
}

function uploadPageBlob(blob: Blob, pageNo: number): Promise<string> {
  return putToStorage(`import-page-${pageNo}.jpg`, blob, "image/jpeg", `第 ${pageNo} 页图片`)
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
  const [models, setModels] = React.useState<AiModelResponse[]>([])
  const [modelsLoading, setModelsLoading] = React.useState(false)

  const [running, setRunning] = React.useState(false)
  const [notice, setNotice] = React.useState<{ articles: number; queued: number } | null>(null)
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
        // 可选项 = 所有已启用的语言模型；默认项 = VISION 用途当前绑定的模型
        const [modelRes, bindingRes] = await Promise.all([
          aiModelApi.list({ kind: "LANGUAGE", enabledOnly: true }),
          aiBindingApi.list(),
        ])
        if (canceled) return
        const rows = modelRes.data.items || []
        setModels(rows)
        const boundId = bindingRes.data.items.find((slot) => slot.purpose === "VISION")?.binding?.modelRefId
        const preferred = rows.find((row) => row.id === boundId) || rows[0]
        setModelConfigId((prev: string | null) => prev ?? (preferred ? preferred.id : null))
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
      toast.error(`已忽略 ${invalidCount} 个不支持的文件（仅支持 .pdf，单个 ≤ 100MB）`)
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
    async (item: ImportItem): Promise<ImportItemResult> => {
      if (!resolveDocumentImportKind(item.file.name)) {
        updateItem(item.id, { status: "failed", error: "仅支持 .pdf 格式" })
        return { ok: false, ocrPages: 0 }
      }
      const trimmedTitle = item.title.trim() || removeDocumentImportFileExtension(item.file.name) || "未命名文档"

      try {
        // 1) 原始 PDF 直传对象存储，服务端据此做本地抽取
        updateItem(item.id, { status: "uploading", pageDone: 0, pageTotal: 0, error: undefined })
        const sourceKey = await uploadSourcePdf(item.file)

        // 2) 服务端 pdf-inspector 逐页抽取；无扫描页时这一步就已经生成文章
        updateItem(item.id, { status: "extracting" })
        const createRes = await documentImportApi.createJob({
          knowledgeBaseId,
          parentId,
          fileName: item.file.name,
          title: trimmedTitle,
          sourceKey,
          modelConfigId,
          concurrency,
        })
        const { job, ocrPageNos, articleId } = createRes.data
        const jobId = job.id
        onJobCreated?.(jobId)

        if (ocrPageNos.length === 0) {
          updateItem(item.id, {
            status: "done",
            jobId,
            ocrPages: 0,
            articleId,
            title: trimmedTitle,
            pageDone: job.totalPages,
            pageTotal: job.totalPages,
            error: undefined,
          })
          return { ok: true, ocrPages: 0 }
        }

        // 3) 只有扫描页需要栅格化 + 走多模态
        if (!modelConfigId) {
          throw new Error(
            `该文档有 ${ocrPageNos.length} 页是扫描件，需要多模态模型识别，请先选择模型`
          )
        }

        updateItem(item.id, { status: "rendering", pageTotal: ocrPageNos.length, pageDone: 0 })
        const rendered = await rasterizePdfPages(item.file, ocrPageNos, {
          onProgress: (done, total) => {
            updateItem(item.id, { pageDone: done, pageTotal: total })
          },
        })
        if (rendered.length === 0) {
          throw new Error("扫描页渲染失败，未能生成任何页面图片")
        }

        updateItem(item.id, { status: "sending", pageTotal: rendered.length, pageDone: 0 })
        const pages: { pageNo: number; imageKey: string }[] = []
        let uploaded = 0
        await runPool(rendered, concurrency, async (page) => {
          const imageKey = await uploadPageBlob(page.blob, page.pageNo)
          pages.push({ pageNo: page.pageNo, imageKey })
          uploaded += 1
          updateItem(item.id, { pageDone: uploaded })
        })
        pages.sort((a, b) => a.pageNo - b.pageNo)

        await documentImportApi.attachOcrPages({ jobId, pages, concurrency })
        updateItem(item.id, {
          status: "done",
          jobId,
          ocrPages: ocrPageNos.length,
          articleId: null,
          title: trimmedTitle,
          error: undefined,
        })
        return { ok: true, ocrPages: ocrPageNos.length }
      } catch (error) {
        const message = resolveApiErrorMessage(error, "导入失败")
        updateItem(item.id, { status: "failed", error: message })
        return { ok: false, ocrPages: 0 }
      }
    },
    [concurrency, knowledgeBaseId, modelConfigId, onJobCreated, parentId, updateItem]
  )

  const runImport = React.useCallback(
    async (targets: ImportItem[]) => {
      if (targets.length === 0) return
      // 不强制要求选模型：纯文字 PDF 走本地抽取，只有出现扫描页时才会在 processItem 里报错。

      setRunning(true)
      setItems((prev) =>
        prev.map((item) =>
          targets.some((target) => target.id === item.id)
            ? { ...item, status: "pending", pageDone: 0, pageTotal: 0, error: undefined }
            : item
        )
      )

      let articles = 0
      let queued = 0
      let failed = 0
      // 文件之间串行处理，单个文件内部的扫描页按 concurrency 并行上传
      for (const target of targets) {
        const result = await processItem(target)
        if (!result.ok) failed += 1
        else if (result.ocrPages > 0) queued += 1
        else articles += 1
      }

      setRunning(false)

      if (failed === 0) {
        toast.success(
          queued === 0
            ? `已导入 ${articles} 篇文章`
            : `已完成 ${articles + queued} 个文档，其中 ${queued} 个含扫描页需后台识别`
        )
        setNotice({ articles, queued })
        onOpenChange(false)
        resetState()
      } else {
        toast.error(`成功 ${articles + queued} 个，失败 ${failed} 个，可重试失败项`)
      }
    },
    [onOpenChange, processItem, resetState]
  )

  const handleStart = React.useCallback(() => {
    const targets = items.filter((item) => item.status !== "done")
    if (targets.length === 0) {
      toast.error("请先选择 PDF 文档")
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
      title="导入文档（PDF）"
      description="文字版 PDF 直接在服务端本地抽取，不消耗模型额度；只有扫描页才会交给多模态模型识别。"
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
            accept=".pdf,application/pdf"
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
              点击选择 PDF 文档（可多选，单个 ≤ 100MB）
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
            <Label>多模态模型（扫描页兜底）</Label>
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
                    {model.displayName || model.modelId}
                    {model.providerName ? ` · ${model.providerName}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              仅用于识别扫描页。纯文字 PDF 不会调用模型。
            </p>
            {!modelsLoading && models.length === 0 ? (
              <p className="text-xs text-destructive">
                还没有可用的语言模型，遇到扫描件会导入失败，可到「模型配置 → 供应商」接入后在「用途绑定」里绑定多模态。
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label>扫描页并发数</Label>
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
              同时识别的扫描页数。本地 Ollama 受 OLLAMA_NUM_PARALLEL 限制，过高不会更快。
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
      title="导入完成"
      description="文字页已本地抽取完成；含扫描页的文档会在后台继续识别。"
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
        {notice && notice.articles > 0 ? (
          <p>{`${notice.articles} 个文档已本地抽取完成并直接生成文章，未调用多模态模型。`}</p>
        ) : null}
        {notice && notice.queued > 0 ? (
          <p>{`${notice.queued} 个文档含扫描页，正在后台排队识别，全部页面成功后会自动生成文章。`}</p>
        ) : null}
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
  const active =
    item.status === "uploading" ||
    item.status === "extracting" ||
    item.status === "rendering" ||
    item.status === "sending"
  const progressPercent =
    item.pageTotal > 0 ? Math.round((item.pageDone / item.pageTotal) * 100) : item.status === "extracting" ? 60 : 0

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
            {(item.status === "rendering" || item.status === "sending") && item.pageTotal > 0
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
            style={{ width: `${item.status === "uploading" ? 20 : progressPercent}%` }}
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
