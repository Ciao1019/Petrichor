"use client"

import * as React from "react"
import { RotateCcw, UploadCloud } from "@/components/iconimate"
import { toast } from "sonner"
import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  BATCH_IMPORT_MAX_FILES,
  DOCUMENT_IMPORT_ACCEPT,
  dedupeImportFiles,
  removeDocumentImportFileExtension,
  validateDocumentImportFile,
} from "@/components/knowledge/article-editor-utils"
import { DocumentImportFileRow } from "./document-import-file-row"
import { useDocumentImport, type ImportItem } from "./use-document-import"
import { IMAGE_POLICY_LABELS, IMAGE_POLICY_DESCRIPTIONS } from "./document-import-policy"
import { isDemoMode } from "@/lib/demo/demo-mode"
import {
  aiModelApi, aiBindingApi, knowledgeBaseNodeApi,
  type AiModelResponse, type KnowledgeBaseTreeNode, type DocumentImportImagePolicy,
} from "@/lib/api"

interface FlatFolderOption { id: string; label: string }
function flattenFolders(nodes: KnowledgeBaseTreeNode[], depth = 0, acc: FlatFolderOption[] = []): FlatFolderOption[] {
  for (const node of nodes) {
    if (node.type !== "FOLDER") continue
    acc.push({ id: node.id, label: `${"　".repeat(depth)}${node.name}` })
    if (node.children?.length) flattenFolders(node.children, depth + 1, acc)
  }
  return acc
}

export interface DocumentImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  knowledgeBaseId: string
  defaultParentId?: string | null
  onJobCreated?: (jobId: string) => void
  onViewJobs?: () => void
}

export function DocumentImportDialog({ open, onOpenChange, knowledgeBaseId, defaultParentId = null, onJobCreated, onViewJobs }: DocumentImportDialogProps) {
  const [parentId, setParentId] = React.useState<string | null>(defaultParentId)
  const [modelConfigId, setModelConfigId] = React.useState<string | null>(null)
  const [concurrency, setConcurrency] = React.useState(4)
  const [imagePolicy, setImagePolicy] = React.useState<DocumentImportImagePolicy>("keep_and_recognize")
  const skipRecognition = imagePolicy === "images_only"
  const [folders, setFolders] = React.useState<FlatFolderOption[]>([])
  const [models, setModels] = React.useState<AiModelResponse[]>([])
  const [modelsLoading, setModelsLoading] = React.useState(false)
  const [notice, setNotice] = React.useState<{ completed: number; submitted: number } | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const { items, setItems, running: busy, capacityError, updateItem, runImport } = useDocumentImport({
    knowledgeBaseId, parentId, modelConfigId, concurrency, imagePolicy, onJobCreated,
  })
  const failedCount = items.filter((item) => item.status === "failed").length
  const pendingCount = items.filter((item) => item.status === "pending").length
  const submittedCount = items.filter((item) => item.status === "submitted").length
  const completedCount = items.filter((item) => item.status === "done").length

  React.useEffect(() => {
    if (!open) return
    let canceled = false
    setParentId(defaultParentId)
    void knowledgeBaseNodeApi.tree(knowledgeBaseId).then((res) => {
      if (!canceled) setFolders(flattenFolders(res.data.roots || []))
    }).catch(() => { if (!canceled) setFolders([]) })
    setModelsLoading(true)
    void Promise.all([
      aiModelApi.list({ kind: "LANGUAGE", enabledOnly: true }), aiBindingApi.list(),
    ]).then(([modelRes, bindingRes]) => {
      if (canceled) return
      const rows = modelRes.data.items || []
      setModels(rows)
      const boundId = bindingRes.data.items.find((slot) => slot.purpose === "VISION")?.binding?.modelRefId
      setModelConfigId((prev) => prev ?? rows.find((row) => row.id === boundId)?.id ?? null)
    }).catch(() => { if (!canceled) setModels([]) })
      .finally(() => { if (!canceled) setModelsLoading(false) })
    return () => { canceled = true }
  }, [open, knowledgeBaseId, defaultParentId])

  const handlePickFiles = (picked: File[]) => {
    if (busy) return
    const valid: File[] = []
    const errors = new Set<string>()
    for (const file of picked) {
      const error = validateDocumentImportFile(file)
      if (error) errors.add(error)
      else valid.push(file)
    }
    if (errors.size) toast.error([...errors].join("；"))
    const { added, duplicateCount } = dedupeImportFiles(items.map((item) => item.file), valid)
    if (duplicateCount) toast.info(`已忽略 ${duplicateCount} 个重复文件`)
    const available = Math.max(0, BATCH_IMPORT_MAX_FILES - items.length)
    if (added.length > available) toast.error(`一次最多导入 ${BATCH_IMPORT_MAX_FILES} 个文件`)
    setItems((prev) => [...prev, ...added.slice(0, available).map((file): ImportItem => ({
      id: crypto.randomUUID(), file, title: removeDocumentImportFileExtension(file.name), status: "pending",
    }))])
  }

  const start = async (status: "pending" | "failed") => {
    if (busy) return
    setNotice(null)
    const result = await runImport(items.filter((item) => item.status === status))
    if (!result) return
    if (result.failed) toast.error(`已完成 ${result.completed} 个，已提交 ${result.submitted} 个，失败 ${result.failed} 个，可安全重试失败项`)
    else {
      setNotice({ completed: result.completed, submitted: result.submitted })
      toast.success(`已完成 ${result.completed} 个，已提交后台 ${result.submitted} 个，可关闭页面`)
    }
  }
  const close = () => {
    if (busy) return
    // 仅保留未确认提交项供本标签页重试；已确认任务不再需要原文件。
    setItems((prev) => prev.filter((item) => !item.jobId && (item.status === "failed" || item.status === "pending")))
    setNotice(null)
    onOpenChange(false)
  }

  return (
    <>
      <ModalShell
        open={open}
        onOpenChange={(next) => { if (!next) close(); else onOpenChange(true) }}
        title="导入外部文档"
        description="上传文档并选择图片处理方式。提交成功后可关闭页面，后台会继续处理并生成文章。"
        disableClose={busy}
        contentClassName="sm:max-w-xl"
        footer={
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            {failedCount > 0 ? <Button variant="outline" disabled={busy} onClick={() => void start("failed")}><RotateCcw className="mr-2 size-4" />重试失败（{failedCount}）</Button> : null}
            <Button variant="outline" disabled={busy} onClick={close}>关闭</Button>
            <Button disabled={busy || pendingCount === 0} onClick={() => void start("pending")}>{busy ? "上传 / 提交中…" : `开始导入${pendingCount ? `（${pendingCount}）` : ""}`}</Button>
          </div>
        }
      >
        <div className="flex min-w-0 flex-col gap-4 px-1 py-1">
          {isDemoMode() ? <p role="note" className="rounded-md border p-3 text-sm text-muted-foreground">演示模式：仅在本标签页内存模拟上传及创建任务，不读取或上传文件内容，不调用解析 / OCR 服务，也不会生成真实文章；刷新后清空。</p> : null}
          <div className="space-y-2">
            <Label>文档文件</Label>
            <input ref={fileInputRef} type="file" multiple accept={DOCUMENT_IMPORT_ACCEPT} className="hidden" onChange={(event) => {
              handlePickFiles(Array.from(event.target.files ?? []))
              event.currentTarget.value = ""
            }} />
            <div className="app-scrollbar flex max-h-64 flex-col gap-2 overflow-auto pr-1">
              {items.map((item) => <DocumentImportFileRow key={item.id} item={item} busy={busy} onTitleChange={(title) => updateItem(item.id, { title })} onRemove={() => setItems((prev) => prev.filter((row) => row.id !== item.id))} />)}
            </div>
            <button type="button" disabled={busy} onClick={() => fileInputRef.current?.click()} className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground hover:border-primary/60 hover:text-foreground disabled:opacity-60">
              <UploadCloud className="size-5 shrink-0" />{items.length ? "继续添加文件" : "选择文档（可多选，单个 ≤ 100MB）"}
            </button>
            <p className="text-xs text-muted-foreground">支持 PDF、Markdown、Word、Excel、PowerPoint、OpenDocument、RTF、EPUB、CSV。</p>
            {capacityError ? <p role="alert" className="text-xs text-destructive">{capacityError}</p> : null}
            {items.length > 0 ? <p className="text-xs text-muted-foreground">共 {items.length} 个 · 已完成 {completedCount} · 已提交 {submittedCount} · 失败 {failedCount}</p> : null}
          </div>
          <div className="min-w-0 space-y-2">
            <Label htmlFor="import-image-policy">PDF 图片处理</Label>
            <Select value={imagePolicy} disabled={busy} onValueChange={(value) => setImagePolicy(value as DocumentImportImagePolicy)}>
              <SelectTrigger id="import-image-policy" aria-describedby="import-image-policy-hint" className="w-full min-w-0"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(IMAGE_POLICY_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}{value === "keep_and_recognize" ? "（默认）" : ""}</SelectItem>)}</SelectContent>
            </Select>
            <p id="import-image-policy-hint" className="text-xs text-muted-foreground">{IMAGE_POLICY_DESCRIPTIONS[imagePolicy]}PDF 原生正文始终保留；此选项不改变其他格式的解析方式。</p>
          </div>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-2">
              <Label htmlFor="import-folder">导入到文件夹</Label>
              <Select value={parentId ?? "__root__"} disabled={busy} onValueChange={(value) => setParentId(value === "__root__" ? null : value)}>
                <SelectTrigger id="import-folder" className="w-full min-w-0"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="__root__">知识库根目录</SelectItem>{folders.map((folder) => <SelectItem key={folder.id} value={folder.id}>{folder.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="min-w-0 space-y-2">
              <Label htmlFor="import-model">多模态模型（可选）</Label>
              <Select value={modelConfigId ?? "__none__"} disabled={busy || modelsLoading || skipRecognition} onValueChange={(value) => setModelConfigId(value === "__none__" ? null : value)}>
                <SelectTrigger id="import-model" className="w-full min-w-0"><SelectValue placeholder={modelsLoading ? "加载中…" : "不指定模型"} /></SelectTrigger>
                <SelectContent><SelectItem value="__none__">不指定模型</SelectItem>{models.map((model) => <SelectItem key={model.id} value={model.id}>{model.displayName || model.modelId}{model.providerName ? ` · ${model.providerName}` : ""}</SelectItem>)}</SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{skipRecognition ? "仅保留图片，无需配置识别模型。" : "未指定时使用已绑定的视觉模型。需要 OCR 或图片描述时，必须有可用的多模态模型。"}</p>
            </div>
            <div className="min-w-0 space-y-2">
              <Label htmlFor="import-concurrency">服务端 OCR 并发数</Label>
              <Select value={String(concurrency)} disabled={busy || skipRecognition} onValueChange={(value) => setConcurrency(Number(value))}>
                <SelectTrigger id="import-concurrency" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{[1, 2, 3, 4, 6, 8].map((value) => <SelectItem key={value} value={String(value)}>{value} 个并行</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <p>anydoc 直接解析正文；PDF 图片按所选策略独立处理。PDF 按物理页处理，其他格式按文档单元处理。</p>
            {!skipRecognition ? <p>anydoc 提示需要 OCR 时，仅调用多模态模型；图片描述也使用该模型，可能消耗模型额度。识别失败可重试。</p> : null}
            <p>上传原件 → 提交任务 → 服务端解析 / 必要时栅格化及 OCR → 自动生成文章。提交成功即可关闭页面，后台会继续处理。</p>
            <p>上传或提交失败可在本标签页安全重试，原件上传成功后不重复上传。首次提交的标题和选项将锁定，重试不受后续选项修改影响。未确认项仅保留在当前标签页，刷新或关闭会丢失重试上下文。</p>
          </div>
          {busy ? <p role="status" className="text-sm text-amber-700 dark:text-amber-400">原文件上传或任务提交尚未结束，暂不能关闭。成功提交后即可关闭弹窗和页面，无需等待解析或生成文章。</p> : null}
          {notice ? (
            <div role="status" className="space-y-2 rounded-md border p-3 text-sm">
              <p>已完成 {notice.completed} 个；已提交后台 {notice.submitted} 个，可关闭页面。提交不代表文章已生成。</p>
              {onViewJobs ? <Button size="sm" variant="outline" disabled={busy} onClick={() => { setNotice(null); close(); onViewJobs() }}>查看导入任务列表</Button> : null}
            </div>
          ) : null}
        </div>
      </ModalShell>
    </>
  )
}

export default DocumentImportDialog
