"use client"

import * as React from "react"
import { Folder, FolderOpen, Loader2, MoreHorizontal, Upload } from "lucide-react"
import { useLocation, useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"

import { AppPagination } from "@/components/app-pagination"
import { FileIcon } from "@/components/kibo-ui/tree/file-icon"
import {
  TreeExpander,
  TreeIcon,
  TreeLabel,
  TreeNode,
  TreeNodeContent,
  TreeNodeTrigger,
  TreeProvider,
  TreeView,
} from "@/components/kibo-ui/tree"
import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { ActionMenu } from "@/components/petrichor-ui/action-menu"
import { notify } from "@/components/petrichor-ui/notify"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FileUpload } from "@/components/extend/ui/file-upload"
import { DocViewerPanel, type DocViewerHighlight } from "@/features/pages/doc-library/DocViewerPanel"
import { detectFileType, parseDocument } from "@/features/pages/doc-library/lib/parse"
import {
  docLibraryApi,
  uploadApi,
  type DocDeleteResponse,
  type DocDocument,
  type DocDocumentDetail,
  type DocFolderItem,
  type DocLibrary,
} from "@/lib/api"
import { dashboardRoutes } from "@/lib/dashboard-routes"

const ACCEPT = ".pdf,.docx,.xlsx,.xls,.csv,.tsv"
const TREE_NODE_INDENT_PX = 20

type DocTreeNode =
  | {
    type: "FOLDER"
    id: string
    parentId: string | null
    name: string
    folder: DocFolderItem
    children: DocTreeNode[]
  }
  | {
    type: "DOCUMENT"
    id: string
    parentId: string | null
    name: string
    document: DocDocument
    children: []
  }

type DeleteTarget =
  | {
    type: "folder"
    id: string
    parentId: string | null
    name: string
  }
  | {
    type: "document"
    id: string
    parentId: string | null
    name: string
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
    toast.warning(`${successMessage}，但远程文件清理失败`)
    return
  }
  toast.success(successMessage)
}

function compareDocTreeNodes(left: DocTreeNode, right: DocTreeNode) {
  if (left.type !== right.type) {
    return left.type === "FOLDER" ? -1 : 1
  }

  if (left.type === "FOLDER" && right.type === "FOLDER") {
    return (left.folder.sortOrder - right.folder.sortOrder) ||
      left.name.localeCompare(right.name, "zh-CN") ||
      Number(left.id) - Number(right.id)
  }

  if (left.type === "DOCUMENT" && right.type === "DOCUMENT") {
    return Date.parse(right.document.updatedAt) - Date.parse(left.document.updatedAt) ||
      right.name.localeCompare(left.name, "zh-CN")
  }

  return 0
}

function sortDocTreeNodes(nodes: DocTreeNode[]) {
  nodes.sort(compareDocTreeNodes)
  for (const node of nodes) {
    if (node.type === "FOLDER") {
      sortDocTreeNodes(node.children)
    }
  }
}

function buildDocTree(folders: DocFolderItem[], documents: DocDocument[]) {
  const folderNodes = new Map<string, Extract<DocTreeNode, { type: "FOLDER" }>>()
  const roots: DocTreeNode[] = []

  for (const folder of folders) {
    folderNodes.set(folder.id, {
      type: "FOLDER",
      id: folder.id,
      parentId: folder.parentId,
      name: folder.name,
      folder,
      children: [],
    })
  }

  for (const folder of folders) {
    const node = folderNodes.get(folder.id)
    if (!node) continue
    const parent = folder.parentId ? folderNodes.get(folder.parentId) : null
    if (parent && parent.id !== node.id) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  for (const document of documents) {
    const node: DocTreeNode = {
      type: "DOCUMENT",
      id: `document-${document.id}`,
      parentId: document.folderId,
      name: document.title || document.fileName,
      document,
      children: [],
    }
    const parent = document.folderId ? folderNodes.get(document.folderId) : null
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  sortDocTreeNodes(roots)
  return roots
}

function collectFolderIds(node: DocTreeNode, target: Set<string>) {
  if (node.type !== "FOLDER") return
  target.add(node.id)
  node.children.forEach((child) => collectFolderIds(child, target))
}

function filterDocTree(nodes: DocTreeNode[], keyword: string) {
  const needle = keyword.trim().toLowerCase()
  const expandedIds = new Set<string>()
  if (!needle) {
    return { roots: nodes, expandedIds }
  }

  const walk = (node: DocTreeNode): DocTreeNode | null => {
    const selfMatch = node.name.toLowerCase().includes(needle)
    if (node.type === "DOCUMENT") {
      const fileNameMatch = node.document.fileName.toLowerCase().includes(needle)
      return selfMatch || fileNameMatch ? node : null
    }

    const matchedChildren = node.children
      .map((child) => walk(child))
      .filter((child): child is DocTreeNode => Boolean(child))

    if (selfMatch) {
      collectFolderIds(node, expandedIds)
      return node
    }

    if (matchedChildren.length > 0) {
      expandedIds.add(node.id)
      return {
        ...node,
        children: matchedChildren,
      }
    }

    return null
  }

  return {
    roots: nodes
      .map((node) => walk(node))
      .filter((node): node is DocTreeNode => Boolean(node)),
    expandedIds,
  }
}

function formatFileMeta(document: DocDocument) {
  const parts = [document.fileType.toUpperCase()]
  if (document.pageCount != null && document.pageCount > 0) {
    parts.push(`${document.pageCount} 页`)
  }
  if (document.sizeBytes != null && document.sizeBytes > 0) {
    parts.push(formatBytes(document.sizeBytes))
  }
  return parts.join(" · ")
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function getDocumentIdFromSearch(search: string) {
  const documentId = new URLSearchParams(search).get("documentId")?.trim()
  return documentId && /^\d+$/.test(documentId) ? documentId : null
}

function getHighlightFromSearch(search: string): DocViewerHighlight | null {
  const params = new URLSearchParams(search)
  const pageRaw = params.get("hlPage")?.trim()
  const text = params.get("hlText")?.trim()
  if (!pageRaw || !text || !/^\d+$/.test(pageRaw)) return null
  return { page: Number(pageRaw), text }
}

function FolderTreeIcon({ expanded }: { expanded: boolean }) {
  return expanded ? (
    <FolderOpen className="h-4 w-4" />
  ) : (
    <Folder className="h-4 w-4" />
  )
}

export function DocLibraryBrowsePage() {
  const { libraryId } = useParams<{ libraryId: string }>()
  const location = useLocation()
  const navigate = useNavigate()

  const [library, setLibrary] = React.useState<DocLibrary | null>(null)
  const [folders, setFolders] = React.useState<DocFolderItem[]>([])
  const [documents, setDocuments] = React.useState<DocDocument[]>([])
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [pageIndex, setPageIndex] = React.useState(0)
  const [pageSize] = React.useState(10)
  const [keyword, setKeyword] = React.useState("")
  const [debouncedKeyword, setDebouncedKeyword] = React.useState("")
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set())
  const [createFolderOpen, setCreateFolderOpen] = React.useState(false)
  const [createFolderParentId, setCreateFolderParentId] = React.useState<string | null>(null)
  const [createFolderParentName, setCreateFolderParentName] = React.useState<string | null>(null)
  const [createFolderName, setCreateFolderName] = React.useState("")
  const [renameFolderOpen, setRenameFolderOpen] = React.useState(false)
  const [renameFolder, setRenameFolder] = React.useState<DocFolderItem | null>(null)
  const [renameFolderName, setRenameFolderName] = React.useState("")
  const [uploadOpen, setUploadOpen] = React.useState(false)
  const [uploadParentId, setUploadParentId] = React.useState<string | null>(null)
  const [uploadParentName, setUploadParentName] = React.useState<string | null>(null)
  const [uploading, setUploading] = React.useState(false)
  const [uploadProgress, setUploadProgress] = React.useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deleteTarget, setDeleteTarget] = React.useState<DeleteTarget | null>(null)
  const [viewerDoc, setViewerDoc] = React.useState<DocDocumentDetail | null>(null)
  const [viewerOpen, setViewerOpen] = React.useState(false)
  const [viewerLoading, setViewerLoading] = React.useState(false)
  const [viewerHighlight, setViewerHighlight] = React.useState<DocViewerHighlight | null>(null)
  const openedFromUrlRef = React.useRef<string | null>(null)

  const loadData = React.useCallback(async () => {
    if (!libraryId) return
    setLoading(true)
    try {
      const [libraryRes, folderRes, documentRes] = await Promise.all([
        docLibraryApi.listLibraries(),
        docLibraryApi.listFolders(libraryId),
        docLibraryApi.listDocuments(libraryId),
      ])
      setLibrary(libraryRes.data.libraries.find((item) => item.id === libraryId) ?? null)
      setFolders(folderRes.data.folders)
      setDocuments(documentRes.data.documents)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "加载文档库失败"))
    } finally {
      setLoading(false)
    }
  }, [libraryId])

  React.useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setPageIndex(0)
      setKeyword("")
      setDebouncedKeyword("")
      setExpandedIds(new Set())
      setCreateFolderOpen(false)
      setCreateFolderParentId(null)
      setCreateFolderParentName(null)
      setCreateFolderName("")
      setRenameFolderOpen(false)
      setRenameFolder(null)
      setRenameFolderName("")
      setUploadOpen(false)
      setUploadParentId(null)
      setUploadParentName(null)
      setDeleteOpen(false)
      setDeleteTarget(null)
      // 注意：viewer 的开关由下方「URL → viewer」effect 统一驱动，
      // 这里不要重置，否则会和打开操作产生 microtask 竞态把弹窗关掉。
    })
    return () => {
      cancelled = true
    }
  }, [libraryId])

  React.useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void loadData()
    })
    return () => {
      cancelled = true
    }
  }, [loadData])

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedKeyword(keyword.trim())
    }, 300)
    return () => window.clearTimeout(timer)
  }, [keyword])

  const roots = React.useMemo(() => buildDocTree(folders, documents), [documents, folders])
  const filtered = React.useMemo(
    () => filterDocTree(roots, debouncedKeyword),
    [debouncedKeyword, roots],
  )
  const visibleRoots = filtered.roots
  const totalRootNodes = visibleRoots.length
  const totalPages = Math.max(1, Math.ceil(totalRootNodes / pageSize))
  const currentPageIndex = Math.min(pageIndex, totalPages - 1)
  const pagedRoots = React.useMemo(
    () => visibleRoots.slice(currentPageIndex * pageSize, currentPageIndex * pageSize + pageSize),
    [currentPageIndex, pageSize, visibleRoots],
  )
  const treeExpandedIds = React.useMemo(() => {
    if (!debouncedKeyword) return expandedIds
    const next = new Set(expandedIds)
    filtered.expandedIds.forEach((id) => next.add(id))
    return next
  }, [debouncedKeyword, expandedIds, filtered.expandedIds])

  const refreshAndKeepFolderOpen = React.useCallback(async (folderId: string | null) => {
    await loadData()
    if (!folderId) return
    setExpandedIds((prev) => {
      const next = new Set(prev)
      next.add(folderId)
      return next
    })
  }, [loadData])

  const openCreateFolder = React.useCallback((parent: { id: string; name: string } | null) => {
    setCreateFolderParentId(parent?.id ?? null)
    setCreateFolderParentName(parent?.name ?? null)
    setCreateFolderName("")
    setCreateFolderOpen(true)
  }, [])

  const submitCreateFolder = React.useCallback(async () => {
    if (!libraryId) return
    const name = createFolderName.trim()
    if (!name) {
      toast.error("文件夹名称不能为空")
      return
    }
    if (saving) return

    setSaving(true)
    try {
      await docLibraryApi.saveFolder({
        libraryId,
        parentId: createFolderParentId,
        name,
      })
      toast.success("文件夹已创建")
      setCreateFolderOpen(false)
      await refreshAndKeepFolderOpen(createFolderParentId)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "创建文件夹失败"))
    } finally {
      setSaving(false)
    }
  }, [createFolderName, createFolderParentId, libraryId, refreshAndKeepFolderOpen, saving])

  const openRenameFolder = React.useCallback((folder: DocFolderItem) => {
    setRenameFolder(folder)
    setRenameFolderName(folder.name)
    setRenameFolderOpen(true)
  }, [])

  const submitRenameFolder = React.useCallback(async () => {
    if (!libraryId || !renameFolder) return
    const name = renameFolderName.trim()
    if (!name) {
      toast.error("文件夹名称不能为空")
      return
    }
    if (saving) return

    setSaving(true)
    try {
      await docLibraryApi.saveFolder({
        id: renameFolder.id,
        libraryId,
        parentId: renameFolder.parentId,
        name,
      })
      toast.success("文件夹已重命名")
      setRenameFolderOpen(false)
      await refreshAndKeepFolderOpen(renameFolder.parentId)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "重命名失败"))
    } finally {
      setSaving(false)
    }
  }, [libraryId, refreshAndKeepFolderOpen, renameFolder, renameFolderName, saving])

  const openUpload = React.useCallback((parent: { id: string; name: string } | null) => {
    setUploadParentId(parent?.id ?? null)
    setUploadParentName(parent?.name ?? null)
    setUploadProgress(null)
    setUploadOpen(true)
  }, [])

  const uploadOne = React.useCallback(async (file: File) => {
    if (!libraryId) return
    const fileType = detectFileType(file)
    if (!fileType) {
      toast.error(`不支持的文件类型：${file.name}（仅支持 PDF / docx / xlsx / csv）`)
      return
    }

    setUploadProgress(`正在上传 ${file.name}...`)
    const presign = await uploadApi.presignPut({ filename: file.name })
    const putResponse = await fetch(presign.data.presignedUrl, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type || "application/octet-stream" },
    })
    if (!putResponse.ok) {
      throw new Error(`上传失败：HTTP ${putResponse.status}`)
    }

    setUploadProgress(`正在解析 ${file.name}...`)
    const parsed = await parseDocument(file, fileType)
    await docLibraryApi.registerDocument({
      libraryId,
      folderId: uploadParentId,
      fileName: file.name,
      fileType,
      contentType: file.type || null,
      objectKey: presign.data.objectKey,
      sizeBytes: file.size,
      pageCount: parsed.pageCount,
      blocks: parsed.blocks,
      chunks: parsed.chunks,
    })
  }, [libraryId, uploadParentId])

  const handleFilesAccepted = React.useCallback(async (files: File[]) => {
    if (files.length === 0) return
    setUploading(true)
    let success = 0
    for (const file of files) {
      try {
        await uploadOne(file)
        success += 1
      } catch (error) {
        toast.error(resolveApiErrorMessage(error, `「${file.name}」处理失败`))
      }
    }
    setUploading(false)
    setUploadProgress(null)
    if (success > 0) {
      toast.success(`已上传并解析 ${success} 个文件`)
      setUploadOpen(false)
      await refreshAndKeepFolderOpen(uploadParentId)
    }
  }, [refreshAndKeepFolderOpen, uploadOne, uploadParentId])

  const openViewer = React.useCallback(async (documentId: string, highlight: DocViewerHighlight | null = null) => {
    setViewerOpen(true)
    setViewerHighlight(highlight)
    setViewerLoading(true)
    setViewerDoc(null)
    try {
      const res = await docLibraryApi.documentDetail(documentId)
      setViewerDoc(res.data.document)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "加载文件详情失败"))
      setViewerOpen(false)
    } finally {
      setViewerLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (!libraryId) return
    const documentId = getDocumentIdFromSearch(location.search)
    if (!documentId) {
      // URL 不含 documentId（含切换文档库后）：关闭由 URL 打开的预览
      if (openedFromUrlRef.current != null) {
        openedFromUrlRef.current = null
        setViewerOpen(false)
        setViewerHighlight(null)
      }
      return
    }
    const highlight = getHighlightFromSearch(location.search)
    const openKey = `${libraryId}:${documentId}:${highlight ? `${highlight.page}|${highlight.text.slice(0, 48)}` : ""}`
    if (openedFromUrlRef.current === openKey) return
    openedFromUrlRef.current = openKey
    void openViewer(documentId, highlight)
  }, [libraryId, location.search, openViewer])

  const handleViewerOpenChange = React.useCallback((open: boolean) => {
    setViewerOpen(open)
    if (open) return

    setViewerHighlight(null)
    const params = new URLSearchParams(location.search)
    const hadDocumentId = params.has("documentId")
    const hadHighlight = params.has("hlPage") || params.has("hlText")
    if (!hadDocumentId && !hadHighlight) return

    params.delete("documentId")
    params.delete("hlPage")
    params.delete("hlText")
    const nextSearch = params.toString()
    openedFromUrlRef.current = null
    navigate(
      {
        pathname: location.pathname,
        search: nextSearch ? `?${nextSearch}` : "",
        hash: location.hash,
      },
      { replace: true },
    )
  }, [location.hash, location.pathname, location.search, navigate])

  const confirmDelete = React.useCallback(async () => {
    if (!deleteTarget) return
    if (saving) return

    setSaving(true)
    try {
      if (deleteTarget.type === "folder") {
        await docLibraryApi.deleteFolder(deleteTarget.id)
        toast.success("文件夹已删除")
        setExpandedIds((prev) => {
          const next = new Set(prev)
          next.delete(deleteTarget.id)
          if (deleteTarget.parentId) next.add(deleteTarget.parentId)
          return next
        })
      } else {
        const response = await docLibraryApi.deleteDocument(deleteTarget.id)
        toastDeleteResult(response.data, "文件已删除")
        if (viewerDoc?.id === deleteTarget.id) {
          setViewerOpen(false)
          setViewerDoc(null)
        }
      }
      setDeleteOpen(false)
      setDeleteTarget(null)
      await refreshAndKeepFolderOpen(deleteTarget.parentId)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "删除失败"))
    } finally {
      setSaving(false)
    }
  }, [deleteTarget, refreshAndKeepFolderOpen, saving, viewerDoc])

  const handlePageChange = React.useCallback(
    (nextPageIndex: number) => {
      if (nextPageIndex < 0 || nextPageIndex >= totalPages) return
      setPageIndex(nextPageIndex)
    },
    [totalPages],
  )

  function renderNode(
    node: DocTreeNode,
    level = 0,
    isLast = false,
    parentPath: boolean[] = [],
  ): React.ReactNode {
    const isFolder = node.type === "FOLDER"
    const hasChildren = isFolder && node.children.length > 0
    const isExpanded = treeExpandedIds.has(node.id)

    return (
      <TreeNode
        key={node.id}
        nodeId={node.id}
        level={level}
        isLast={isLast}
        parentPath={parentPath}
      >
        <TreeNodeTrigger
          className="w-full"
          style={{ paddingLeft: 8 }}
          onClick={() => {
            if (isFolder) return
            void openViewer(node.document.id)
          }}
        >
          <div
            aria-hidden="true"
            className="shrink-0"
            style={{ width: level * TREE_NODE_INDENT_PX }}
          />

          {isFolder ? (
            <TreeExpander hasChildren={hasChildren} />
          ) : (
            <div className="mr-1 h-4 w-4" />
          )}

          {isFolder ? (
            <TreeIcon
              hasChildren={hasChildren}
              icon={<FolderTreeIcon expanded={isExpanded} />}
            />
          ) : (
            <div className="mr-2 flex h-4 w-4 items-center justify-center text-muted-foreground">
              <FileIcon name={node.document.fileName} />
            </div>
          )}

          <TreeLabel>{node.name}</TreeLabel>

          {!isFolder ? (
            <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
              {formatFileMeta(node.document)}
            </span>
          ) : null}

          <div className="ml-auto flex shrink-0 items-center gap-1">
            <ActionMenu
              trigger={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9 md:size-6"
                  onClick={(event) => event.stopPropagation()}
                >
                  <MoreHorizontal className="size-4 md:size-3" />
                </Button>
              }
              align="end"
            >
              {isFolder ? (
                <>
                  <DropdownMenuItem onClick={() => openCreateFolder({ id: node.id, name: node.name })}>
                    新建文件夹
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => openUpload({ id: node.id, name: node.name })}>
                    上传文件
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => openRenameFolder(node.folder)}>
                    重命名
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => {
                      setDeleteTarget({
                        type: "folder",
                        id: node.id,
                        parentId: node.parentId,
                        name: node.name,
                      })
                      setDeleteOpen(true)
                    }}
                  >
                    删除
                  </DropdownMenuItem>
                </>
              ) : (
                <>
                  <DropdownMenuItem onClick={() => void openViewer(node.document.id)}>
                    打开
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      void navigator.clipboard.writeText(node.document.id)
                        .then(() => notify("已复制文件 ID"))
                        .catch(() => toast.error("复制失败"))
                    }}
                  >
                    复制文件 ID
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => {
                      setDeleteTarget({
                        type: "document",
                        id: node.document.id,
                        parentId: node.document.folderId,
                        name: node.name,
                      })
                      setDeleteOpen(true)
                    }}
                  >
                    删除
                  </DropdownMenuItem>
                </>
              )}
            </ActionMenu>
          </div>
        </TreeNodeTrigger>

        {isFolder && hasChildren ? (
          <TreeNodeContent hasChildren={hasChildren}>
            {node.children.map((child, index, children) => (
              renderNode(child, level + 1, index === children.length - 1, [...parentPath, isLast])
            ))}
          </TreeNodeContent>
        ) : null}
      </TreeNode>
    )
  }

  return (
    <div className="w-full p-4 lg:p-6">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold">
            {library?.name || "文档库"}
          </h1>
          {library?.description ? (
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              {library.description}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">
            {folders.length} 个文件夹 · {documents.length} 个文件
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => navigate(dashboardRoutes.docLibrary)}>
            返回
          </Button>
          <Button
            variant="outline"
            disabled={!libraryId || loading || saving}
            onClick={() => openCreateFolder(null)}
          >
            新建文件夹
          </Button>
          <Button
            disabled={!libraryId || loading || uploading}
            onClick={() => openUpload(null)}
          >
            <Upload className="size-4" />
            上传文件
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <Input
          value={keyword}
          placeholder="搜索文件夹/文件名称"
          className="sm:w-[360px] lg:w-[420px]"
          onChange={(event) => {
            setKeyword(event.target.value)
            setPageIndex(0)
          }}
        />

        {loading ? (
          <div className="py-8 text-sm text-muted-foreground">加载中...</div>
        ) : pagedRoots.length === 0 ? (
          <div className="py-8 text-sm text-muted-foreground">
            {debouncedKeyword ? "暂无匹配结果" : "暂无文件/文件夹"}
          </div>
        ) : (
          <TreeProvider
            className="flex flex-col gap-1"
            showLines={false}
            indent={TREE_NODE_INDENT_PX}
            expandedIds={treeExpandedIds}
            onExpandedChange={setExpandedIds}
          >
            <TreeView>
              {pagedRoots.map((root, index) => renderNode(root, 0, index === pagedRoots.length - 1))}
            </TreeView>
          </TreeProvider>
        )}
      </div>

      <div className="mt-2 py-3">
        <AppPagination
          page={currentPageIndex}
          totalPages={totalPages}
          total={totalRootNodes}
          pageSize={pageSize}
          onChange={handlePageChange}
        />
      </div>

      <ModalShell
        open={createFolderOpen}
        onOpenChange={(open) => {
          if (!open && saving) return
          setCreateFolderOpen(open)
        }}
        disableClose={saving}
        title="新建文件夹"
        description={
          createFolderParentId
            ? `将在 ${createFolderParentName || "当前文件夹"} 下创建`
            : "将在根目录创建"
        }
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => setCreateFolderOpen(false)}
            >
              取消
            </Button>
            <Button type="button" disabled={saving} onClick={submitCreateFolder}>
              {saving ? "创建中..." : "创建"}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <Label htmlFor="doc-folder-name">名称</Label>
          <Input
            id="doc-folder-name"
            value={createFolderName}
            placeholder="例如：项目资料"
            disabled={saving}
            onChange={(event) => setCreateFolderName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              event.preventDefault()
              void submitCreateFolder()
            }}
          />
        </div>
      </ModalShell>

      <ModalShell
        open={renameFolderOpen}
        onOpenChange={(open) => {
          if (!open && saving) return
          setRenameFolderOpen(open)
        }}
        disableClose={saving}
        title="重命名文件夹"
        description="修改文件夹名称。"
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => setRenameFolderOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={saving || !renameFolder}
              onClick={submitRenameFolder}
            >
              {saving ? "保存中..." : "保存"}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <Label htmlFor="rename-doc-folder-name">名称</Label>
          <Input
            id="rename-doc-folder-name"
            value={renameFolderName}
            placeholder="请输入新名称"
            disabled={saving}
            onChange={(event) => setRenameFolderName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              event.preventDefault()
              void submitRenameFolder()
            }}
          />
        </div>
      </ModalShell>

      <ModalShell
        open={uploadOpen}
        onOpenChange={(open) => {
          if (!open && uploading) return
          setUploadOpen(open)
        }}
        disableClose={uploading}
        title="上传文件"
        description={
          uploadParentId
            ? `将上传到 ${uploadParentName || "当前文件夹"}`
            : "将上传到根目录"
        }
        contentClassName="sm:max-w-xl"
      >
        {uploading ? (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            {uploadProgress ?? "处理中..."}
          </div>
        ) : (
          <FileUpload
            accept={ACCEPT}
            multiple
            showFileList={false}
            title="拖拽文件到此处，或点击选择"
            description="支持 PDF / Word / Excel / CSV"
            onFilesAccepted={handleFilesAccepted}
          />
        )}
      </ModalShell>

      <ModalShell
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open && saving) return
          setDeleteOpen(open)
        }}
        disableClose={saving}
        title="确认删除？"
        description={
          deleteTarget?.type === "folder"
            ? `将删除文件夹“${deleteTarget.name}”。其中的文件会回到根目录，子文件夹会一并删除。`
            : deleteTarget?.type === "document"
              ? `将删除文件“${deleteTarget.name}”、远程对象及其解析文本。`
              : "将删除所选内容。"
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
              disabled={saving || !deleteTarget}
              onClick={confirmDelete}
            >
              {saving ? "删除中..." : "确认删除"}
            </Button>
          </>
        }
      />

      <Dialog open={viewerOpen} onOpenChange={handleViewerOpenChange}>
        <DialogContent
          className="flex h-[88vh] w-[96vw] max-w-[1400px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1400px]"
          showCloseButton
        >
          <DialogHeader className="border-b border-border/60 px-4 py-3">
            <DialogTitle className="truncate text-sm">
              {viewerDoc?.fileName ?? "文件预览"}
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1">
            {viewerLoading ? (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            ) : (
              <DocViewerPanel document={viewerDoc} highlight={viewerHighlight} />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
