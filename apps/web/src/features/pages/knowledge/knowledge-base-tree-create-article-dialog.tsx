import { FileText, FileUp, Folder, Loader2, Trash2 } from "@/components/iconimate"
import * as React from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"

import {
  BATCH_IMPORT_MAX_FILES,
  buildImportFileKey,
  MARKDOWN_IMPORT_MAX_FILE_BYTES,
  resolveMarkdownImportTitle,
  validateMarkdownImportFile,
  validateMarkdownImportText,
} from "@/components/knowledge/article-editor-utils"
import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { knowledgeBaseArticleApi, knowledgeBaseNodeApi } from "@/lib/api"
import { knowledgeBaseArticlePath } from "@/lib/dashboard-routes"
import { cn } from "@/lib/utils"
import { ArticleBatchItemRow, CreateArticleFolderTree, ImportProgressFill } from "./knowledge-base-tree-create-ui"
import {
  CREATE_ARTICLE_IMPORT_STAGE_META,
  parseArticleBatchFile,
  resolveApiErrorMessage,
  toFolderTreeNodes,
  type ArticleBatchItem,
  type CreateArticleImportStage,
  type FolderTreeNode,
} from "./knowledge-base-tree-support"

export interface CreateArticleTarget {
  id: string
  name: string
}

interface KnowledgeBaseTreeCreateArticleDialogProps {
  knowledgeBaseId?: string
  open: boolean
  target: CreateArticleTarget | null
  saving: boolean
  onOpenChange: (open: boolean) => void
  onSavingChange: (saving: boolean) => void
  onCreated: (parentId: string | null) => Promise<void>
}

export function KnowledgeBaseTreeCreateArticleDialog({
  knowledgeBaseId,
  open,
  target,
  saving,
  onOpenChange,
  onSavingChange,
  onCreated,
}: KnowledgeBaseTreeCreateArticleDialogProps) {
  const navigate = useNavigate()
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const [parentId, setParentId] = React.useState<string | null>(null)
  const [parentName, setParentName] = React.useState<string | null>(null)
  const [title, setTitle] = React.useState("")
  const [folderTree, setFolderTree] = React.useState<FolderTreeNode[]>([])
  const [folderTreeLoading, setFolderTreeLoading] = React.useState(false)
  const [folderTreeError, setFolderTreeError] = React.useState<string | null>(null)
  const [markdownFile, setMarkdownFile] = React.useState<File | null>(null)
  const [markdown, setMarkdown] = React.useState("")
  const [fileError, setFileError] = React.useState<string | null>(null)
  const [dialogError, setDialogError] = React.useState<string | null>(null)
  const [importStage, setImportStage] = React.useState<CreateArticleImportStage>("idle")
  const [dragActive, setDragActive] = React.useState(false)
  const [batchItems, setBatchItems] = React.useState<ArticleBatchItem[]>([])
  const [batchParsing, setBatchParsing] = React.useState(false)
  const [batchRunning, setBatchRunning] = React.useState(false)

  const isBatch = batchItems.length > 0
  const busy = saving || importStage === "reading" || importStage === "creating" || batchParsing || batchRunning
  const readyCount = batchItems.filter((item) => item.status === "ready").length
  const doneCount = batchItems.filter((item) => item.status === "done").length
  const failedCount = batchItems.filter((item) => item.status === "failed").length
  const importMeta = CREATE_ARTICLE_IMPORT_STAGE_META[importStage]
  const targetText = parentId ? `将在 ${parentName || "所选文件夹"} 下创建` : "将在根目录创建"

  const loadFolderTree = React.useCallback(async () => {
    if (!knowledgeBaseId) {
      setFolderTree([])
      return
    }
    setFolderTreeLoading(true)
    setFolderTreeError(null)
    try {
      const res = await knowledgeBaseNodeApi.tree(knowledgeBaseId, { pageNum: 1, pageSize: 1000 })
      setFolderTree(toFolderTreeNodes(res.data.roots || []))
    } catch (error: unknown) {
      setFolderTree([])
      setFolderTreeError(resolveApiErrorMessage(error, "加载文件夹树失败"))
    } finally {
      setFolderTreeLoading(false)
    }
  }, [knowledgeBaseId])

  React.useEffect(() => {
    if (!open) return
    setParentId(target?.id ?? null)
    setParentName(target?.name ?? null)
    setTitle("")
    setFolderTree([])
    setFolderTreeError(null)
    setMarkdownFile(null)
    setMarkdown("")
    setFileError(null)
    setDialogError(null)
    setImportStage("idle")
    setDragActive(false)
    setBatchItems([])
    setBatchParsing(false)
    setBatchRunning(false)
    void loadFolderTree()
  }, [loadFolderTree, open, target])

  const clearMarkdownFile = React.useCallback(() => {
    setMarkdownFile(null)
    setMarkdown("")
    setFileError(null)
    setDialogError(null)
    setImportStage("idle")
    setDragActive(false)
    setBatchItems([])
    if (fileInputRef.current) fileInputRef.current.value = ""
  }, [])

  const updateBatchItem = React.useCallback((id: string, patch: Partial<ArticleBatchItem>) => {
    setBatchItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }, [])

  const appendBatchFiles = React.useCallback(async (existingItems: ArticleBatchItem[], files: File[]) => {
    const seenKeys = new Set(existingItems.map((item) => item.key))
    const incoming: File[] = []
    let duplicate = 0
    for (const file of files) {
      const key = buildImportFileKey(file)
      if (seenKeys.has(key)) {
        duplicate += 1
        continue
      }
      seenKeys.add(key)
      incoming.push(file)
    }
    if (duplicate > 0) toast.info(`已忽略 ${duplicate} 个重复文件`)

    const room = BATCH_IMPORT_MAX_FILES - existingItems.length
    const accepted = incoming.slice(0, Math.max(0, room))
    if (incoming.length > room) toast.error(`一次最多导入 ${BATCH_IMPORT_MAX_FILES} 篇文章，已截断多余文件`)
    if (accepted.length === 0) return

    setBatchParsing(true)
    try {
      const results = await Promise.all(accepted.map((file) => parseArticleBatchFile(file)))
      const parsedItems: ArticleBatchItem[] = []
      let failed = 0
      for (const result of results) {
        if (result.ok) parsedItems.push(result.item)
        else failed += 1
      }
      if (failed > 0) toast.error(`已忽略 ${failed} 个无法导入的文件`)
      if (parsedItems.length > 0) setBatchItems((prev) => [...prev, ...parsedItems])
    } finally {
      setBatchParsing(false)
    }
  }, [])

  const readMarkdownFile = React.useCallback(async (file: File) => {
    setDialogError(null)
    const validationError = validateMarkdownImportFile(file)
    if (validationError) {
      setMarkdownFile(null)
      setMarkdown("")
      setFileError(validationError)
      setImportStage("error")
      return
    }
    setMarkdownFile(file)
    setMarkdown("")
    setFileError(null)
    setImportStage("reading")
    try {
      const nextMarkdown = await file.text()
      const markdownError = validateMarkdownImportText(nextMarkdown)
      if (markdownError) {
        setMarkdownFile(null)
        setMarkdown("")
        setFileError(markdownError)
        setImportStage("error")
        return
      }
      setMarkdown(nextMarkdown)
      setTitle(resolveMarkdownImportTitle(nextMarkdown, file.name))
      setImportStage("ready")
    } catch {
      setMarkdownFile(null)
      setMarkdown("")
      setFileError("读取 Markdown 文件失败，请重新选择文件")
      setImportStage("error")
    }
  }, [])

  const pickFiles = React.useCallback((files: File[]) => {
    if (files.length === 0) return
    setDialogError(null)
    if (batchItems.length > 0) {
      void appendBatchFiles(batchItems, files)
      return
    }
    if ((markdownFile ? 1 : 0) + files.length <= 1) {
      const firstFile = files[0]
      if (firstFile) void readMarkdownFile(firstFile)
      return
    }
    const combined = markdownFile ? [markdownFile, ...files] : files
    setMarkdownFile(null)
    setMarkdown("")
    setFileError(null)
    setImportStage("idle")
    void appendBatchFiles([], combined)
  }, [appendBatchFiles, batchItems, markdownFile, readMarkdownFile])

  const submitBatch = React.useCallback(async () => {
    if (!knowledgeBaseId || batchRunning) return
    const targets = batchItems.filter((item) => item.status === "ready" || item.status === "failed")
    const runnable = targets.filter((item) => {
      const trimmed = item.title.trim()
      if (!trimmed || trimmed.length > 200) {
        updateBatchItem(item.id, {
          status: "failed",
          error: !trimmed ? "文章标题不能为空" : "文章标题不能超过 200 个字符",
        })
        return false
      }
      return true
    })
    if (runnable.length === 0) {
      setDialogError("没有可创建的文章，请检查文件标题")
      return
    }

    setBatchRunning(true)
    setDialogError(null)
    let succeeded = 0
    let failed = 0
    for (const item of runnable) {
      updateBatchItem(item.id, { status: "creating", error: undefined })
      try {
        const res = await knowledgeBaseArticleApi.create({
          knowledgeBaseId,
          parentId,
          title: item.title.trim(),
          contentMd: item.markdown,
          tags: [],
        })
        updateBatchItem(item.id, { status: "done", articleId: res.data.articleId, error: undefined })
        succeeded += 1
      } catch (error: unknown) {
        updateBatchItem(item.id, { status: "failed", error: resolveApiErrorMessage(error, "创建文章失败") })
        failed += 1
      }
    }
    setBatchRunning(false)
    if (succeeded > 0) await onCreated(parentId)
    if (failed === 0) {
      toast.success(`已创建 ${succeeded} 篇文章`)
      onOpenChange(false)
      setBatchItems([])
    } else {
      toast.error(`成功 ${succeeded} 篇，失败 ${failed} 篇，可重试失败项`)
    }
  }, [batchItems, batchRunning, knowledgeBaseId, onCreated, onOpenChange, parentId, updateBatchItem])

  const submit = React.useCallback(async () => {
    if (isBatch) {
      await submitBatch()
      return
    }
    if (!knowledgeBaseId) return
    const trimmedTitle = title.trim()
    if (!trimmedTitle || trimmedTitle.length > 200) {
      setDialogError(!trimmedTitle ? "文章标题不能为空" : "文章标题不能超过 200 个字符")
      return
    }
    if (importStage === "reading") {
      setFileError("Markdown 文件仍在读取中，请稍后再创建")
      return
    }
    if (markdownFile && !markdown.trim()) {
      setFileError("Markdown 文件没有可导入的正文内容")
      setImportStage("error")
      return
    }
    if (saving) return

    onSavingChange(true)
    setDialogError(null)
    if (markdownFile) {
      setFileError(null)
      setImportStage("creating")
    }
    try {
      const res = await knowledgeBaseArticleApi.create({
        knowledgeBaseId,
        parentId,
        title: trimmedTitle,
        contentMd: markdownFile ? markdown : `# ${trimmedTitle}\n\n`,
        tags: [],
      })
      toast.success("文章已创建")
      onOpenChange(false)
      await onCreated(parentId)
      navigate(knowledgeBaseArticlePath(knowledgeBaseId, res.data.articleId))
    } catch (error: unknown) {
      setDialogError(resolveApiErrorMessage(error, "创建文章失败"))
      if (markdownFile) setImportStage("error")
    } finally {
      onSavingChange(false)
    }
  }, [importStage, isBatch, knowledgeBaseId, markdown, markdownFile, navigate, onCreated, onOpenChange, onSavingChange, parentId, saving, submitBatch, title])

  return (
    <ModalShell
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && busy) return
        onOpenChange(nextOpen)
      }}
      disableClose={busy}
      title={isBatch ? "批量导入文章" : "新建文章"}
      description={targetText}
      contentClassName="sm:max-w-2xl"
      footer={<>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
        <Button
          type="button"
          disabled={busy || (isBatch ? readyCount + failedCount === 0 : !title.trim())}
          onClick={() => void submit()}
        >
          {busy ? "创建中..." : isBatch
            ? failedCount > 0 && readyCount === 0
              ? `重试失败（${failedCount}）`
              : `创建 ${readyCount + failedCount} 篇文章`
            : "创建并编辑"}
        </Button>
      </>}
    >
      <div className="space-y-4">
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,text/markdown,text/x-markdown"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ""
            pickFiles(files)
          }}
        />
        {!isBatch ? (
          <div className="space-y-2">
            <Label htmlFor="article-title">标题</Label>
            <Input
              id="article-title"
              value={title}
              placeholder="例如：产品需求梳理"
              disabled={busy}
              maxLength={200}
              onChange={(event) => { setDialogError(null); setTitle(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return
                event.preventDefault()
                void submit()
              }}
            />
          </div>
        ) : null}
        {dialogError ? <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{dialogError}</div> : null}

        <div className="space-y-2">
          <Label>{isBatch ? "Markdown 文件" : "Markdown 文件（可选）"}</Label>
          <button
            type="button"
            disabled={busy}
            className={cn(
              "flex w-full flex-col items-center justify-center gap-3 rounded-md border border-dashed px-4 py-6 text-center transition-colors",
              dragActive ? "border-primary bg-primary/5" : "border-border hover:border-primary/60 hover:bg-muted/40",
              busy ? "cursor-not-allowed opacity-70" : "cursor-pointer",
            )}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(event) => { event.preventDefault(); if (!busy) setDragActive(true) }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(event) => {
              event.preventDefault()
              setDragActive(false)
              if (!busy) pickFiles(Array.from(event.dataTransfer.files ?? []))
            }}
          >
            <span className="flex size-10 items-center justify-center rounded-md border bg-background text-muted-foreground"><FileUp className="size-5" /></span>
            <span className="max-w-full space-y-1">
              <span className="block text-sm font-medium">拖拽 Markdown 文件到这里，或点击选择（可多选批量导入）</span>
              <span className="block break-words text-xs text-muted-foreground">
                支持 .md / .markdown，单个文件不超过 {MARKDOWN_IMPORT_MAX_FILE_BYTES / 1024 / 1024} MB，一次最多 {BATCH_IMPORT_MAX_FILES} 个
              </span>
            </span>
          </button>
          {batchParsing ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在读取 Markdown 文件…</div> : null}
          {isBatch ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  共 {batchItems.length} 个文件{doneCount > 0 ? `，已创建 ${doneCount} 篇` : ""}{failedCount > 0 ? `，失败 ${failedCount} 篇` : ""}
                </p>
                {!busy ? <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setBatchItems([])}>清空</Button> : null}
              </div>
              <div className="flex max-h-64 flex-col gap-2 overflow-auto app-scrollbar pr-1">
                {batchItems.map((item) => (
                  <ArticleBatchItemRow
                    key={item.id}
                    item={item}
                    busy={busy}
                    onTitleChange={(nextTitle) => updateBatchItem(item.id, { title: nextTitle })}
                    onRemove={() => setBatchItems((prev) => prev.filter((entry) => entry.id !== item.id))}
                  />
                ))}
              </div>
            </div>
          ) : <>
            {markdownFile ? (
              <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2"><FileText className="size-4 shrink-0 text-muted-foreground" /><div className="min-w-0"><div className="truncate text-sm font-medium">{markdownFile.name}</div><div className="text-xs text-muted-foreground">{(markdownFile.size / 1024).toFixed(1)} KB</div></div></div>
                <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" disabled={busy} aria-label="移除 Markdown 文件" onClick={clearMarkdownFile}><Trash2 className="size-4" /></Button>
              </div>
            ) : null}
            {importStage !== "idle" ? (
              <div className="space-y-1.5">
                <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={importMeta.progress} className={cn("h-2 overflow-hidden rounded-full bg-muted", importStage === "error" ? "bg-destructive/15" : "")}><ImportProgressFill progress={importMeta.progress} error={importStage === "error"} /></div>
                <div className={cn("text-xs", importStage === "error" ? "text-destructive" : "text-muted-foreground")}>{importMeta.label}</div>
              </div>
            ) : null}
            {fileError ? <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{fileError}</div> : null}
          </>}
        </div>

        <div className="space-y-2">
          <Label>创建位置</Label>
          <div className="rounded-md border p-3">
            <div className="flex items-center gap-2">
              <Checkbox checked={parentId === null} disabled={busy} aria-label="选择根目录作为创建位置" onCheckedChange={() => { setDialogError(null); setParentId(null); setParentName(null) }} />
              <Folder className="size-4 shrink-0 text-blue-500" /><span className="truncate text-sm">根目录</span>
            </div>
            <div className="mt-3 max-h-64 overflow-auto app-scrollbar pr-1">
              {folderTreeLoading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在加载文件夹树…</div>
                : folderTreeError ? <div className="space-y-2 text-sm"><div className="text-destructive">{folderTreeError}</div><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void loadFolderTree()}>重试</Button></div>
                : <CreateArticleFolderTree roots={folderTree} selectedFolderId={parentId} disabled={busy} onSelectFolder={(folder) => { setDialogError(null); setParentId(folder?.id ?? null); setParentName(folder?.name ?? null) }} />}
            </div>
          </div>
        </div>
      </div>
    </ModalShell>
  )
}
