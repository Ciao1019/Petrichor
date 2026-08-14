"use client"

import * as React from "react"
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Grid2X2,
  Link2,
  List,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
  Tags,
  Upload,
} from "lucide-react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { FileIcon } from "@/components/kibo-ui/tree/file-icon"
import { ActionMenu } from "@/components/petrichor-ui/action-menu"
import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { FileUpload } from "@/components/extend/ui/file-upload"
import {
  createDefaultParseConfig,
  DocumentParseConfigDialog,
} from "@/components/knowledge/DocumentParseConfigDialog"
import { DocumentPipelinePanel } from "@/components/knowledge/DocumentPipelinePanel"
import { rasterizePdfPages } from "@/components/knowledge/document-rasterizer"
import { detectFileType, parseDocument, pickPagesNeedingVision } from "@/features/pages/knowledge/documents/parse"
import {
  aiModelConfigApi,
  knowledgeBaseDocumentApi,
  uploadApi,
  type AiModelConfigResponse,
  type KBDocument,
  type KBDocumentDetail,
  type KBDocumentFolder,
  type KBDocumentPageImage,
  type KBDocumentParseConfig,
  type KBDocumentStatus,
  type KnowledgeBaseResponse,
} from "@/lib/api"
import { knowledgeBaseDocumentPath } from "@/lib/dashboard-routes"
import { isDemoMode } from "@/lib/demo/demo-mode"
import { cn } from "@/lib/utils"

const ACCEPT = ".md,.markdown,.pdf,.docx,.xlsx,.xls,.csv,.tsv"
const VIEW_KEY = "petrichor.kb.documents.view"

function apiError(error: unknown, fallback: string) {
  return (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
    (error instanceof Error ? error.message : fallback)
}

function formatBytes(value: number | null) {
  if (!value) return "-"
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const yy = String(date.getFullYear()).slice(2)
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")
  return `${yy}-${month}-${day} ${hours}:${minutes}`
}

function documentSummary(document: KBDocument) {
  if (document.summary?.trim()) return document.summary.trim()
  if (document.status === "failed") return document.error || "文件解析失败，请重新解析"
  if (document.status === "pending" || document.status === "processing") return "文件正在解析与切片，完成后可浏览原文和分片。"
  return `本文档已解析为 ${document.chunkCount} 个可检索分片${document.pageCount ? `，共 ${document.pageCount} 页` : ""}。点击卡片查看原文、解析文本与分片。`
}

function statusMeta(status: KBDocumentStatus) {
  return {
    pending: { label: "等待处理", className: "text-amber-600 dark:text-amber-400" },
    processing: { label: "处理中", className: "text-primary" },
    partial: { label: "部分完成", className: "text-amber-600 dark:text-amber-400" },
    failed: { label: "处理失败", className: "text-destructive" },
    ready: { label: "可检索", className: "text-emerald-600 dark:text-emerald-400" },
  }[status]
}

function FolderCount({ count }: { count: number }) {
  return <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>
}

export function KnowledgeBaseDocumentsTab({
  knowledgeBase,
  onChanged,
}: {
  knowledgeBase: KnowledgeBaseResponse
  onChanged: () => Promise<void>
}) {
  const navigate = useNavigate()
  const [folders, setFolders] = React.useState<KBDocumentFolder[]>([])
  const [documents, setDocuments] = React.useState<KBDocument[]>([])
  const [activeFolderId, setActiveFolderId] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState("")
  const [fileType, setFileType] = React.useState("all")
  const [status, setStatus] = React.useState("all")
  const [view, setView] = React.useState<"grid" | "list">(() => {
    if (typeof window === "undefined") return "grid"
    return window.localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"
  })
  const [directoryCollapsed, setDirectoryCollapsed] = React.useState(false)
  const [expandedFolders, setExpandedFolders] = React.useState<Set<string>>(new Set())
  const [loading, setLoading] = React.useState(true)
  const [uploadOpen, setUploadOpen] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const [uploadMessage, setUploadMessage] = React.useState("")
  const [tag, setTag] = React.useState("all")
  const [knownTags, setKnownTags] = React.useState<string[]>([])
  // 选好文件后先弹解析配置，确认了才真正上传。
  const [stagedFiles, setStagedFiles] = React.useState<File[]>([])
  const [parseConfig, setParseConfig] = React.useState<KBDocumentParseConfig>(() => createDefaultParseConfig())
  const [configOpen, setConfigOpen] = React.useState(false)
  const [visionModels, setVisionModels] = React.useState<AiModelConfigResponse[]>([])
  const [visionModelsLoading, setVisionModelsLoading] = React.useState(false)
  const [pipelineTarget, setPipelineTarget] = React.useState<{ id: string; title: string } | null>(null)
  const [folderOpen, setFolderOpen] = React.useState(false)
  const [folderName, setFolderName] = React.useState("")
  const [folderParentId, setFolderParentId] = React.useState<string>("root")
  const [folderEditTarget, setFolderEditTarget] = React.useState<KBDocumentFolder | null>(null)
  const [folderDeleteTarget, setFolderDeleteTarget] = React.useState<KBDocumentFolder | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<KBDocument | null>(null)
  const [moveTarget, setMoveTarget] = React.useState<KBDocument | null>(null)
  const [moveFolderId, setMoveFolderId] = React.useState<string>("root")
  const [saving, setSaving] = React.useState(false)
  const [vectorStatus, setVectorStatus] = React.useState<{ supported: boolean; total: number; embedded: number; pending: number } | null>(null)
  const [vectorizing, setVectorizing] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const [foldersResponse, documentsResponse, embeddingResponse, tagsResponse] = await Promise.all([
        knowledgeBaseDocumentApi.listFolders(knowledgeBase.id),
        knowledgeBaseDocumentApi.listDocuments(knowledgeBase.id),
        knowledgeBaseDocumentApi.embeddingStatus(knowledgeBase.id).catch(() => null),
        knowledgeBaseDocumentApi.listTags(knowledgeBase.id).catch(() => null),
      ])
      setFolders(foldersResponse.data.folders)
      setDocuments(documentsResponse.data.documents)
      setVectorStatus(embeddingResponse?.data.status ?? null)
      setKnownTags((tagsResponse?.data.tags ?? []).map((item) => item.tag))
      setExpandedFolders((current) => current.size ? current : new Set(foldersResponse.data.folders.filter((folder) => folder.parentId === null).map((folder) => folder.id)))
    } catch (error) {
      toast.error(apiError(error, "加载文件失败"))
    } finally {
      setLoading(false)
    }
  }, [knowledgeBase.id])

  React.useEffect(() => { void load() }, [load])
  React.useEffect(() => { window.localStorage.setItem(VIEW_KEY, view) }, [view])

  // 旧的 ?documentId=&chunk= 深链（检索引用、Agent 回链）改为跳转到文档预览页。
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const documentId = params.get("documentId")
    if (!documentId) return
    const chunk = params.get("chunk")
    navigate(`${knowledgeBaseDocumentPath(knowledgeBase.id, documentId)}${chunk ? `?chunk=${chunk}` : ""}`, { replace: true })
  }, [knowledgeBase.id, navigate])

  const foldersByParent = React.useMemo(() => {
    const map = new Map<string | null, KBDocumentFolder[]>()
    for (const folder of folders) {
      const list = map.get(folder.parentId) ?? []
      list.push(folder)
      map.set(folder.parentId, list)
    }
    return map
  }, [folders])

  const descendantIds = React.useCallback((folderId: string) => {
    const ids = new Set<string>([folderId])
    const queue = [folderId]
    while (queue.length) {
      const parentId = queue.shift()!
      for (const child of foldersByParent.get(parentId) ?? []) {
        if (ids.has(child.id)) continue
        ids.add(child.id)
        queue.push(child.id)
      }
    }
    return ids
  }, [foldersByParent])

  const recursiveFolderCount = React.useCallback((folderId: string) => {
    const ids = descendantIds(folderId)
    return documents.filter((document) => document.folderId && ids.has(document.folderId)).length
  }, [descendantIds, documents])

  const currentChildFolders = foldersByParent.get(activeFolderId) ?? []
  const activeFolder = activeFolderId ? folders.find((folder) => folder.id === activeFolderId) ?? null : null
  const breadcrumbs = React.useMemo(() => {
    if (!activeFolder) return []
    const byId = new Map(folders.map((folder) => [folder.id, folder]))
    const chain: KBDocumentFolder[] = []
    let current: KBDocumentFolder | undefined = activeFolder
    const visited = new Set<string>()
    while (current && !visited.has(current.id)) {
      visited.add(current.id)
      chain.unshift(current)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    return chain
  }, [activeFolder, folders])

  const visibleDocuments = React.useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return documents.filter((document) => {
      if (!needle && document.folderId !== activeFolderId) return false
      if (needle && !`${document.title} ${document.fileName} ${document.summary ?? ""}`.toLocaleLowerCase().includes(needle)) return false
      if (fileType !== "all" && document.fileType !== fileType) return false
      if (status !== "all" && document.status !== status) return false
      if (tag !== "all" && !(document.tags ?? []).includes(tag)) return false
      return true
    })
  }, [activeFolderId, documents, fileType, search, status, tag])

  // 多模态模型只在打开解析配置时才需要，按需加载一次。
  React.useEffect(() => {
    if (!configOpen || visionModels.length > 0 || visionModelsLoading) return
    let canceled = false
    setVisionModelsLoading(true)
    void aiModelConfigApi
      .list({ configType: "VISION", pageNum: 1, pageSize: 100, enabled: true })
      .then((response) => {
        if (canceled) return
        const rows = response.data.rows || []
        setVisionModels(rows)
        const preferred = rows.find((row) => row.isDefault) || rows[0]
        if (preferred) {
          setParseConfig((current) =>
            current.multimodal.modelConfigId
              ? current
              : { ...current, multimodal: { ...current.multimodal, modelConfigId: preferred.id } }
          )
        }
      })
      .catch(() => {
        if (!canceled) setVisionModels([])
      })
      .finally(() => {
        if (!canceled) setVisionModelsLoading(false)
      })
    return () => {
      canceled = true
    }
  }, [configOpen, visionModels.length, visionModelsLoading])

  /**
   * 上传单个文件。
   *
   * 开启图像处理时，扫描页由浏览器栅格化后直传对象存储——服务端没有 PDF
   * 渲染能力，页面图片只能在这里产出。注册接口拿到对象键后立即返回，
   * 识别本身由后台流水线完成。
   */
  const uploadOne = React.useCallback(async (file: File, config: KBDocumentParseConfig) => {
    const detectedType = detectFileType(file)
    if (!detectedType) throw new Error(`不支持的文件类型：${file.name}`)
    setUploadMessage(`正在上传 ${file.name}…`)
    const objectKey = isDemoMode() ? `uploads/demo-user/${Date.now()}-${file.name}` : await uploadFile(file)
    setUploadMessage(`正在解析 ${file.name}…`)
    const parsed = await parseDocument(file, detectedType)

    let pageImages: KBDocumentPageImage[] = []
    if (config.multimodal.enabled && detectedType === "pdf" && !isDemoMode()) {
      const targets = pickPagesNeedingVision(parsed, config.parseEngine)
      if (targets.length > 0) {
        setUploadMessage(`正在渲染 ${file.name} 的 ${targets.length} 个待识别页面…`)
        const rendered = await rasterizePdfPages(file, targets, {
          onProgress: (done, total) => setUploadMessage(`正在渲染页面 ${done}/${total}…`),
        })
        setUploadMessage(`正在上传 ${rendered.length} 张页面图片…`)
        pageImages = await Promise.all(
          rendered.map(async (page) => ({
            pageNo: page.pageNo,
            imageKey: await uploadBlob(page.blob, `page-${page.pageNo}.jpg`, "image/jpeg"),
          }))
        )
      }
    }

    const response = await knowledgeBaseDocumentApi.registerDocument({
      knowledgeBaseId: knowledgeBase.id,
      folderId: activeFolderId,
      fileName: file.name,
      fileType: detectedType,
      contentType: file.type || null,
      objectKey,
      sizeBytes: file.size,
      pageCount: parsed.pageCount,
      blocks: parsed.blocks,
      extractedText: parsed.extractedText,
      segments: parsed.segments,
      parseConfig: config,
      pageImages,
    })
    return response.data.id
  }, [activeFolderId, knowledgeBase.id])

  const handleFiles = React.useCallback(async (files: File[], config: KBDocumentParseConfig) => {
    setUploading(true)
    let success = 0
    const documentIds: string[] = []
    for (const file of files) {
      try {
        documentIds.push(await uploadOne(file, config))
        success += 1
      } catch (error) {
        toast.error(apiError(error, `${file.name} 处理失败`))
      }
    }
    setUploading(false)
    setUploadMessage("")
    if (success > 0) {
      toast.success(`已提交 ${success} 个文件，正在后台解析${knowledgeBase.wikiEnabled ? "；完成后将自动构建 Wiki" : ""}`)
      setConfigOpen(false)
      setUploadOpen(false)
      setStagedFiles([])
      await Promise.all([load(), onChanged()])
      // 单个文件时直接把流水线面板打开，进度和耗时都在那里看。
      if (documentIds.length === 1) {
        setPipelineTarget({ id: documentIds[0], title: files[0]?.name ?? "处理流水线" })
      }
    }
  }, [knowledgeBase.id, knowledgeBase.wikiEnabled, load, onChanged, uploadOne])

  const stageFiles = React.useCallback((files: File[]) => {
    if (files.length === 0) return
    setStagedFiles(files)
    // 模型列表只在首次打开时拉取，所以这里直接从已加载的列表里挑默认项；
    // 只靠那个 effect 的话，第二次打开配置弹窗就选不上模型了。
    const preferred = visionModels.find((row) => row.isDefault) || visionModels[0]
    const base = createDefaultParseConfig()
    setParseConfig(preferred ? { ...base, multimodal: { ...base.multimodal, modelConfigId: preferred.id } } : base)
    setUploadOpen(false)
    setConfigOpen(true)
  }, [visionModels])

  const createFolder = React.useCallback(async () => {
    const name = folderName.trim()
    if (!name) return
    setSaving(true)
    try {
      await knowledgeBaseDocumentApi.saveFolder({ id: folderEditTarget?.id, knowledgeBaseId: knowledgeBase.id, parentId: folderParentId === "root" ? null : folderParentId, name })
      toast.success(folderEditTarget ? "目录已更新" : "目录已创建")
      setFolderOpen(false)
      setFolderName("")
      setFolderParentId("root")
      setFolderEditTarget(null)
      await load()
    } catch (error) {
      toast.error(apiError(error, "保存目录失败"))
    } finally {
      setSaving(false)
    }
  }, [folderEditTarget, folderName, folderParentId, knowledgeBase.id, load])

  const openCreateFolder = React.useCallback(() => {
    setFolderEditTarget(null)
    setFolderName("")
    setFolderParentId(activeFolderId ?? "root")
    setFolderOpen(true)
  }, [activeFolderId])

  const openEditFolder = React.useCallback((folder: KBDocumentFolder) => {
    setFolderEditTarget(folder)
    setFolderName(folder.name)
    setFolderParentId(folder.parentId ?? "root")
    setFolderOpen(true)
  }, [])

  const deleteFolder = React.useCallback(async () => {
    if (!folderDeleteTarget) return
    setSaving(true)
    try {
      await knowledgeBaseDocumentApi.deleteFolder(folderDeleteTarget.id, true)
      if (activeFolderId === folderDeleteTarget.id) setActiveFolderId(null)
      setFolderDeleteTarget(null)
      toast.success("目录已删除，其中内容已移到根目录")
      await load()
    } catch (error) {
      toast.error(apiError(error, "删除目录失败"))
    } finally {
      setSaving(false)
    }
  }, [activeFolderId, folderDeleteTarget, load])

  const runVectorization = React.useCallback(async (documentId?: string, rebuild = false) => {
    setVectorizing(true)
    try {
      const response = await knowledgeBaseDocumentApi.runEmbedding(knowledgeBase.id, documentId, rebuild)
      setVectorStatus(response.data.status)
      toast.success(`已向量化 ${response.data.embedded} 个分片`)
    } catch (error) {
      toast.error(apiError(error, "向量化失败，请检查 Embedding 模型配置"))
    } finally {
      setVectorizing(false)
    }
  }, [knowledgeBase.id])

  const rechunkDocument = React.useCallback(async (document: KBDocument) => {
    setSaving(true)
    try {
      // 正文、分段边界与上次的解析配置都已随文件存在服务端，重解析不需要重新上传。
      // 多模态要用的页面图片没法在这里重新产出，所以这一次会跳过多模态阶段。
      await knowledgeBaseDocumentApi.rechunkDocument({ id: document.id })
      toast.success("已提交重新解析，正在后台执行")
      setPipelineTarget({ id: document.id, title: document.title })
      await load()
    } catch (error) {
      toast.error(apiError(error, "重新解析失败"))
    } finally {
      setSaving(false)
    }
  }, [load])

  const openDocument = React.useCallback((id: string) => {
    navigate(knowledgeBaseDocumentPath(knowledgeBase.id, id))
  }, [knowledgeBase.id, navigate])

  const deleteDocument = React.useCallback(async () => {
    if (!deleteTarget) return
    setSaving(true)
    try {
      await knowledgeBaseDocumentApi.deleteDocument(deleteTarget.id)
      toast.success(knowledgeBase.wikiEnabled ? "文件已删除，Wiki 将在后台重整" : "文件已删除")
      setDeleteTarget(null)
      await Promise.all([load(), onChanged()])
    } catch (error) {
      toast.error(apiError(error, "删除失败"))
    } finally {
      setSaving(false)
    }
  }, [deleteTarget, load, onChanged])

  const openMove = React.useCallback((document: KBDocument) => {
    setMoveTarget(document)
    setMoveFolderId(document.folderId ?? "root")
  }, [])

  const moveDocument = React.useCallback(async () => {
    if (!moveTarget) return
    setSaving(true)
    try {
      await knowledgeBaseDocumentApi.moveDocument(moveTarget.id, moveFolderId === "root" ? null : moveFolderId)
      toast.success("文件已移动")
      setMoveTarget(null)
      await load()
    } catch (error) {
      toast.error(apiError(error, "移动失败"))
    } finally {
      setSaving(false)
    }
  }, [load, moveFolderId, moveTarget])

  const toggleExpanded = React.useCallback((folderId: string) => {
    setExpandedFolders((current) => {
      const next = new Set(current)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }, [])

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside className={cn("hidden min-h-0 shrink-0 flex-col border-r pr-3 lg:flex", directoryCollapsed ? "w-11" : "w-[268px]")}>
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 px-1">
          {!directoryCollapsed ? <span className="text-sm font-semibold">目录</span> : null}
          <div className="ml-auto flex items-center">
            {!directoryCollapsed ? <Button variant="ghost" size="icon-sm" onClick={openCreateFolder} aria-label="新建目录"><FolderPlus className="size-4" /></Button> : null}
            <Button variant="ghost" size="icon-sm" onClick={() => setDirectoryCollapsed((value) => !value)} aria-label={directoryCollapsed ? "展开目录" : "收起目录"}>
              {directoryCollapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
            </Button>
          </div>
        </div>
        {!directoryCollapsed ? (
          <ScrollArea className="min-h-0 flex-1">
            <nav className="space-y-0.5 py-1 pr-1">
              <DirectoryRow active={activeFolderId === null} icon={activeFolderId === null ? FolderOpen : Folder} label="根目录" count={documents.length} onClick={() => setActiveFolderId(null)} />
              <FolderTree
                parentId={null}
                depth={1}
                foldersByParent={foldersByParent}
                activeFolderId={activeFolderId}
                expandedFolders={expandedFolders}
                count={recursiveFolderCount}
                onToggle={toggleExpanded}
                onSelect={setActiveFolderId}
                onEdit={openEditFolder}
                onDelete={setFolderDeleteTarget}
              />
            </nav>
          </ScrollArea>
        ) : null}
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:pl-4">
        <div className="flex shrink-0 flex-wrap items-center gap-1 pb-2 text-xs text-muted-foreground">
          <button type="button" className="rounded px-1 py-0.5 hover:bg-muted hover:text-primary" onClick={() => setActiveFolderId(null)}>根目录</button>
          {breadcrumbs.map((folder, index) => <React.Fragment key={folder.id}><ChevronRight className="size-3" /><button type="button" className={cn("max-w-48 truncate rounded px-1 py-0.5", index === breadcrumbs.length - 1 ? "font-medium text-foreground" : "hover:bg-muted hover:text-primary")} onClick={() => setActiveFolderId(folder.id)}>{folder.name}</button></React.Fragment>)}
        </div>

        <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] gap-2 pb-2">
          <div className="relative min-w-0">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文档名称…" className="h-9 border-transparent bg-muted/70 pl-9 shadow-none focus-visible:border-ring" />
          </div>
          <div className="flex items-center gap-1.5">
            <div className="hidden rounded-lg bg-muted/70 p-0.5 sm:flex">
              <Button size="icon-sm" variant={view === "grid" ? "secondary" : "ghost"} className="size-8" onClick={() => setView("grid")} aria-label="卡片视图"><Grid2X2 className="size-4" /></Button>
              <Button size="icon-sm" variant={view === "list" ? "secondary" : "ghost"} className="size-8" onClick={() => setView("list")} aria-label="列表视图"><List className="size-4" /></Button>
            </div>
            <Button variant="ghost" size="icon" className="size-9" onClick={openCreateFolder} aria-label="新建目录"><FolderPlus className="size-[18px]" /></Button>
            <Button size="sm" className="h-9 px-3" onClick={() => setUploadOpen(true)}><FilePlus2 className="size-4" /><span className="hidden sm:inline">添加文档</span></Button>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 overflow-x-auto pb-3 [scrollbar-width:thin]">
          <FilterSelect icon={Tags} value={tag} onValueChange={setTag} label="全部标签" disabled={knownTags.length === 0}>
            <SelectItem value="all">全部标签</SelectItem>
            {knownTags.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
          </FilterSelect>
          <FilterSelect icon={FileText} value={fileType} onValueChange={setFileType} label="全部类型">
            <SelectItem value="all">全部类型</SelectItem>
            {["md", "markdown", "pdf", "docx", "xlsx", "xls", "csv", "tsv"].map((type) => <SelectItem key={type} value={type}>{type.toUpperCase()}</SelectItem>)}
          </FilterSelect>
          <FilterSelect icon={CheckCircle2} value={status} onValueChange={setStatus} label="全部状态">
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="ready">可检索</SelectItem><SelectItem value="processing">处理中</SelectItem><SelectItem value="pending">等待处理</SelectItem><SelectItem value="partial">部分完成</SelectItem><SelectItem value="failed">处理失败</SelectItem>
          </FilterSelect>
          <FilterSelect icon={Link2} value="upload" onValueChange={() => undefined} label="本地上传" disabled />
          {vectorStatus ? <Badge variant="outline" className="h-9 shrink-0 rounded-lg px-3 font-normal">向量 {vectorStatus.embedded}/{vectorStatus.total}</Badge> : null}
          <Button variant="outline" size="sm" className="h-9 shrink-0" disabled={vectorizing || !vectorStatus?.pending} onClick={() => void runVectorization()}>{vectorizing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}补齐向量</Button>
        </div>

        <ScrollArea className="min-h-0 flex-1 pr-2">
          {loading ? (
            <div className="flex min-h-[420px] items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />正在加载…</div>
          ) : visibleDocuments.length === 0 && currentChildFolders.length === 0 ? (
            <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
              <div className="flex size-12 items-center justify-center rounded-xl bg-muted"><Upload className="size-5" /></div>
              <div><p className="font-medium text-foreground">{search || fileType !== "all" || status !== "all" ? "没有匹配的文档" : "这里还没有文档"}</p><p className="mt-1">支持 Markdown、PDF、Word、Excel、CSV</p></div>
              <Button variant="outline" onClick={() => setUploadOpen(true)}>上传第一个文件</Button>
            </div>
          ) : view === "grid" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3 pb-6">
              {!search && currentChildFolders.map((folder) => <FolderCard key={folder.id} folder={folder} count={recursiveFolderCount(folder.id)} onOpen={() => setActiveFolderId(folder.id)} />)}
              {visibleDocuments.map((document) => (
                <DocumentCard
                  key={document.id}
                  document={document}
                  folderName={folders.find((folder) => folder.id === document.folderId)?.name}
                  onOpen={() => openDocument(document.id)}
                  onPipeline={() => setPipelineTarget({ id: document.id, title: document.title })}
                  onMove={() => openMove(document)}
                  onRechunk={() => void rechunkDocument(document)}
                  onVectorize={() => void runVectorization(document.id, true)}
                  onDelete={() => setDeleteTarget(document)}
                />
              ))}
            </div>
          ) : (
            <DocumentList
              folders={!search ? currentChildFolders : []}
              documents={visibleDocuments}
              folderCount={recursiveFolderCount}
              onOpenFolder={setActiveFolderId}
              onOpenDocument={(document) => openDocument(document.id)}
              onPipeline={(document) => setPipelineTarget({ id: document.id, title: document.title })}
              onMove={openMove}
              onRechunk={(document) => void rechunkDocument(document)}
              onVectorize={(document) => void runVectorization(document.id, true)}
              onDelete={setDeleteTarget}
            />
          )}
        </ScrollArea>
      </section>

      <ModalShell open={folderOpen} onOpenChange={(open) => { setFolderOpen(open); if (!open) setFolderEditTarget(null) }} title={folderEditTarget ? "编辑目录" : "新建目录"} description="目录支持嵌套、重命名与移动。" footer={<><Button variant="secondary" onClick={() => setFolderOpen(false)}>取消</Button><Button disabled={saving || !folderName.trim()} onClick={() => void createFolder()}>{folderEditTarget ? "保存" : "创建"}</Button></>}>
        <div className="space-y-4"><div className="space-y-2"><Label htmlFor="kb-folder-name">目录名称</Label><Input id="kb-folder-name" value={folderName} onChange={(event) => setFolderName(event.target.value)} /></div><div className="space-y-2"><Label>父目录</Label><Select value={folderParentId} onValueChange={setFolderParentId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="root">知识库根目录</SelectItem>{folders.filter((folder) => folder.id !== folderEditTarget?.id).map((folder) => <SelectItem key={folder.id} value={folder.id}>{folder.name}</SelectItem>)}</SelectContent></Select></div></div>
      </ModalShell>
      <ModalShell open={Boolean(folderDeleteTarget)} onOpenChange={(open) => !open && !saving && setFolderDeleteTarget(null)} title="删除目录？" description={folderDeleteTarget ? `将删除“${folderDeleteTarget.name}”，其中的文件与子目录移到知识库根目录。` : ""} footer={<><Button variant="secondary" onClick={() => setFolderDeleteTarget(null)}>取消</Button><Button variant="destructive" disabled={saving} onClick={() => void deleteFolder()}>删除目录</Button></>} />
      <ModalShell open={uploadOpen} onOpenChange={(open) => !uploading && setUploadOpen(open)} disableClose={uploading} title="上传知识文件" description={`上传到${activeFolder ? `“${activeFolder.name}”` : "根目录"}，下一步可为本次解析单独配置分块、图像处理与 AI 问题生成。`} contentClassName="sm:max-w-xl">
        <FileUpload accept={ACCEPT} multiple showFileList={false} title="拖拽文件到此处，或点击选择" description="支持 Markdown / PDF / Word / Excel / CSV" onFilesAccepted={stageFiles} />
      </ModalShell>

      <DocumentParseConfigDialog
        open={configOpen}
        onOpenChange={(open) => {
          if (uploading) return
          setConfigOpen(open)
          if (!open) setStagedFiles([])
        }}
        knowledgeBase={knowledgeBase}
        fileNames={stagedFiles.map((file) => file.name)}
        availableTags={knownTags}
        visionModels={visionModels}
        visionModelsLoading={visionModelsLoading}
        value={parseConfig}
        onChange={setParseConfig}
        busy={uploading}
        onConfirm={() => void handleFiles(stagedFiles, parseConfig)}
      />

      {uploading ? (
        <ModalShell open onOpenChange={() => undefined} disableClose title="正在提交" description="文件上传完成后即可关闭，解析在后台继续。" contentClassName="sm:max-w-md">
          <div className="flex min-h-32 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            {uploadMessage}
          </div>
        </ModalShell>
      ) : null}

      <DocumentPipelinePanel
        documentId={pipelineTarget?.id ?? null}
        documentTitle={pipelineTarget?.title}
        onOpenChange={(open) => !open && setPipelineTarget(null)}
        onFinished={() => void load()}
        onReparse={() => {
          const target = documents.find((document) => document.id === pipelineTarget?.id)
          if (target) void rechunkDocument(target)
        }}
      />
      <ModalShell open={Boolean(deleteTarget)} onOpenChange={(open) => !open && !saving && setDeleteTarget(null)} title="删除文件？" description={deleteTarget ? `将删除“${deleteTarget.title}”、分片与远程原文件。Wiki 页面会在后台重新整理。` : ""} footer={<><Button variant="secondary" onClick={() => setDeleteTarget(null)}>取消</Button><Button variant="destructive" disabled={saving} onClick={() => void deleteDocument()}>删除</Button></>} />
      <ModalShell open={Boolean(moveTarget)} onOpenChange={(open) => !open && !saving && setMoveTarget(null)} title="移动到目录" description={moveTarget ? `选择“${moveTarget.title}”的新目录。` : ""} footer={<><Button variant="secondary" onClick={() => setMoveTarget(null)}>取消</Button><Button disabled={saving} onClick={() => void moveDocument()}>移动</Button></>}>
        <div className="space-y-2"><Label>目标目录</Label><Select value={moveFolderId} onValueChange={setMoveFolderId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="root">知识库根目录</SelectItem>{folders.map((folder) => <SelectItem key={folder.id} value={folder.id}>{folder.name}</SelectItem>)}</SelectContent></Select></div>
      </ModalShell>

    </div>
  )
}

function FilterSelect({ icon: Icon, value, onValueChange, label, children, disabled }: { icon: React.ComponentType<{ className?: string }>; value: string; onValueChange: (value: string) => void; label: string; children?: React.ReactNode; disabled?: boolean }) {
  return <Select value={value} onValueChange={onValueChange} disabled={disabled}><SelectTrigger className="h-9 min-w-36 shrink-0 border-transparent bg-muted/70 shadow-none"><Icon className="size-4 text-muted-foreground" /><SelectValue placeholder={label} /><ChevronDown className="ml-auto size-3.5 text-muted-foreground" /></SelectTrigger><SelectContent>{children ?? <SelectItem value={value}>{label}</SelectItem>}</SelectContent></Select>
}

function DirectoryRow({ active, icon: Icon, label, count, onClick, depth = 0, prefix, menu }: { active: boolean; icon: React.ComponentType<{ className?: string }>; label: string; count: number; onClick: () => void; depth?: number; prefix?: React.ReactNode; menu?: React.ReactNode }) {
  return <div className={cn("group flex h-8 items-center rounded-md pr-1 text-sm transition-colors", active ? "bg-muted text-primary" : "hover:bg-muted/70")} style={{ paddingLeft: `${Math.min(depth, 5) * 10 + 4}px` }}>{prefix}<button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={onClick}><Icon className="size-4 shrink-0" /><span className="truncate">{label}</span><FolderCount count={count} /></button>{menu}</div>
}

function FolderTree({ parentId, depth, foldersByParent, activeFolderId, expandedFolders, count, onToggle, onSelect, onEdit, onDelete }: { parentId: string | null; depth: number; foldersByParent: Map<string | null, KBDocumentFolder[]>; activeFolderId: string | null; expandedFolders: Set<string>; count: (id: string) => number; onToggle: (id: string) => void; onSelect: (id: string) => void; onEdit: (folder: KBDocumentFolder) => void; onDelete: (folder: KBDocumentFolder) => void }) {
  return <>{(foldersByParent.get(parentId) ?? []).map((folder) => { const hasChildren = (foldersByParent.get(folder.id)?.length ?? 0) > 0; const expanded = expandedFolders.has(folder.id); return <React.Fragment key={folder.id}><DirectoryRow active={activeFolderId === folder.id} icon={expanded ? FolderOpen : Folder} label={folder.name} count={count(folder.id)} depth={depth} onClick={() => onSelect(folder.id)} prefix={hasChildren ? <button type="button" className="mr-0.5 flex size-4 shrink-0 items-center justify-center rounded hover:bg-background" onClick={(event) => { event.stopPropagation(); onToggle(folder.id) }}>{expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}</button> : <span className="mr-0.5 size-4 shrink-0" />} menu={<ActionMenu trigger={<Button variant="ghost" size="icon-sm" className="size-6 opacity-0 group-hover:opacity-100" aria-label="目录操作"><MoreHorizontal className="size-3.5" /></Button>}><DropdownMenuItem onClick={() => onEdit(folder)}>重命名 / 移动</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem className="text-destructive" onClick={() => onDelete(folder)}>删除目录</DropdownMenuItem></ActionMenu>} />{expanded ? <FolderTree parentId={folder.id} depth={depth + 1} foldersByParent={foldersByParent} activeFolderId={activeFolderId} expandedFolders={expandedFolders} count={count} onToggle={onToggle} onSelect={onSelect} onEdit={onEdit} onDelete={onDelete} /> : null}</React.Fragment> })}</>
}

function FolderCard({ folder, count, onOpen }: { folder: KBDocumentFolder; count: number; onOpen: () => void }) {
  return <button type="button" className="flex h-[150px] min-w-0 flex-col overflow-hidden rounded-lg border bg-card text-left shadow-xs transition hover:border-primary/35 hover:shadow-md" onClick={onOpen}><div className="flex min-h-0 flex-1 flex-col gap-3 p-4"><Folder className="size-7 text-primary" /><span className="line-clamp-2 text-sm font-semibold">{folder.name}</span></div><div className="border-t px-4 py-2 text-xs text-muted-foreground">{count} 个文档</div></button>
}

function DocumentActions({ onOpen, onPipeline, onMove, onRechunk, onVectorize, onDelete }: { onOpen: () => void; onPipeline: () => void; onMove: () => void; onRechunk: () => void; onVectorize: () => void; onDelete: () => void }) {
  return <ActionMenu trigger={<Button type="button" variant="ghost" size="icon-sm" className="size-7" aria-label="文档操作"><MoreHorizontal className="size-4" /></Button>}><DropdownMenuItem onClick={onOpen}>查看原文与分片</DropdownMenuItem><DropdownMenuItem onClick={onPipeline}><Activity className="size-4" />查看处理流水线</DropdownMenuItem><DropdownMenuItem onClick={onRechunk}><RefreshCw className="size-4" />重新解析</DropdownMenuItem><DropdownMenuItem onClick={onMove}><Folder className="size-4" />移动到目录</DropdownMenuItem><DropdownMenuItem onClick={onVectorize}>重新向量化</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem className="text-destructive" onClick={onDelete}>删除文档</DropdownMenuItem></ActionMenu>
}

function DocumentCard({ document, folderName, onOpen, onPipeline, onMove, onRechunk, onVectorize, onDelete }: { document: KBDocument; folderName?: string; onOpen: () => void; onPipeline: () => void; onMove: () => void; onRechunk: () => void; onVectorize: () => void; onDelete: () => void }) {
  const meta = statusMeta(document.status)
  return <HoverCard openDelay={500} closeDelay={80}><HoverCardTrigger asChild><article className="group flex h-[150px] min-w-0 cursor-pointer flex-col overflow-hidden rounded-lg border bg-card shadow-xs transition hover:border-primary/35 hover:shadow-md" onClick={onOpen}><div className="flex min-h-0 flex-1 flex-col px-4 py-3"><div className="flex items-start gap-2"><h3 className="min-w-0 flex-1 truncate text-sm font-semibold leading-6" title={document.title}>{document.title}</h3><div onClick={(event) => event.stopPropagation()}><DocumentActions onOpen={onOpen} onPipeline={onPipeline} onMove={onMove} onRechunk={onRechunk} onVectorize={onVectorize} onDelete={onDelete} /></div></div><p className="mt-1 line-clamp-3 text-xs leading-[19px] text-muted-foreground">{documentSummary(document)}</p></div><footer className="flex h-9 shrink-0 items-center gap-2 border-t px-4 text-xs text-muted-foreground"><span className="truncate">{folderName || formatTime(document.updatedAt)}</span><span className="ml-auto shrink-0 uppercase">{document.fileType}</span></footer></article></HoverCardTrigger><HoverCardContent side="left" align="start" className="w-96 p-4"><div className="flex items-start gap-3"><div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted"><FileIcon name={document.fileName} /></div><div className="min-w-0"><p className="truncate text-sm font-semibold">{document.title}</p><p className={cn("mt-1 text-xs", meta.className)}>{meta.label}</p></div></div><p className="mt-3 line-clamp-5 text-sm leading-6 text-muted-foreground">{documentSummary(document)}</p><div className="mt-3 space-y-1.5 border-t pt-3 text-xs text-muted-foreground"><div className="flex items-center gap-3"><span>创建：{formatTime(document.createdAt)}</span><span>{formatBytes(document.sizeBytes)}</span></div><div className="flex items-center gap-3"><span>更新：{formatTime(document.updatedAt)}</span><Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal uppercase">{document.fileType}</Badge></div><div className="flex items-center gap-3"><span>{document.chunkCount} 个分片</span>{document.charCount ? <span>{document.charCount} 字符</span> : null}</div></div><p className="mt-3 text-xs text-muted-foreground">点击卡片查看全文与分片</p></HoverCardContent></HoverCard>
}

function DocumentList({ folders, documents, folderCount, onOpenFolder, onOpenDocument, onPipeline, onMove, onRechunk, onVectorize, onDelete }: { folders: KBDocumentFolder[]; documents: KBDocument[]; folderCount: (id: string) => number; onOpenFolder: (id: string) => void; onOpenDocument: (document: KBDocument) => void; onPipeline: (document: KBDocument) => void; onMove: (document: KBDocument) => void; onRechunk: (document: KBDocument) => void; onVectorize: (document: KBDocument) => void; onDelete: (document: KBDocument) => void }) {
  return <div className="min-w-[680px] pb-6"><div className="grid h-9 grid-cols-[minmax(280px,1fr)_110px_100px_120px_40px] items-center border-b px-3 text-xs font-medium text-muted-foreground"><span>名称</span><span>大小</span><span>状态</span><span>更新时间</span><span /></div>{folders.map((folder) => <button key={folder.id} type="button" className="grid min-h-12 w-full grid-cols-[minmax(280px,1fr)_110px_100px_120px_40px] items-center border-b px-3 text-left text-sm hover:bg-muted/50" onClick={() => onOpenFolder(folder.id)}><span className="flex min-w-0 items-center gap-2"><Folder className="size-4 text-primary" /><span className="truncate font-medium">{folder.name}</span></span><span className="text-xs text-muted-foreground">{folderCount(folder.id)} 个文档</span><span /><span /><span /></button>)}{documents.map((document) => { const meta = statusMeta(document.status); return <div key={document.id} className="grid min-h-14 grid-cols-[minmax(280px,1fr)_110px_100px_120px_40px] items-center border-b px-3 text-sm hover:bg-muted/50"><button type="button" className="flex min-w-0 items-center gap-2 text-left" onClick={() => onOpenDocument(document)}><FileIcon name={document.fileName} /><span className="min-w-0"><span className="block truncate font-medium">{document.title}</span><span className="block truncate text-xs text-muted-foreground">{documentSummary(document)}</span></span></button><span className="text-xs text-muted-foreground">{formatBytes(document.sizeBytes)}</span><span className={cn("text-xs", meta.className)}>{meta.label}</span><span className="text-xs text-muted-foreground">{formatTime(document.updatedAt)}</span><DocumentActions onOpen={() => onOpenDocument(document)} onPipeline={() => onPipeline(document)} onMove={() => onMove(document)} onRechunk={() => onRechunk(document)} onVectorize={() => onVectorize(document)} onDelete={() => onDelete(document)} /></div>})}</div>
}

async function uploadFile(file: File) {
  return uploadBlob(file, file.name, file.type || "application/octet-stream")
}

/** 直传对象存储并返回对象键；页面图片与原始文件走同一条通道。 */
async function uploadBlob(body: Blob, filename: string, contentType: string) {
  const presign = await uploadApi.presignPut({ filename })
  const upload = await fetch(presign.data.presignedUrl, { method: "PUT", body, headers: { "Content-Type": contentType } })
  if (!upload.ok) throw new Error(`上传失败：HTTP ${upload.status}`)
  return presign.data.objectKey
}
