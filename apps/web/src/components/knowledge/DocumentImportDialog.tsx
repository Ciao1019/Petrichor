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
import {
  aiModelConfigApi,
  documentImportApi,
  knowledgeBaseNodeApi,
  uploadApi,
  type DocumentImportSourceType,
  type KnowledgeBaseTreeNode,
} from "@/lib/api"

type ImportPhase =
  | "idle"
  | "uploading"
  | "creating"
  | "error"

interface FlatFolderOption {
  id: string
  label: string
}

const PHASE_LABEL: Record<ImportPhase, string> = {
  idle: "等待开始",
  uploading: "正在上传文档…",
  creating: "正在创建解析任务…",
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

async function uploadSourceFile(file: File): Promise<string> {
  const presign = await uploadApi.presignPut({ filename: file.name })
  const putResponse = await fetch(presign.data.presignedUrl, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type || "application/octet-stream" },
  })
  if (!putResponse.ok) {
    throw new Error(`文档上传失败：HTTP ${putResponse.status}`)
  }
  return presign.data.objectKey
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

  const [folders, setFolders] = React.useState<FlatFolderOption[]>([])
  const [hasParser, setHasParser] = React.useState(true)

  const [phase, setPhase] = React.useState<ImportPhase>("idle")
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  const [noticeJob, setNoticeJob] = React.useState<{ id: string; title: string } | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  const busy = phase === "uploading" || phase === "creating"

  const resetState = React.useCallback(() => {
    setFile(null)
    setTitle("")
    setParentId(defaultParentId)
    setPhase("idle")
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
      try {
        const res = await aiModelConfigApi.list({ configType: "DOC_PARSE", pageNum: 1, pageSize: 1, enabled: true })
        if (!canceled) setHasParser((res.data.rows || []).length > 0)
      } catch {
        if (!canceled) setHasParser(true)
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

    setErrorMessage(null)
    onOpenChange(false)
    toast.info("正在准备导入任务，创建成功后会在后台继续解析")
    try {
      // 1) 上传原始文档
      setPhase("uploading")
      const fileKey = await uploadSourceFile(file)

      // 2) 创建解析任务（后台交给 MinerU 解析并自动生成文章）
      setPhase("creating")
      const createRes = await documentImportApi.createJob({
        knowledgeBaseId,
        parentId,
        sourceType: kind as DocumentImportSourceType,
        fileName: file.name,
        title: trimmedTitle,
        fileKey,
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
  }, [file, title, knowledgeBaseId, parentId, onJobCreated, onOpenChange, resetState])

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
      description="把整份 PDF（含扫描件）或 Word 交给 MinerU 解析为文章内容。"
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

        {!hasParser ? (
          <p className="text-xs text-destructive">
            还没有配置文档解析服务，请先到「模型配置 → 文档解析」填入 MinerU Token 并启用。
          </p>
        ) : null}

        {phase !== "idle" ? (
          <div className="space-y-2 rounded-md border bg-muted/30 p-3">
            <div className="flex items-center justify-between text-sm">
              <span className={cn(phase === "error" && "text-destructive")}>{PHASE_LABEL[phase]}</span>
            </div>
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
      description="文档会在后台解析，解析完成后会自动创建文章。"
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
          {noticeJob?.title ? `「${noticeJob.title}」已进入解析队列。` : "文档已进入解析队列。"}
        </p>
        <p>
          进度、目标知识库、目标文件夹和重试都可以在左侧菜单的「导入任务列表」中查看。
        </p>
      </div>
    </KbDialog>
    </>
  )
}

export default DocumentImportDialog
