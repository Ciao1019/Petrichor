"use client"

import * as React from "react"
import { FileText, Loader2, UploadCloud, X } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { KbDialog } from "@/components/shadcn-studio/dialog/dialog-09"
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

type ImportPhase =
  | "idle"
  | "rendering"
  | "uploading"
  | "creating"
  | "error"

interface FlatFolderOption {
  id: string
  label: string
}

const PHASE_LABEL: Record<ImportPhase, string> = {
  idle: "等待开始",
  rendering: "正在把文档每一页渲染成图片…",
  uploading: "正在上传页面图片…",
  creating: "正在创建导入任务…",
  error: "导入失败",
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
  const [file, setFile] = React.useState<File | null>(null)
  const [title, setTitle] = React.useState("")
  const [parentId, setParentId] = React.useState<string | null>(defaultParentId)
  const [modelConfigId, setModelConfigId] = React.useState<string | null>(null)
  const [concurrency, setConcurrency] = React.useState(DEFAULT_CONCURRENCY)

  const [folders, setFolders] = React.useState<FlatFolderOption[]>([])
  const [models, setModels] = React.useState<AiModelConfigResponse[]>([])
  const [modelsLoading, setModelsLoading] = React.useState(false)

  const [phase, setPhase] = React.useState<ImportPhase>("idle")
  const [pageDone, setPageDone] = React.useState(0)
  const [pageTotal, setPageTotal] = React.useState(0)
  const [failedPages, setFailedPages] = React.useState<number[]>([])
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  const [noticeJob, setNoticeJob] = React.useState<{ id: string; title: string } | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  const busy =
    phase === "rendering" ||
    phase === "uploading" ||
    phase === "creating"

  const resetState = React.useCallback(() => {
    setFile(null)
    setTitle("")
    setParentId(defaultParentId)
    setPhase("idle")
    setPageDone(0)
    setPageTotal(0)
    setFailedPages([])
    setErrorMessage(null)
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

  const handlePickFile = React.useCallback((picked: File | null) => {
    if (!picked) return
    const validationError = validateDocumentImportFile(picked)
    if (validationError) {
      toast.error(validationError)
      return
    }
    setFile(picked)
    setTitle((prev) => prev || removeDocumentImportFileExtension(picked.name))
    setPhase("idle")
    setErrorMessage(null)
    setFailedPages([])
    setPageDone(0)
    setPageTotal(0)
  }, [])

  const handleStart = React.useCallback(async () => {
    if (!file) {
      toast.error("请先选择 PDF 或 Word 文档")
      return
    }
    const kind = resolveDocumentImportKind(file.name)
    if (!kind) {
      toast.error("仅支持 .pdf 或 .docx 格式")
      return
    }
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      toast.error("请填写文章标题")
      return
    }
    if (!modelConfigId) {
      toast.error("请先选择一个多模态模型（可在「模型配置 → 多模态」中新增）")
      return
    }

    setErrorMessage(null)
    setFailedPages([])
    setPageDone(0)
    setPageTotal(0)
    onOpenChange(false)
    toast.info("正在准备导入任务，创建成功后会在后台继续处理")
    try {
      // 1) 渲染每页为图片
      setPhase("rendering")
      const rendered = await rasterizeDocument(file, kind, {
        onProgress: (done, total) => {
          setPageDone(done)
          setPageTotal(total)
        },
      })
      if (rendered.length === 0) {
        throw new Error("未能从文档中解析出任何页面")
      }

      // 2) 上传每页图片（并发）
      setPhase("uploading")
      setPageTotal(rendered.length)
      setPageDone(0)
      const pages: { pageNo: number; imageKey: string }[] = []
      let uploaded = 0
      await runPool(rendered, concurrency, async (page) => {
        const imageKey = await uploadPageBlob(page.blob, page.pageNo)
        pages.push({ pageNo: page.pageNo, imageKey })
        uploaded += 1
        setPageDone(uploaded)
      })
      pages.sort((a, b) => a.pageNo - b.pageNo)

      // 3) 创建导入任务
      setPhase("creating")
      const createRes = await documentImportApi.createJob({
        knowledgeBaseId,
        parentId,
        sourceType: kind as DocumentImportSourceType,
        fileName: file.name,
        title: trimmedTitle,
        modelConfigId,
        concurrency,
        pages,
      })
      const jobId = createRes.data.job.id
      setNoticeJob({ id: jobId, title: trimmedTitle })
      toast.success("导入任务已创建")
      onJobCreated?.(jobId)
      resetState()
    } catch (error) {
      const message = resolveApiErrorMessage(error, "导入失败")
      setErrorMessage(message)
      setPhase("error")
      onOpenChange(true)
      toast.error(message)
    }
  }, [file, title, modelConfigId, knowledgeBaseId, parentId, concurrency, onJobCreated, onOpenChange, resetState])

  const progressPercent = pageTotal > 0 ? Math.round((pageDone / pageTotal) * 100) : 0

  return (
    <>
    <KbDialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        if (!next) resetState()
        onOpenChange(next)
      }}
      title="导入文档（PDF / Word）"
      description="把 PDF（含扫描件）或 Word 每一页交给多模态模型识别为文章内容。"
      disableClose={busy}
      contentClassName="sm:max-w-xl"
      footer={
        <div className="flex w-full items-center justify-end gap-2">
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
          <Button onClick={handleStart} disabled={busy || !file}>
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            {busy ? "准备中" : "开始导入"}
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
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={(e) => handlePickFile(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span className="flex items-center gap-2 truncate">
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{file.name}</span>
              </span>
              {!busy ? (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setFile(null)
                    if (fileInputRef.current) fileInputRef.current.value = ""
                  }}
                >
                  <X className="size-4" />
                </button>
              ) : null}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full flex-col items-center gap-2 rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
            >
              <UploadCloud className="size-6" />
              点击选择 PDF 或 Word 文档（≤ 100MB）
            </button>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="doc-import-title">文章标题</Label>
          <Input
            id="doc-import-title"
            value={title}
            disabled={busy}
            placeholder="导入后生成的文章标题"
            onChange={(e) => setTitle(e.target.value)}
          />
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

        {phase !== "idle" ? (
          <div className="space-y-2 rounded-md border bg-muted/30 p-3">
            <div className="flex items-center justify-between text-sm">
              <span className={cn(phase === "error" && "text-destructive")}>{PHASE_LABEL[phase]}</span>
              {pageTotal > 0 && (phase === "rendering" || phase === "uploading") ? (
                <span className="tabular-nums text-muted-foreground">
                  {pageDone}/{pageTotal}
                </span>
              ) : null}
            </div>
            {phase === "uploading" || phase === "rendering" ? (
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${phase === "rendering" && pageTotal === 0 ? 15 : progressPercent}%` }}
                />
              </div>
            ) : null}
            {failedPages.length > 0 ? (
              <p className="text-xs text-destructive">
                失败页码：{failedPages.join("、")}
              </p>
            ) : null}
            {errorMessage ? <p className="text-xs text-destructive">{errorMessage}</p> : null}
          </div>
        ) : null}
      </div>
    </KbDialog>
    <KbDialog
      open={noticeJob != null}
      onOpenChange={(next) => {
        if (!next) setNoticeJob(null)
      }}
      title="导入任务已创建"
      description="文档会在后台继续识别，全部页面成功后会自动创建文章。"
      contentClassName="sm:max-w-md"
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="outline" onClick={() => setNoticeJob(null)}>
            知道了
          </Button>
          <Button
            onClick={() => {
              setNoticeJob(null)
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
          {noticeJob?.title ? `「${noticeJob.title}」已进入导入队列。` : "文档已进入导入队列。"}
        </p>
        <p>
          进度、目标知识库、目标文件夹和失败页重试都可以在左侧菜单的「导入任务列表」中查看。
        </p>
      </div>
    </KbDialog>
    </>
  )
}

export default DocumentImportDialog
