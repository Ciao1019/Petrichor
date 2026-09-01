"use client"

import { Folder, FolderOpen, MoreHorizontal } from "@/components/iconimate"
import { toast } from "sonner"

import {
  TreeExpander,
  TreeIcon,
  TreeLabel,
  TreeNode,
  TreeNodeContent,
  TreeNodeTrigger,
} from "@/components/kibo-ui/tree"
import { FileIcon } from "@/components/kibo-ui/tree/file-icon"
import { ActionMenu } from "@/components/petrichor-ui/action-menu"
import { notify } from "@/components/petrichor-ui/notify"
import { Button } from "@/components/ui/button"
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { type DocViewerHighlight } from "@/features/pages/doc-library/DocViewerPanel"
import {
  type DocDeleteResponse,
  type DocDocument,
  type DocFolderItem
} from "@/lib/api"


export const TREE_NODE_INDENT_PX = 20

export type DocTreeNode =
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

export type DeleteTarget =
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

export function resolveApiErrorMessage(error: unknown, fallback: string): string {
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

export function toastDeleteResult(result: DocDeleteResponse, successMessage: string) {
  const failedCount = result.storageCleanup.failedObjectKeys.length
  if (failedCount > 0) {
    toast.warning(`${successMessage}，但远程文件清理失败`)
    return
  }
  toast.success(successMessage)
}

export function compareDocTreeNodes(left: DocTreeNode, right: DocTreeNode) {
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

export function sortDocTreeNodes(nodes: DocTreeNode[]) {
  nodes.sort(compareDocTreeNodes)
  for (const node of nodes) {
    if (node.type === "FOLDER") {
      sortDocTreeNodes(node.children)
    }
  }
}

export function buildDocTree(folders: DocFolderItem[], documents: DocDocument[]) {
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

export function collectFolderIds(node: DocTreeNode, target: Set<string>) {
  if (node.type !== "FOLDER") return
  target.add(node.id)
  node.children.forEach((child) => collectFolderIds(child, target))
}

export function filterDocTree(nodes: DocTreeNode[], keyword: string) {
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

export function formatFileMeta(document: DocDocument) {
  const parts = [document.fileType.toUpperCase()]
  if (document.pageCount != null && document.pageCount > 0) {
    parts.push(`${document.pageCount} 页`)
  }
  if (document.sizeBytes != null && document.sizeBytes > 0) {
    parts.push(formatBytes(document.sizeBytes))
  }
  return parts.join(" · ")
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function getDocumentIdFromSearch(search: string) {
  const documentId = new URLSearchParams(search).get("documentId")?.trim()
  return documentId && /^\d+$/.test(documentId) ? documentId : null
}

export function getHighlightFromSearch(search: string): DocViewerHighlight | null {
  const params = new URLSearchParams(search)
  const pageRaw = params.get("hlPage")?.trim()
  const text = params.get("hlText")?.trim()
  if (!pageRaw || !text || !/^\d+$/.test(pageRaw)) return null
  return { page: Number(pageRaw), text }
}

export function FolderTreeIcon({ expanded }: { expanded: boolean }) {
  return expanded ? <FolderOpen className="h-4 w-4" /> : <Folder className="h-4 w-4" />
}

interface DocTreeNodeViewProps {
  node: DocTreeNode
  expandedIds: Set<string>
  level?: number
  isLast?: boolean
  parentPath?: boolean[]
  onOpenViewer: (documentId: string) => void
  onCreateFolder: (parent: { id: string; name: string }) => void
  onUpload: (parent: { id: string; name: string }) => void
  onRenameFolder: (folder: DocFolderItem) => void
  onDelete: (target: DeleteTarget) => void
}

/** 文档目录树递归节点，集中处理节点菜单与缩进。 */
export function DocTreeNodeView({
  node,
  expandedIds,
  level = 0,
  isLast = false,
  parentPath = [],
  onOpenViewer,
  onCreateFolder,
  onUpload,
  onRenameFolder,
  onDelete,
}: DocTreeNodeViewProps) {
  const isFolder = node.type === "FOLDER"
  const hasChildren = isFolder && node.children.length > 0
  const isExpanded = expandedIds.has(node.id)

  return (
    <TreeNode key={node.id} nodeId={node.id} level={level} isLast={isLast} parentPath={parentPath}>
      <TreeNodeTrigger className="w-full" style={{ paddingLeft: 8 }} onClick={() => {
        if (!isFolder) onOpenViewer(node.document.id)
      }}>
        <div aria-hidden="true" className="shrink-0" style={{ width: level * TREE_NODE_INDENT_PX }} />
        {isFolder ? <TreeExpander hasChildren={hasChildren} /> : <div className="mr-1 h-4 w-4" />}
        {isFolder ? (
          <TreeIcon hasChildren={hasChildren} icon={<FolderTreeIcon expanded={isExpanded} />} />
        ) : (
          <div className="mr-2 flex h-4 w-4 items-center justify-center text-muted-foreground">
            <FileIcon name={node.document.fileName} />
          </div>
        )}
        <TreeLabel>{node.name}</TreeLabel>
        {!isFolder ? (
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{formatFileMeta(node.document)}</span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <ActionMenu
            trigger={
              <Button variant="ghost" size="icon" className="size-9 md:size-6" onClick={(event) => event.stopPropagation()}>
                <MoreHorizontal className="size-4 md:size-3" />
              </Button>
            }
            align="end"
          >
            {isFolder ? (
              <>
                <DropdownMenuItem onClick={() => onCreateFolder({ id: node.id, name: node.name })}>新建文件夹</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onUpload({ id: node.id, name: node.name })}>上传文件</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onRenameFolder(node.folder)}>重命名</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => onDelete({ type: "folder", id: node.id, parentId: node.parentId, name: node.name })}>
                  删除
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem onClick={() => onOpenViewer(node.document.id)}>打开</DropdownMenuItem>
                <DropdownMenuItem onClick={() => {
                  void navigator.clipboard.writeText(node.document.id)
                    .then(() => notify("已复制文件 ID"))
                    .catch(() => toast.error("复制失败"))
                }}>
                  复制文件 ID
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => onDelete({ type: "document", id: node.document.id, parentId: node.document.folderId, name: node.name })}>
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
            <DocTreeNodeView
              key={child.id}
              node={child}
              expandedIds={expandedIds}
              level={level + 1}
              isLast={index === children.length - 1}
              parentPath={[...parentPath, isLast]}
              onOpenViewer={onOpenViewer}
              onCreateFolder={onCreateFolder}
              onUpload={onUpload}
              onRenameFolder={onRenameFolder}
              onDelete={onDelete}
            />
          ))}
        </TreeNodeContent>
      ) : null}
    </TreeNode>
  )
}
