import {
  Folder,
  FolderInput,
  FolderOpen,
  GripVertical,
  Loader2
} from "@/components/iconimate"
import {
  useDroppable,
  type UniqueIdentifier
} from "@dnd-kit/core"
import {
  useSortable,
  type SortingStrategy
} from "@dnd-kit/sortable"
import * as React from "react"
import type { DateRange } from "react-day-picker"

import {
  BookOpenIcon
} from "@/components/animated-icons"
import { FileIcon } from "@/components/kibo-ui/tree/file-icon"
import {
  buildImportFileKey,
  resolveMarkdownImportTitle,
  validateMarkdownImportFile,
  validateMarkdownImportText
} from "@/components/knowledge/article-editor-utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { type ListItem } from "@/components/uitripled/native-nested-list-shadcnui"
import {
  type ArticleTreeStatus,
  type KnowledgeBaseTreeNode
} from "@/lib/api"
import { cn } from "@/lib/utils"
import { StatusDot, type StatusDotVariant } from "@astryxdesign/core/StatusDot"

/**
 * 文章节点状态：用 StatusDot 降噪，悬停看含义，避免彩色胶囊墙抢标题注意力。
 */

export function ArticleStatusBadges({ status }: { status: ArticleTreeStatus | undefined }) {
  if (!status) return null

  const dots: Array<{ key: string; variant: StatusDotVariant; label: string }> = []

  if (status.shareStatus === "public") {
    dots.push({ key: "share", variant: "success", label: "已公开" })
  } else if (status.shareStatus === "password") {
    dots.push({ key: "share", variant: "warning", label: "密码分享" })
  } else if (status.shareStatus === "expired") {
    dots.push({ key: "share", variant: "error", label: "分享过期" })
  }
  if (status.hasMindmap) {
    dots.push({ key: "mindmap", variant: "neutral", label: "思维导图" })
  }
  if (status.wikiStatus === "ready") {
    dots.push({ key: "wiki", variant: "accent", label: "Wiki 已同步" })
  } else if (status.wikiStatus === "stale") {
    dots.push({ key: "wiki", variant: "warning", label: "Wiki 待更新" })
  }

  if (dots.length === 0) return null

  return (
    <button
      type="button"
      aria-label="文章状态"
      className="mr-2.5 hidden shrink-0 items-center gap-1.5 sm:flex"
      onClick={(e) => e.stopPropagation()}
    >
      {dots.map((dot) => (
        <StatusDot
          key={dot.key}
          variant={dot.variant}
          label={dot.label}
          tooltip={dot.label}
        />
      ))}
    </button>
  )
}

export type CreateArticleImportStage = "idle" | "reading" | "ready" | "creating" | "error"

export const CREATE_ARTICLE_IMPORT_STAGE_META: Record<
  CreateArticleImportStage,
  { label: string; progress: number }
> = {
  idle: { label: "", progress: 0 },
  reading: { label: "正在读取 Markdown 文件…", progress: 35 },
  ready: { label: "Markdown 文件已读取，等待创建文章", progress: 60 },
  creating: { label: "正在创建文章…", progress: 90 },
  error: { label: "导入失败，请根据提示调整后重试", progress: 100 },
}

export type ArticleBatchItemStatus = "ready" | "creating" | "done" | "failed"

export const ARTICLE_BATCH_STATUS_LABEL: Record<ArticleBatchItemStatus, string> = {
  ready: "等待创建",
  creating: "创建中",
  done: "已创建",
  failed: "失败",
}

export interface ArticleBatchItem {
  id: string
  key: string
  fileName: string
  title: string
  markdown: string
  status: ArticleBatchItemStatus
  error?: string
  articleId?: string
}

let articleBatchItemSeq = 0
export function nextArticleBatchItemId(): string {
  articleBatchItemSeq += 1
  return `article-batch-${Date.now()}-${articleBatchItemSeq}`
}

/** 读取单个 Markdown 文件并解析为批量导入条目；失败时返回错误信息 */
export async function parseArticleBatchFile(
  file: File
): Promise<{ ok: true; item: ArticleBatchItem } | { ok: false; fileName: string; error: string }> {
  const fileValidationError = validateMarkdownImportFile(file)
  if (fileValidationError) {
    return { ok: false, fileName: file.name, error: fileValidationError }
  }
  try {
    const markdown = await file.text()
    const markdownValidationError = validateMarkdownImportText(markdown)
    if (markdownValidationError) {
      return { ok: false, fileName: file.name, error: markdownValidationError }
    }
    return {
      ok: true,
      item: {
        id: nextArticleBatchItemId(),
        key: buildImportFileKey(file),
        fileName: file.name,
        title: resolveMarkdownImportTitle(markdown, file.name),
        markdown,
        status: "ready",
      },
    }
  } catch {
    return { ok: false, fileName: file.name, error: "读取 Markdown 文件失败，请重新选择文件" }
  }
}

export const NODE_DND_PREFIX = "kb-node:"
export const FOLDER_DROP_DND_PREFIX = "kb-folder-drop:"
export const TREE_NODE_INDENT_PX = 20
/** 拖拽悬停多久自动展开折叠的文件夹（spring-loaded folder）。 */
export const SPRING_LOAD_EXPAND_DELAY_MS = 600

/**
 * 树是嵌套 sortable：文件夹的 sortable 矩形包含整棵子树，父子会各自叠加一次位移，
 * 排序预览算出来的 transform 根本不对，还会把子节点推出带 overflow:hidden 的子树容器被裁掉。
 * 落点已经由插入线和整行高亮表达，这里不需要任何位移预览。
 */
export const noSortingTransform: SortingStrategy = () => null

export type FolderTreeNode = {
  id: string
  parentId: string | null
  name: string
  hasChildren: boolean
  children?: FolderTreeNode[]
}

export type SortableTreeNodeBindings = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "isDragging"
>

export function toNodeDndId(nodeId: string) {
  return `${NODE_DND_PREFIX}${nodeId}`
}

export function toFolderDropDndId(folderId: string) {
  return `${FOLDER_DROP_DND_PREFIX}${folderId}`
}

export function parseNodeDndId(value: UniqueIdentifier | null | undefined): string | null {
  if (value == null) {
    return null
  }
  const raw = String(value)
  return raw.startsWith(NODE_DND_PREFIX) ? raw.slice(NODE_DND_PREFIX.length) : null
}

export function parseFolderDropDndId(value: UniqueIdentifier | null | undefined): string | null {
  if (value == null) {
    return null
  }
  const raw = String(value)
  return raw.startsWith(FOLDER_DROP_DND_PREFIX)
    ? raw.slice(FOLDER_DROP_DND_PREFIX.length)
    : null
}

export function formatDateYmd(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
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

export function toFolderTreeNodes(nodes: KnowledgeBaseTreeNode[]): FolderTreeNode[] {
  return nodes
    .filter((node) => node.type === "FOLDER")
    .map((node) => {
      const children = toFolderTreeNodes(node.children || [])
      return {
        id: node.id,
        parentId: node.parentId,
        name: node.name,
        hasChildren: children.length > 0,
        children,
      }
    })
}

export function treeContainsNode(nodes: KnowledgeBaseTreeNode[], nodeId: string): boolean {
  for (const node of nodes) {
    if (node.id === nodeId) return true
    if (Array.isArray(node.children) && treeContainsNode(node.children, nodeId)) {
      return true
    }
  }
  return false
}

export function findTreeNode(nodes: KnowledgeBaseTreeNode[], nodeId: string): KnowledgeBaseTreeNode | null {
  for (const node of nodes) {
    if (node.id === nodeId) {
      return node
    }
    if (Array.isArray(node.children)) {
      const found = findTreeNode(node.children, nodeId)
      if (found) {
        return found
      }
    }
  }
  return null
}

export function getSiblingNodes(
  nodes: KnowledgeBaseTreeNode[],
  parentId: string | null
): KnowledgeBaseTreeNode[] {
  if (parentId == null) {
    return nodes
  }

  const parent = findTreeNode(nodes, parentId)
  return Array.isArray(parent?.children) ? parent.children : []
}

export function isDescendantInLoadedTree(
  nodes: KnowledgeBaseTreeNode[],
  ancestorId: string,
  nodeId: string | null
): boolean {
  if (!nodeId) {
    return false
  }
  const ancestor = findTreeNode(nodes, ancestorId)
  return treeContainsNode(ancestor?.children || [], nodeId)
}

export function collectVisibleNodeDndIds(
  nodes: KnowledgeBaseTreeNode[],
  expandedIds: Set<string>
): string[] {
  const ids: string[] = []

  const walk = (items: KnowledgeBaseTreeNode[]) => {
    for (const node of items) {
      ids.push(toNodeDndId(node.id))
      if (node.type === "FOLDER" && expandedIds.has(node.id) && Array.isArray(node.children)) {
        walk(node.children)
      }
    }
  }

  walk(nodes)
  return ids
}

/** 三个顶部操作图标共用的命令式句柄，用于在按钮悬停/聚焦时驱动动效 */
export type AnimatedIconHandle = {
  startAnimation: () => void
  stopAnimation: () => void
}

export type AnimatedIconComponent = React.ForwardRefExoticComponent<
  { className?: string; size?: number } & React.RefAttributes<AnimatedIconHandle>
>

/** 知识库顶部的图标动作按钮：Tooltip 承载文案，悬停/聚焦时播放图标动效 */
export function KnowledgeBaseHeaderAction({
  disabled,
  icon: Icon,
  label,
  onClick,
}: {
  disabled?: boolean
  icon: AnimatedIconComponent
  label: string
  onClick: () => void
}) {
  const iconRef = React.useRef<AnimatedIconHandle>(null)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          className="rounded-lg text-muted-foreground hover:text-foreground"
          disabled={disabled}
          onClick={onClick}
          onMouseEnter={() => iconRef.current?.startAnimation()}
          onMouseLeave={() => iconRef.current?.stopAnimation()}
          onFocus={() => iconRef.current?.startAnimation()}
          onBlur={() => iconRef.current?.stopAnimation()}
        >
          <Icon ref={iconRef} size={18} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

/** 文章行内的「构建知识」按钮：悬停/聚焦时翻动书页，构建中切换为 Loader */
export type KnowledgeBaseView = "documents" | "knowledge" | "graph"

export function toKnowledgeBaseView(value: string): KnowledgeBaseView {
  return value === "knowledge" || value === "graph" ? value : "documents"
}

/**
 * 标签栏里的纯图标标签：文案交给 Tooltip 与按钮的 aria-label。
 * 图标统一塞进 18×18 的方盒子——两个图标各自的实现（内联 svg / 带 div 包裹的动画图标）
 * 撑出来的宽度并不一样，不定死盒子的话两个标签下划线就会一长一短。
 */
export function KnowledgeBaseViewLabel({
  icon,
  label,
}: {
  icon: React.ReactNode
  label: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex size-[18px] shrink-0 items-center justify-center [&_svg]:size-[18px]">
          {icon}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

export function KnowledgeBaseBuildButton({
  building,
  progress,
  progressMessage,
  onBuild,
}: {
  building: boolean
  progress?: number
  progressMessage?: string
  onBuild: () => void
}) {
  const iconRef = React.useRef<AnimatedIconHandle>(null)
  const percent = Math.min(100, Math.max(0, Math.round(progress ?? 0)))
  const label = building
    ? `${progressMessage || "知识构建中"}：${percent}%`
    : "构建知识"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          className={cn(
            "hidden h-7 rounded-lg text-muted-foreground sm:inline-flex hover:text-foreground",
            building ? "w-auto min-w-14 gap-1 px-2" : "w-7",
          )}
          disabled={building}
          onClick={(event) => {
            event.stopPropagation()
            onBuild()
          }}
          onMouseEnter={() => iconRef.current?.startAnimation()}
          onMouseLeave={() => iconRef.current?.stopAnimation()}
          onFocus={() => iconRef.current?.startAnimation()}
          onBlur={() => iconRef.current?.stopAnimation()}
        >
          {building ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              <span className="text-[11px] font-medium tabular-nums">{percent}%</span>
            </>
          ) : (
            <BookOpenIcon ref={iconRef} size={14} />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

/** 行首拖拽手柄挂在列表的 leading 插槽里，sortable 绑定通过 context 下发。 */
export const TreeNodeDragBindingsContext = React.createContext<SortableTreeNodeBindings | null>(null)

export function KnowledgeBaseDragHandle({
  disabled,
  nodeName,
}: {
  disabled?: boolean
  nodeName: string
}) {
  const bindings = React.useContext(TreeNodeDragBindingsContext)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          {...(bindings?.attributes ?? {})}
          {...(bindings?.listeners ?? {})}
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          aria-label={`拖动 ${nodeName} 调整位置`}
          className="mr-1 h-6 w-6 shrink-0 cursor-grab text-muted-foreground hover:bg-transparent dark:hover:bg-transparent active:cursor-grabbing"
          onClick={(event) => event.stopPropagation()}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>拖动调整位置</TooltipContent>
    </Tooltip>
  )
}

export function KnowledgeBaseFolderDropTarget({
  disabled,
  folderId,
}: {
  disabled?: boolean
  folderId: string
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: toFolderDropDndId(folderId),
    disabled,
    data: {
      folderId,
      type: "folder-drop",
    },
  })

  if (disabled) {
    return null
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={setNodeRef}
          type="button"
          variant="ghost"
          size="icon"
          aria-label="放入文件夹"
          className={cn(
            "h-6 w-6 shrink-0 text-muted-foreground transition-colors",
            isOver && "bg-primary/10 text-primary ring-1 ring-primary/30"
          )}
          onClick={(event) => event.stopPropagation()}
        >
          <FolderInput className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>放入文件夹</TooltipContent>
    </Tooltip>
  )
}

export function SortableKnowledgeBaseTreeNode({
  children,
  disabled,
  node,
}: {
  children: React.ReactNode
  disabled?: boolean
  node: KnowledgeBaseTreeNode
}) {
  const sortable = useSortable({
    id: toNodeDndId(node.id),
    animateLayoutChanges: () => false,
    disabled,
    data: {
      nodeId: node.id,
      parentId: node.parentId,
      type: "tree-node",
    },
  })

  const bindings = React.useMemo<SortableTreeNodeBindings>(
    () => ({
      attributes: sortable.attributes,
      listeners: sortable.listeners,
      isDragging: sortable.isDragging,
    }),
    [sortable.attributes, sortable.listeners, sortable.isDragging]
  )

  return (
    <div
      ref={sortable.setNodeRef}
      className={cn(
        "rounded-md",
        sortable.isDragging && "opacity-45"
      )}
    >
      <TreeNodeDragBindingsContext.Provider value={bindings}>
        {children}
      </TreeNodeDragBindingsContext.Provider>
    </div>
  )
}

export function KnowledgeBaseDragOverlay({ node }: { node: KnowledgeBaseTreeNode | null }) {
  if (!node) {
    return null
  }

  const isFolder = node.type === "FOLDER"
  return (
    <div className="flex max-w-[320px] items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm shadow-lg">
      {isFolder ? (
        <FolderOpen className="h-4 w-4 shrink-0 text-yellow-500" />
      ) : (
        <FileIcon name={node.name} />
      )}
      <span className="truncate">{node.name}</span>
    </div>
  )
}

export function KnowledgeBaseFolderTreeIcon({ expanded }: { expanded: boolean }) {
  return expanded ? (
    <FolderOpen className="h-4 w-4 text-yellow-500" />
  ) : (
    <Folder className="h-4 w-4 text-blue-500" />
  )
}

/** 收集「从根到选中文件夹」这条路径上的所有 id，用来自动展开露出当前选择。 */
export function collectSelectedFolderPath(
  nodes: FolderTreeNode[],
  selectedFolderId: string | null
): Set<string> {
  const path = new Set<string>()
  if (!selectedFolderId) return path
  const walk = (node: FolderTreeNode, ancestors: string[]): boolean => {
    if (node.id === selectedFolderId) {
      for (const id of ancestors) path.add(id)
      path.add(node.id)
      return true
    }
    return (node.children || []).some((child) => walk(child, [...ancestors, node.id]))
  }
  for (const node of nodes) walk(node, [])
  return path
}

export function toCreateArticleFolderItems(
  nodes: FolderTreeNode[],
  expandedIds: Set<string>,
  selectedFolderId: string | null,
  disabled: boolean | undefined,
  onSelectFolder: (folder: { id: string; name: string } | null) => void
): ListItem[] {
  return nodes.map((node) => {
    const hasChildren = Boolean(node.hasChildren || node.children?.length)
    const expanded = expandedIds.has(node.id)
    return {
      id: node.id,
      label: node.name,
      hasChildren,
      leading: (
        <Checkbox
          checked={selectedFolderId === node.id}
          disabled={disabled}
          aria-label={`选择 ${node.name} 作为创建位置`}
          onCheckedChange={() => onSelectFolder({ id: node.id, name: node.name })}
          onClick={(event) => event.stopPropagation()}
        />
      ),
      icon: expanded ? (
        <FolderOpen className="size-4 shrink-0 text-yellow-500" />
      ) : (
        <Folder className="size-4 shrink-0 text-blue-500" />
      ),
      children: node.children?.length
        ? toCreateArticleFolderItems(node.children, expandedIds, selectedFolderId, disabled, onSelectFolder)
        : undefined,
    }
  })
}

export function normalizeDateRange(value: DateRange | undefined): DateRange | undefined {
  if (!value?.from || !value?.to) {
    return value
  }
  if (value.from.getTime() <= value.to.getTime()) {
    return value
  }
  return { from: value.to, to: value.from }
}

export function updateNodeChildren(
  nodes: KnowledgeBaseTreeNode[],
  nodeId: string,
  children: KnowledgeBaseTreeNode[]
): KnowledgeBaseTreeNode[] {
  return nodes.map((node) => {
    if (node.id === nodeId) {
      return {
        ...node,
        children,
        hasChildren: children.length > 0,
      }
    }

    if (Array.isArray(node.children) && node.children.length > 0) {
      return {
        ...node,
        children: updateNodeChildren(node.children, nodeId, children),
      }
    }

    return node
  })
}

export type DeleteTarget =
  | {
    type: "folder"
    nodeId: string
    parentId: string | null
    name: string
  }
  | {
    type: "article"
    nodeId: string
    articleId: string
    parentId: string | null
    name: string
  }
