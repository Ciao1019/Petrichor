import {
  CalendarIcon,
  CheckCircle2,
  ChevronLeft,
  BookOpen,
  FileText,
  FileUp,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GripVertical,
  Loader2,
  Plus,
  Trash2,
  X,
} from "@/components/iconimate"
import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core"
import {
  SortableContext,
  useSortable,
  type SortingStrategy,
} from "@dnd-kit/sortable"
import { useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"
import type { DateRange } from "react-day-picker"

import { FileIcon } from "@/components/kibo-ui/tree/file-icon"
import { NativeNestedList, type ListItem } from "@/components/uitripled/native-nested-list-shadcnui"
import {
  resolveDropIntentKind,
  resolvePointerY,
  resolveSiblingTargetIndex,
  type DropIntent,
} from "@/features/pages/knowledge/knowledge-tree-drop"
import { DateRangeCalendar } from "@/components/petrichor-ui/date-range-calendar"
import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { AppPagination } from "@/components/app-pagination"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { OrbitingCircles } from "@/components/godui/orbiting-circles"
import { AnimatedTabs } from "@/components/microinteractions/animated-tabs"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  BATCH_IMPORT_MAX_FILES,
  buildImportFileKey,
  MARKDOWN_IMPORT_MAX_FILE_BYTES,
  resolveMarkdownImportTitle,
  validateMarkdownImportFile,
  validateMarkdownImportText,
} from "@/components/knowledge/article-editor-utils"
import {
  ArrowUpTrayIcon,
  BookOpenIcon,
  DocumentPlusIcon,
  FolderPlusIcon,
} from "@/components/animated-icons"
import {
  knowledgeBaseApi,
  knowledgeBaseArticleApi,
  knowledgeBaseNodeApi,
  knowledgeBaseWikiAgentApi,
  type ArticleTreeStatus,
  type KnowledgeBaseResponse,
  type KnowledgeBaseTreeNode,
} from "@/lib/api"
import { StatusDot, type StatusDotVariant } from "@astryxdesign/core/StatusDot"
import { AstryxProvider } from "@/components/astryx/astryx-provider"
import {
  dashboardRoutes,
  knowledgeBaseArticlePath,
} from "@/lib/dashboard-routes"
import { DocumentImportDialog } from "@/components/knowledge/DocumentImportDialog"
import { ButtonDelete } from "@/components/ruixen/button-delete"
import { cn } from "@/lib/utils"
import { gsap } from "@/lib/gsap"
import { rememberKnowledgeBase } from "@/features/pages/knowledge/kb-recent"
import { KnowledgeExplorerPanel } from "@/features/pages/knowledge/KnowledgeExplorerDialog"

/**
 * 文章节点状态：用 StatusDot 降噪，悬停看含义，避免彩色胶囊墙抢标题注意力。
 */
function ArticleStatusBadges({ status }: { status: ArticleTreeStatus | undefined }) {
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
    <div
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
    </div>
  )
}

type CreateArticleImportStage = "idle" | "reading" | "ready" | "creating" | "error"

const CREATE_ARTICLE_IMPORT_STAGE_META: Record<
  CreateArticleImportStage,
  { label: string; progress: number }
> = {
  idle: { label: "", progress: 0 },
  reading: { label: "正在读取 Markdown 文件…", progress: 35 },
  ready: { label: "Markdown 文件已读取，等待创建文章", progress: 60 },
  creating: { label: "正在创建文章…", progress: 90 },
  error: { label: "导入失败，请根据提示调整后重试", progress: 100 },
}

type ArticleBatchItemStatus = "ready" | "creating" | "done" | "failed"

const ARTICLE_BATCH_STATUS_LABEL: Record<ArticleBatchItemStatus, string> = {
  ready: "等待创建",
  creating: "创建中",
  done: "已创建",
  failed: "失败",
}

interface ArticleBatchItem {
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
function nextArticleBatchItemId(): string {
  articleBatchItemSeq += 1
  return `article-batch-${Date.now()}-${articleBatchItemSeq}`
}

/** 读取单个 Markdown 文件并解析为批量导入条目；失败时返回错误信息 */
async function parseArticleBatchFile(
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

const NODE_DND_PREFIX = "kb-node:"
const FOLDER_DROP_DND_PREFIX = "kb-folder-drop:"
const TREE_NODE_INDENT_PX = 20
/** 拖拽悬停多久自动展开折叠的文件夹（spring-loaded folder）。 */
const SPRING_LOAD_EXPAND_DELAY_MS = 600

/**
 * 树是嵌套 sortable：文件夹的 sortable 矩形包含整棵子树，父子会各自叠加一次位移，
 * 排序预览算出来的 transform 根本不对，还会把子节点推出带 overflow:hidden 的子树容器被裁掉。
 * 落点已经由插入线和整行高亮表达，这里不需要任何位移预览。
 */
const noSortingTransform: SortingStrategy = () => null

type FolderTreeNode = {
  id: string
  parentId: string | null
  name: string
  hasChildren: boolean
  children?: FolderTreeNode[]
}

type SortableTreeNodeBindings = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "isDragging"
>

function toNodeDndId(nodeId: string) {
  return `${NODE_DND_PREFIX}${nodeId}`
}

function toFolderDropDndId(folderId: string) {
  return `${FOLDER_DROP_DND_PREFIX}${folderId}`
}

function parseNodeDndId(value: UniqueIdentifier | null | undefined): string | null {
  if (value == null) {
    return null
  }
  const raw = String(value)
  return raw.startsWith(NODE_DND_PREFIX) ? raw.slice(NODE_DND_PREFIX.length) : null
}

function parseFolderDropDndId(value: UniqueIdentifier | null | undefined): string | null {
  if (value == null) {
    return null
  }
  const raw = String(value)
  return raw.startsWith(FOLDER_DROP_DND_PREFIX)
    ? raw.slice(FOLDER_DROP_DND_PREFIX.length)
    : null
}

function formatDateYmd(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
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

function toFolderTreeNodes(nodes: KnowledgeBaseTreeNode[]): FolderTreeNode[] {
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

function treeContainsNode(nodes: KnowledgeBaseTreeNode[], nodeId: string): boolean {
  for (const node of nodes) {
    if (node.id === nodeId) return true
    if (Array.isArray(node.children) && treeContainsNode(node.children, nodeId)) {
      return true
    }
  }
  return false
}

function findTreeNode(nodes: KnowledgeBaseTreeNode[], nodeId: string): KnowledgeBaseTreeNode | null {
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

function getSiblingNodes(
  nodes: KnowledgeBaseTreeNode[],
  parentId: string | null
): KnowledgeBaseTreeNode[] {
  if (parentId == null) {
    return nodes
  }

  const parent = findTreeNode(nodes, parentId)
  return Array.isArray(parent?.children) ? parent.children : []
}

function isDescendantInLoadedTree(
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

function collectVisibleNodeDndIds(
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
type AnimatedIconHandle = {
  startAnimation: () => void
  stopAnimation: () => void
}

type AnimatedIconComponent = React.ForwardRefExoticComponent<
  { className?: string; size?: number } & React.RefAttributes<AnimatedIconHandle>
>

/** 知识库顶部的图标动作按钮：Tooltip 承载文案，悬停/聚焦时播放图标动效 */
function KnowledgeBaseHeaderAction({
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
/**
 * 标签栏里的纯图标标签：文案交给 Tooltip 与按钮的 aria-label。
 * 图标统一塞进 18×18 的方盒子——两个图标各自的实现（内联 svg / 带 div 包裹的动画图标）
 * 撑出来的宽度并不一样，不定死盒子的话两个标签下划线就会一长一短。
 */
function KnowledgeBaseViewLabel({
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

function KnowledgeBaseBuildButton({
  building,
  onBuild,
}: {
  building: boolean
  onBuild: () => void
}) {
  const iconRef = React.useRef<AnimatedIconHandle>(null)

  const label = building ? "知识构建中…" : "构建知识"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          className="hidden size-7 rounded-lg text-muted-foreground sm:inline-flex hover:text-foreground"
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
            <Loader2 className="size-3.5 animate-spin" />
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
const TreeNodeDragBindingsContext = React.createContext<SortableTreeNodeBindings | null>(null)

function KnowledgeBaseDragHandle({
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

function KnowledgeBaseFolderDropTarget({
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

function SortableKnowledgeBaseTreeNode({
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

function KnowledgeBaseDragOverlay({ node }: { node: KnowledgeBaseTreeNode | null }) {
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

function KnowledgeBaseFolderTreeIcon({ expanded }: { expanded: boolean }) {
  return expanded ? (
    <FolderOpen className="h-4 w-4 text-yellow-500" />
  ) : (
    <Folder className="h-4 w-4 text-blue-500" />
  )
}

/** 收集「从根到选中文件夹」这条路径上的所有 id，用来自动展开露出当前选择。 */
function collectSelectedFolderPath(
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

function toCreateArticleFolderItems(
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

function CreateArticleFolderTree({
  roots,
  selectedFolderId,
  disabled,
  onSelectFolder,
}: {
  roots: FolderTreeNode[]
  selectedFolderId: string | null
  disabled?: boolean
  onSelectFolder: (folder: { id: string; name: string } | null) => void
}) {
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(
    () => collectSelectedFolderPath(roots, selectedFolderId)
  )

  // 选择变化时把这条路径补进展开集合，保证选中的文件夹始终可见。
  React.useEffect(() => {
    const path = collectSelectedFolderPath(roots, selectedFolderId)
    if (path.size === 0) return
    setExpandedIds((current) => {
      let changed = false
      const next = new Set(current)
      for (const id of path) {
        if (!next.has(id)) {
          next.add(id)
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [roots, selectedFolderId])

  const handleExpandedChange = React.useCallback((id: string, nextExpanded: boolean) => {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (nextExpanded) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const items = React.useMemo(
    () => toCreateArticleFolderItems(roots, expandedIds, selectedFolderId, disabled, onSelectFolder),
    [roots, expandedIds, selectedFolderId, disabled, onSelectFolder]
  )

  if (!roots.length) {
    return (
      <div className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
        暂无文件夹，可选择根目录创建。
      </div>
    )
  }

  return (
    <NativeNestedList
      items={items}
      activeId={selectedFolderId ?? undefined}
      expandedIds={expandedIds}
      onExpandedChange={handleExpandedChange}
    />
  )
}

function normalizeDateRange(value: DateRange | undefined): DateRange | undefined {
  if (!value?.from || !value?.to) {
    return value
  }
  if (value.from.getTime() <= value.to.getTime()) {
    return value
  }
  return { from: value.to, to: value.from }
}

function updateNodeChildren(
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

type DeleteTarget =
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

export function KnowledgeBaseTreePage() {
  const { knowledgeBaseId } = useParams()
  const navigate = useNavigate()

  const [knowledgeBase, setKnowledgeBase] = React.useState<KnowledgeBaseResponse | null>(null)
  const [roots, setRoots] = React.useState<KnowledgeBaseTreeNode[]>([])
  const [totalFolders, setTotalFolders] = React.useState(0)
  const [pageIndex, setPageIndex] = React.useState(0)
  const [pageSize] = React.useState(10)
  const [keyword, setKeyword] = React.useState("")
  const [debouncedKeyword, setDebouncedKeyword] = React.useState("")
  const [articleCreatedDateRange, setArticleCreatedDateRange] = React.useState<DateRange | undefined>()
  const [articleCreatedDateDraftRange, setArticleCreatedDateDraftRange] = React.useState<DateRange | undefined>()
  const [articleCreatedDateOpen, setArticleCreatedDateOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set())
  const [nodeLoadingById, setNodeLoadingById] = React.useState<Record<string, boolean>>({})
  const [nodeLoadErrorById, setNodeLoadErrorById] = React.useState<Record<string, boolean>>({})
  const [createFolderOpen, setCreateFolderOpen] = React.useState(false)
  const [createFolderParentId, setCreateFolderParentId] = React.useState<string | null>(null)
  const [createFolderParentName, setCreateFolderParentName] = React.useState<string | null>(null)
  const [createFolderName, setCreateFolderName] = React.useState("")
  const [createArticleOpen, setCreateArticleOpen] = React.useState(false)
  const [createArticleParentId, setCreateArticleParentId] = React.useState<string | null>(null)
  const [createArticleParentName, setCreateArticleParentName] = React.useState<string | null>(null)
  const [createArticleTitle, setCreateArticleTitle] = React.useState("")
  const [createArticleFolderTree, setCreateArticleFolderTree] = React.useState<FolderTreeNode[]>([])
  const [createArticleFolderTreeLoading, setCreateArticleFolderTreeLoading] = React.useState(false)
  const [createArticleFolderTreeError, setCreateArticleFolderTreeError] = React.useState<string | null>(null)
  const [createArticleMarkdownFile, setCreateArticleMarkdownFile] = React.useState<File | null>(null)
  const [createArticleMarkdown, setCreateArticleMarkdown] = React.useState("")
  const [createArticleFileError, setCreateArticleFileError] = React.useState<string | null>(null)
  const [createArticleDialogError, setCreateArticleDialogError] = React.useState<string | null>(null)
  const [createArticleImportStage, setCreateArticleImportStage] =
    React.useState<CreateArticleImportStage>("idle")
  const [createArticleDragActive, setCreateArticleDragActive] = React.useState(false)
  const [createArticleBatchItems, setCreateArticleBatchItems] = React.useState<ArticleBatchItem[]>([])
  const [createArticleBatchParsing, setCreateArticleBatchParsing] = React.useState(false)
  const [createArticleBatchRunning, setCreateArticleBatchRunning] = React.useState(false)
  const [importDialogOpen, setImportDialogOpen] = React.useState(false)
  const [activeView, setActiveView] = React.useState<"documents" | "knowledge">("documents")
  const prefersReducedMotion = useReducedMotion()
  const [buildingArticleIds, setBuildingArticleIds] = React.useState<Set<string>>(new Set())
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deleteTarget, setDeleteTarget] = React.useState<DeleteTarget | null>(null)
  const [activeDragNodeId, setActiveDragNodeId] = React.useState<string | null>(null)
  const [dropIntent, setDropIntent] = React.useState<DropIntent | null>(null)
  const [movingNodeId, setMovingNodeId] = React.useState<string | null>(null)
  const createArticleFileInputRef = React.useRef<HTMLInputElement | null>(null)
  // 行元素本体（不含展开的子树），命中测试要按行高算，sortable 包裹层的矩形是整棵子树。
  const rowElementsRef = React.useRef(new Map<string, HTMLDivElement>())
  const rowRefCallbacksRef = React.useRef(new Map<string, React.RefCallback<HTMLDivElement>>())
  const springLoadTimerRef = React.useRef<number | null>(null)

  const getRowRef = React.useCallback((nodeId: string) => {
    const cached = rowRefCallbacksRef.current.get(nodeId)
    if (cached) return cached

    const callback: React.RefCallback<HTMLDivElement> = (element) => {
      if (element) rowElementsRef.current.set(nodeId, element)
      else rowElementsRef.current.delete(nodeId)
    }
    rowRefCallbacksRef.current.set(nodeId, callback)
    return callback
  }, [])

  const articleCreatedDateFrom = articleCreatedDateRange?.from
    ? formatDateYmd(articleCreatedDateRange.from)
    : undefined
  const articleCreatedDateTo = articleCreatedDateRange?.to
    ? formatDateYmd(articleCreatedDateRange.to)
    : undefined
  const hasArticleCreatedDateFilter = Boolean(articleCreatedDateFrom && articleCreatedDateTo)
  const articleCreatedDateLabel = hasArticleCreatedDateFilter
    ? `创建日期：${articleCreatedDateFrom} ~ ${articleCreatedDateTo}`
    : "创建日期（全部）"
  const currentPage = pageIndex + 1
  const totalPages = Math.max(1, Math.ceil(totalFolders / pageSize))
  const isSearching = debouncedKeyword.length > 0 || hasArticleCreatedDateFilter
  const isCreateArticleBatch = createArticleBatchItems.length > 0
  const createArticleBusy =
    saving ||
    createArticleImportStage === "reading" ||
    createArticleImportStage === "creating" ||
    createArticleBatchParsing ||
    createArticleBatchRunning
  const createArticleBatchReadyCount = createArticleBatchItems.filter(
    (item) => item.status === "ready"
  ).length
  const createArticleBatchDoneCount = createArticleBatchItems.filter(
    (item) => item.status === "done"
  ).length
  const createArticleBatchFailedCount = createArticleBatchItems.filter(
    (item) => item.status === "failed"
  ).length
  const createArticleImportMeta = CREATE_ARTICLE_IMPORT_STAGE_META[createArticleImportStage]
  const createArticleTargetText = createArticleParentId
    ? `将在 ${createArticleParentName || "所选文件夹"} 下创建`
    : "将在根目录创建"
  const dragDisabled = isSearching || loading || saving || Boolean(movingNodeId)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )
  const collisionDetection = React.useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args)
    if (pointerCollisions.length === 0) {
      return closestCenter(args)
    }

    // 行尾「放入文件夹」按钮压在行上，两者都会命中，按钮优先。
    const folderDropCollision = pointerCollisions.find((collision) =>
      parseFolderDropDndId(collision.id)
    )
    if (folderDropCollision) {
      return [folderDropCollision]
    }

    // sortable 包的是「行 + 整棵子树」，pointerWithin 按矩形中心排序会让祖先盖过后代
    // （祖先中心可能反而离指针更近）。指针实际落在谁的行本体上，就算命中谁。
    const pointerY = args.pointerCoordinates?.y
    if (pointerY != null) {
      const rowCollision = pointerCollisions.find((collision) => {
        const nodeId = parseNodeDndId(collision.id)
        if (!nodeId) return false
        const rect = rowElementsRef.current.get(nodeId)?.getBoundingClientRect()
        return !!rect && pointerY >= rect.top && pointerY <= rect.bottom
      })
      if (rowCollision) {
        return [rowCollision]
      }
    }

    return pointerCollisions
  }, [])
  const visibleNodeDndIds = React.useMemo(
    () => collectVisibleNodeDndIds(roots, expandedIds),
    [expandedIds, roots]
  )
  const activeDragNode = React.useMemo(
    () => activeDragNodeId ? findTreeNode(roots, activeDragNodeId) : null,
    [activeDragNodeId, roots]
  )

  const autoExpandedFolderIds = React.useMemo(() => {
    const keyword = debouncedKeyword.trim()
    if (!keyword) {
      return new Set<string>()
    }

    const needle = keyword.toLowerCase()
    const expanded = new Set<string>()

    const walk = (node: KnowledgeBaseTreeNode): boolean => {
      const selfMatch = node.name?.toLowerCase().includes(needle) ?? false

      if (node.type !== "FOLDER") {
        return selfMatch
      }

      const children = Array.isArray(node.children) ? node.children : []
      let childHasMatch = false
      for (const child of children) {
        if (walk(child)) {
          childHasMatch = true
        }
      }

      if (childHasMatch) {
        expanded.add(node.id)
      }

      return selfMatch || childHasMatch
    }

    for (const root of roots) {
      walk(root)
    }
    return expanded
  }, [debouncedKeyword, roots])

  // Sync autoExpandedFolderIds to expandedIds when searching
  React.useEffect(() => {
    if (debouncedKeyword.trim()) {
      setExpandedIds((prev) => {
        const next = new Set(prev)
        autoExpandedFolderIds.forEach((id) => next.add(id))
        return next
      })
    }
  }, [autoExpandedFolderIds, debouncedKeyword])

  React.useEffect(() => {
    setPageIndex(0)
    setKeyword("")
    setDebouncedKeyword("")
    setArticleCreatedDateRange(undefined)
    setArticleCreatedDateDraftRange(undefined)
    setArticleCreatedDateOpen(false)
    setCreateFolderOpen(false)
    setCreateFolderParentId(null)
    setCreateFolderParentName(null)
    setCreateFolderName("")
    setCreateArticleOpen(false)
    setCreateArticleParentId(null)
    setCreateArticleParentName(null)
    setCreateArticleTitle("")
    setCreateArticleFolderTree([])
    setCreateArticleFolderTreeLoading(false)
    setCreateArticleFolderTreeError(null)
    setCreateArticleMarkdownFile(null)
    setCreateArticleMarkdown("")
    setCreateArticleFileError(null)
    setCreateArticleDialogError(null)
    setCreateArticleImportStage("idle")
    setCreateArticleDragActive(false)
    setCreateArticleBatchItems([])
    setCreateArticleBatchParsing(false)
    setCreateArticleBatchRunning(false)
    setImportDialogOpen(false)
    setActiveView("documents")
    setBuildingArticleIds(new Set())
    setDeleteOpen(false)
    setDeleteTarget(null)
    setActiveDragNodeId(null)
    setDropIntent(null)
    setMovingNodeId(null)
  }, [knowledgeBaseId])

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedKeyword(keyword.trim())
    }, 300)
    return () => window.clearTimeout(timer)
  }, [keyword])

  React.useEffect(() => {
    if (!knowledgeBaseId) {
      return
    }

    let canceled = false
    knowledgeBaseApi.detail(knowledgeBaseId)
      .then((kbRes) => {
        if (canceled) {
          return
        }
        setKnowledgeBase(kbRes.data)
        rememberKnowledgeBase(kbRes.data)
      })
      .catch(() => {
        if (canceled) {
          return
        }
        setKnowledgeBase(null)
      })

    return () => {
      canceled = true
    }
  }, [knowledgeBaseId])

  const fetchTree = React.useCallback(async () => {
    if (!knowledgeBaseId) {
      return
    }

    setLoading(true)
    setNodeLoadingById({})
    setNodeLoadErrorById({})

    try {
      const res = debouncedKeyword || hasArticleCreatedDateFilter
        ? await knowledgeBaseNodeApi.tree(knowledgeBaseId, {
          pageNum: pageIndex + 1,
          pageSize,
          keyword: debouncedKeyword || undefined,
          articleCreatedDateFrom,
          articleCreatedDateTo,
        })
        : await knowledgeBaseNodeApi.roots(knowledgeBaseId, {
          pageNum: pageIndex + 1,
          pageSize,
        })

      setRoots(res.data.roots || [])
      setTotalFolders(res.data.totalFolders ?? 0)
    } catch {
      setRoots([])
      setTotalFolders(0)
      toast.error("加载目录失败")
    } finally {
      setLoading(false)
    }
  }, [
    articleCreatedDateFrom,
    articleCreatedDateTo,
    debouncedKeyword,
    hasArticleCreatedDateFilter,
    knowledgeBaseId,
    pageIndex,
    pageSize,
  ])

  React.useEffect(() => {
    void fetchTree()
  }, [fetchTree])

  const buildArticleKnowledge = React.useCallback(async (articleId: string) => {
    if (!knowledgeBaseId || buildingArticleIds.has(articleId)) return
    setBuildingArticleIds((current) => new Set(current).add(articleId))
    try {
      const response = await knowledgeBaseWikiAgentApi.buildArticleKnowledge({
        knowledgeBaseId,
        articleId,
      })
      const result = response.data
      toast.success(
        `知识构建完成：${result.chunkCount} 个切片、${result.entityCount} 个实体、${result.conceptCount} 个概念${result.fromCache ? "（已复用）" : ""}`
      )
      if (result.warnings.length > 0) toast.warning(result.warnings[0])
      await fetchTree()
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "知识构建失败"))
    } finally {
      setBuildingArticleIds((current) => {
        const next = new Set(current)
        next.delete(articleId)
        return next
      })
    }
  }, [buildingArticleIds, fetchTree, knowledgeBaseId])

  React.useEffect(() => {
    if (pageIndex > totalPages - 1) {
      setPageIndex(totalPages - 1)
    }
  }, [pageIndex, totalPages])

  const loadChildren = React.useCallback(
    async (nodeId: string) => {
      if (!knowledgeBaseId) {
        return
      }
      if (nodeLoadingById[nodeId]) {
        return
      }

      setNodeLoadingById((prev) => ({ ...prev, [nodeId]: true }))
      setNodeLoadErrorById((prev) => {
        if (!prev[nodeId]) {
          return prev
        }
        const next = { ...prev }
        delete next[nodeId]
        return next
      })

      try {
        const res = await knowledgeBaseNodeApi.children(knowledgeBaseId, { parentId: nodeId })
        const children = res.data.nodes || []
        setRoots((prev) => updateNodeChildren(prev, nodeId, children))
      } catch {
        setNodeLoadErrorById((prev) => ({ ...prev, [nodeId]: true }))
      } finally {
        setNodeLoadingById((prev) => {
          if (!prev[nodeId]) {
            return prev
          }
          const next = { ...prev }
          delete next[nodeId]
          return next
        })
      }
    },
    [knowledgeBaseId, nodeLoadingById]
  )

  React.useEffect(() => {
    if (isSearching || expandedIds.size === 0) {
      return
    }

    const pendingNodeIds: string[] = []

    const walk = (nodes: KnowledgeBaseTreeNode[]) => {
      for (const node of nodes) {
        if (node.type !== "FOLDER") {
          continue
        }
        if (!expandedIds.has(node.id)) {
          continue
        }
        const hasChildren = node.hasChildren ?? (node.children?.length || 0) > 0
        const loadedChildren = Array.isArray(node.children) && node.children.length > 0
        const loading = !!nodeLoadingById[node.id]
        const failed = !!nodeLoadErrorById[node.id]
        if (hasChildren && !loadedChildren && !loading && !failed) {
          pendingNodeIds.push(node.id)
        }
        if (Array.isArray(node.children) && node.children.length > 0) {
          walk(node.children)
        }
      }
    }

    walk(roots)
    pendingNodeIds.forEach((nodeId) => {
      void loadChildren(nodeId)
    })
  }, [expandedIds, isSearching, loadChildren, nodeLoadErrorById, nodeLoadingById, roots])

  const openCreateFolder = React.useCallback((parent: { id: string; name: string } | null) => {
    setCreateFolderParentId(parent?.id ?? null)
    setCreateFolderParentName(parent?.name ?? null)
    setCreateFolderName("")
    setCreateFolderOpen(true)
  }, [])

  const submitCreateFolder = React.useCallback(async () => {
    if (!knowledgeBaseId) return
    const name = createFolderName.trim()
    if (!name) {
      toast.error("文件夹名称不能为空")
      return
    }
    if (saving) return

    setSaving(true)
    try {
      await knowledgeBaseNodeApi.createFolder({
        knowledgeBaseId,
        parentId: createFolderParentId,
        name,
      })
      toast.success("文件夹已创建")
      setCreateFolderOpen(false)

      if (isSearching) {
        await fetchTree()
        return
      }
      if (createFolderParentId) {
        await loadChildren(createFolderParentId)
        return
      }
      await fetchTree()
    } catch (e: unknown) {
      const msg = (() => {
        if (typeof e === "object" && e && "response" in e) {
          const response = (e as { response?: { data?: { msg?: unknown } } })
            .response
          const apiMsg = response?.data?.msg
          if (typeof apiMsg === "string" && apiMsg) {
            return apiMsg
          }
        }
        if (e instanceof Error && e.message) return e.message
        return "创建文件夹失败"
      })()
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }, [createFolderName, createFolderParentId, fetchTree, isSearching, knowledgeBaseId, loadChildren, saving])

  const loadCreateArticleFolderTree = React.useCallback(async () => {
    if (!knowledgeBaseId) {
      setCreateArticleFolderTree([])
      return
    }

    setCreateArticleFolderTreeLoading(true)
    setCreateArticleFolderTreeError(null)
    try {
      const res = await knowledgeBaseNodeApi.tree(knowledgeBaseId, {
        pageNum: 1,
        pageSize: 1000,
      })
      setCreateArticleFolderTree(toFolderTreeNodes(res.data.roots || []))
    } catch (error: unknown) {
      setCreateArticleFolderTree([])
      setCreateArticleFolderTreeError(resolveApiErrorMessage(error, "加载文件夹树失败"))
    } finally {
      setCreateArticleFolderTreeLoading(false)
    }
  }, [knowledgeBaseId])

  const clearCreateArticleMarkdownFile = React.useCallback(() => {
    setCreateArticleMarkdownFile(null)
    setCreateArticleMarkdown("")
    setCreateArticleFileError(null)
    setCreateArticleDialogError(null)
    setCreateArticleImportStage("idle")
    setCreateArticleDragActive(false)
    setCreateArticleBatchItems([])
    if (createArticleFileInputRef.current) {
      createArticleFileInputRef.current.value = ""
    }
  }, [])

  const updateCreateArticleBatchItem = React.useCallback(
    (id: string, patch: Partial<ArticleBatchItem>) => {
      setCreateArticleBatchItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, ...patch } : item))
      )
    },
    []
  )

  const removeCreateArticleBatchItem = React.useCallback((id: string) => {
    setCreateArticleBatchItems((prev) => prev.filter((item) => item.id !== id))
  }, [])

  /** 把新选择的 Markdown 文件解析后追加进批量列表（按 key 去重、忽略非法文件） */
  const appendCreateArticleBatchFiles = React.useCallback(
    async (existingItems: ArticleBatchItem[], files: File[]) => {
      // 批量条目只保留 key，这里按 key 去重已选过的文件
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
      if (duplicate > 0) {
        toast.info(`已忽略 ${duplicate} 个重复文件`)
      }

      const room = BATCH_IMPORT_MAX_FILES - existingItems.length
      let accepted = incoming
      if (incoming.length > room) {
        toast.error(`一次最多导入 ${BATCH_IMPORT_MAX_FILES} 篇文章，已截断多余文件`)
        accepted = incoming.slice(0, Math.max(0, room))
      }
      if (accepted.length === 0) {
        return
      }

      setCreateArticleBatchParsing(true)
      try {
        const results = await Promise.all(accepted.map((file) => parseArticleBatchFile(file)))
        const parsedItems: ArticleBatchItem[] = []
        const failedNames: string[] = []
        for (const result of results) {
          if (result.ok) {
            parsedItems.push(result.item)
          } else {
            failedNames.push(result.fileName)
          }
        }
        if (failedNames.length > 0) {
          toast.error(`已忽略 ${failedNames.length} 个无法导入的文件`)
        }
        if (parsedItems.length > 0) {
          setCreateArticleBatchItems((prev) => [...prev, ...parsedItems])
        }
      } finally {
        setCreateArticleBatchParsing(false)
      }
    },
    []
  )

  const readCreateArticleMarkdownFile = React.useCallback(async (file: File) => {
    setCreateArticleDialogError(null)
    const fileValidationError = validateMarkdownImportFile(file)
    if (fileValidationError) {
      setCreateArticleMarkdownFile(null)
      setCreateArticleMarkdown("")
      setCreateArticleFileError(fileValidationError)
      setCreateArticleImportStage("error")
      return
    }

    setCreateArticleMarkdownFile(file)
    setCreateArticleMarkdown("")
    setCreateArticleFileError(null)
    setCreateArticleDialogError(null)
    setCreateArticleImportStage("reading")

    try {
      const markdown = await file.text()
      const markdownValidationError = validateMarkdownImportText(markdown)
      if (markdownValidationError) {
        setCreateArticleMarkdownFile(null)
        setCreateArticleMarkdown("")
        setCreateArticleFileError(markdownValidationError)
        setCreateArticleImportStage("error")
        return
      }

      setCreateArticleMarkdown(markdown)
      setCreateArticleTitle(resolveMarkdownImportTitle(markdown, file.name))
      setCreateArticleImportStage("ready")
    } catch {
      setCreateArticleMarkdownFile(null)
      setCreateArticleMarkdown("")
      setCreateArticleFileError("读取 Markdown 文件失败，请重新选择文件")
      setCreateArticleImportStage("error")
    }
  }, [])

  /** 统一的「选择文件」入口：1 个文件走单篇编辑流程，多个文件走批量导入流程 */
  const handleCreateArticlePickFiles = React.useCallback(
    (files: File[]) => {
      if (files.length === 0) return
      setCreateArticleDialogError(null)

      if (createArticleBatchItems.length > 0) {
        void appendCreateArticleBatchFiles(createArticleBatchItems, files)
        return
      }

      const total = (createArticleMarkdownFile ? 1 : 0) + files.length
      if (total <= 1) {
        void readCreateArticleMarkdownFile(files[0])
        return
      }

      // 进入批量模式：把已选的单个文件（若有）和新文件一起解析
      const combined = createArticleMarkdownFile ? [createArticleMarkdownFile, ...files] : files
      setCreateArticleMarkdownFile(null)
      setCreateArticleMarkdown("")
      setCreateArticleFileError(null)
      setCreateArticleImportStage("idle")
      void appendCreateArticleBatchFiles([], combined)
    },
    [appendCreateArticleBatchFiles, createArticleBatchItems, createArticleMarkdownFile, readCreateArticleMarkdownFile]
  )

  const openCreateArticle = React.useCallback((parent: { id: string; name: string } | null) => {
    setCreateArticleParentId(parent?.id ?? null)
    setCreateArticleParentName(parent?.name ?? null)
    setCreateArticleTitle("")
    setCreateArticleFileError(null)
    setCreateArticleDialogError(null)
    setCreateArticleMarkdownFile(null)
    setCreateArticleMarkdown("")
    setCreateArticleImportStage("idle")
    setCreateArticleDragActive(false)
    setCreateArticleBatchItems([])
    setCreateArticleBatchParsing(false)
    setCreateArticleBatchRunning(false)
    setCreateArticleOpen(true)
  }, [])

  React.useEffect(() => {
    if (!createArticleOpen) {
      return
    }
    void loadCreateArticleFolderTree()
  }, [createArticleOpen, loadCreateArticleFolderTree])

  const refreshTreeAfterCreateArticle = React.useCallback(async () => {
    if (isSearching) {
      await fetchTree()
    } else if (createArticleParentId && treeContainsNode(roots, createArticleParentId)) {
      setExpandedIds((prev) => {
        const next = new Set(prev)
        next.add(createArticleParentId)
        return next
      })
      await loadChildren(createArticleParentId)
    } else {
      await fetchTree()
    }
  }, [createArticleParentId, fetchTree, isSearching, loadChildren, roots])

  const submitCreateArticleBatch = React.useCallback(async () => {
    if (!knowledgeBaseId) return
    if (createArticleBatchRunning) return

    const targets = createArticleBatchItems.filter(
      (item) => item.status === "ready" || item.status === "failed"
    )
    const runnable = targets.filter((item) => {
      const trimmed = item.title.trim()
      if (!trimmed) {
        updateCreateArticleBatchItem(item.id, { status: "failed", error: "文章标题不能为空" })
        return false
      }
      if (trimmed.length > 200) {
        updateCreateArticleBatchItem(item.id, { status: "failed", error: "文章标题不能超过 200 个字符" })
        return false
      }
      return true
    })
    if (runnable.length === 0) {
      setCreateArticleDialogError("没有可创建的文章，请检查文件标题")
      return
    }

    setCreateArticleBatchRunning(true)
    setCreateArticleDialogError(null)

    let succeeded = 0
    let failed = 0
    for (const item of runnable) {
      updateCreateArticleBatchItem(item.id, { status: "creating", error: undefined })
      try {
        const res = await knowledgeBaseArticleApi.create({
          knowledgeBaseId,
          parentId: createArticleParentId,
          title: item.title.trim(),
          contentMd: item.markdown,
          tags: [],
        })
        updateCreateArticleBatchItem(item.id, { status: "done", articleId: res.data.articleId, error: undefined })
        succeeded += 1
      } catch (e: unknown) {
        updateCreateArticleBatchItem(item.id, {
          status: "failed",
          error: resolveApiErrorMessage(e, "创建文章失败"),
        })
        failed += 1
      }
    }

    setCreateArticleBatchRunning(false)

    if (succeeded > 0) {
      await refreshTreeAfterCreateArticle()
    }

    if (failed === 0) {
      toast.success(`已创建 ${succeeded} 篇文章`)
      setCreateArticleOpen(false)
      setCreateArticleBatchItems([])
    } else {
      toast.error(`成功 ${succeeded} 篇，失败 ${failed} 篇，可重试失败项`)
    }
  }, [
    createArticleBatchItems,
    createArticleBatchRunning,
    createArticleParentId,
    knowledgeBaseId,
    refreshTreeAfterCreateArticle,
    updateCreateArticleBatchItem,
  ])

  const submitCreateArticle = React.useCallback(async () => {
    if (isCreateArticleBatch) {
      await submitCreateArticleBatch()
      return
    }
    if (!knowledgeBaseId) return
    const title = createArticleTitle.trim()
    if (!title) {
      setCreateArticleDialogError("文章标题不能为空")
      return
    }
    if (title.length > 200) {
      setCreateArticleDialogError("文章标题不能超过 200 个字符")
      return
    }
    if (createArticleImportStage === "reading") {
      setCreateArticleFileError("Markdown 文件仍在读取中，请稍后再创建")
      return
    }
    if (createArticleMarkdownFile && !createArticleMarkdown.trim()) {
      setCreateArticleFileError("Markdown 文件没有可导入的正文内容")
      setCreateArticleImportStage("error")
      return
    }
    if (saving) return

    setSaving(true)
    setCreateArticleDialogError(null)
    if (createArticleMarkdownFile) {
      setCreateArticleFileError(null)
      setCreateArticleImportStage("creating")
    }
    try {
      const contentMd = createArticleMarkdownFile
        ? createArticleMarkdown
        : `# ${title}\n\n`
      const res = await knowledgeBaseArticleApi.create({
        knowledgeBaseId,
        parentId: createArticleParentId,
        title,
        contentMd,
        tags: [],
      })

      toast.success("文章已创建")
      setCreateArticleOpen(false)
      setCreateArticleMarkdownFile(null)
      setCreateArticleMarkdown("")
      setCreateArticleFileError(null)
      setCreateArticleDialogError(null)
      setCreateArticleImportStage("idle")

      await refreshTreeAfterCreateArticle()

      navigate(knowledgeBaseArticlePath(knowledgeBaseId, res.data.articleId))
    } catch (e: unknown) {
      const msg = resolveApiErrorMessage(e, "创建文章失败")
      setCreateArticleDialogError(msg)
      if (createArticleMarkdownFile) {
        setCreateArticleImportStage("error")
      }
    } finally {
      setSaving(false)
    }
  }, [
    createArticleImportStage,
    createArticleMarkdown,
    createArticleMarkdownFile,
    createArticleParentId,
    createArticleTitle,
    isCreateArticleBatch,
    knowledgeBaseId,
    navigate,
    refreshTreeAfterCreateArticle,
    saving,
    submitCreateArticleBatch,
  ])

  const confirmDelete = React.useCallback(async () => {
    if (!deleteTarget) return
    if (!knowledgeBaseId) return
    if (saving) return

    setSaving(true)
    try {
      if (deleteTarget.type === "folder") {
        await knowledgeBaseNodeApi.deleteFolder(deleteTarget.nodeId)
        toast.success("文件夹已删除")

        setDeleteOpen(false)
        setDeleteTarget(null)

        if (isSearching) {
          await fetchTree()
          return
        }
        if (deleteTarget.parentId) {
          await loadChildren(deleteTarget.parentId)
          return
        }
        await fetchTree()
        return
      }

      await knowledgeBaseArticleApi.delete(deleteTarget.articleId)
      toast.success("文章已删除")

      setDeleteOpen(false)
      setDeleteTarget(null)

      if (isSearching) {
        await fetchTree()
        return
      }
      if (deleteTarget.parentId) {
        await loadChildren(deleteTarget.parentId)
        return
      }

      setRoots((prev) => prev.filter((n) => n.id !== deleteTarget.nodeId))
    } catch (e: unknown) {
      const msg = (() => {
        if (typeof e === "object" && e && "response" in e) {
          const response = (e as { response?: { data?: { msg?: unknown } } })
            .response
          const apiMsg = response?.data?.msg
          if (typeof apiMsg === "string" && apiMsg) {
            return apiMsg
          }
        }
        if (e instanceof Error && e.message) return e.message
        return "删除失败"
      })()
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }, [deleteTarget, fetchTree, isSearching, knowledgeBaseId, loadChildren, saving])

  const refreshAfterNodeMove = React.useCallback(
    async (sourceParentId: string | null, targetParentId: string | null) => {
      const folderParentIds = new Set<string>()
      let shouldRefreshRoots = false

      if (sourceParentId) {
        folderParentIds.add(sourceParentId)
      } else {
        shouldRefreshRoots = true
      }

      if (targetParentId) {
        folderParentIds.add(targetParentId)
        setExpandedIds((prev) => {
          const next = new Set(prev)
          next.add(targetParentId)
          return next
        })
      } else {
        shouldRefreshRoots = true
      }

      if (shouldRefreshRoots) {
        await fetchTree()
      }

      await Promise.all([...folderParentIds].map((parentId) => loadChildren(parentId)))
    },
    [fetchTree, loadChildren]
  )

  /**
   * 落点意图的唯一真相来源：悬停高亮和真正落库都读它，避免「亮了却没放进去」。
   * 注意用指针坐标 + 行本体矩形，跟 pointerWithin 的碰撞判定保持同一套参照。
   */
  const computeDropIntent = React.useCallback(
    (event: DragMoveEvent | DragEndEvent): DropIntent | null => {
      const activeNodeId = parseNodeDndId(event.active.id)
      const overId = event.over?.id
      if (!activeNodeId || !overId) {
        return null
      }

      // 行尾那个「放入文件夹」按钮是独立 droppable，命中即表示放入，不再按行内位置判定。
      const overFolderId = parseFolderDropDndId(overId)
      if (overFolderId) {
        return { kind: "into", nodeId: overFolderId }
      }

      const overNodeId = parseNodeDndId(overId)
      if (!overNodeId || overNodeId === activeNodeId) {
        return null
      }

      const overNode = findTreeNode(roots, overNodeId)
      if (!overNode) {
        return null
      }

      const activeNode = findTreeNode(roots, activeNodeId)
      const sourceParentId = activeNode?.parentId ?? null
      const canDropInto =
        overNode.type === "FOLDER" &&
        overNode.id !== sourceParentId &&
        !isDescendantInLoadedTree(roots, activeNodeId, overNode.id)

      const rowRect = rowElementsRef.current.get(overNodeId)?.getBoundingClientRect()
      const pointerY = resolvePointerY(event.activatorEvent, event.delta)
      if (!rowRect || pointerY == null) {
        return { kind: canDropInto ? "into" : "before", nodeId: overNodeId }
      }

      return {
        kind: resolveDropIntentKind(pointerY, rowRect, canDropInto),
        nodeId: overNodeId,
      }
    },
    [roots]
  )

  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    if (dragDisabled) {
      return
    }
    setActiveDragNodeId(parseNodeDndId(event.active.id))
    setDropIntent(null)
  }, [dragDisabled])

  // 行内位置每一帧都在变，onDragOver 只在 over 切换时触发，这里必须用 onDragMove。
  // 但落点意图没变就别写 state，否则整棵树每帧重建一次。
  const handleDragMove = React.useCallback((event: DragMoveEvent) => {
    const next = computeDropIntent(event)
    setDropIntent((current) => {
      if (current?.kind === next?.kind && current?.nodeId === next?.nodeId) {
        return current
      }
      return next
    })
  }, [computeDropIntent])

  const handleDragEnd = React.useCallback(async (event: DragEndEvent) => {
    const activeNodeId = parseNodeDndId(event.active.id)
    const intent = computeDropIntent(event)
    setActiveDragNodeId(null)
    setDropIntent(null)

    if (!knowledgeBaseId || dragDisabled || !activeNodeId || !intent) {
      return
    }

    const activeNode = findTreeNode(roots, activeNodeId)
    if (!activeNode) {
      return
    }

    const sourceParentId = activeNode.parentId ?? null
    let targetParentId: string | null
    let targetIndex: number | undefined

    if (intent.kind === "into") {
      if (intent.nodeId === sourceParentId) {
        return
      }
      targetParentId = intent.nodeId
      targetIndex = undefined
    } else {
      const overNode = findTreeNode(roots, intent.nodeId)
      if (!overNode) {
        return
      }

      targetParentId = overNode.parentId ?? null
      const resolvedIndex = resolveSiblingTargetIndex({
        activeId: activeNodeId,
        kind: intent.kind,
        overId: intent.nodeId,
        // 根级列表是分页的，roots 只有当前页，落库下标要补上前面几页的偏移。
        pageOffset: targetParentId == null ? pageIndex * pageSize : 0,
        sameParent: sourceParentId === targetParentId,
        siblingIds: getSiblingNodes(roots, targetParentId).map((node) => node.id),
      })
      // null = 位置没变或目标已不在列表里，直接放弃这次移动。
      if (resolvedIndex == null) {
        return
      }
      targetIndex = resolvedIndex
    }

    if (targetParentId === activeNodeId || isDescendantInLoadedTree(roots, activeNodeId, targetParentId)) {
      toast.error("不能移动到自身或子文件夹中")
      return
    }

    setMovingNodeId(activeNodeId)
    try {
      await knowledgeBaseNodeApi.move({
        knowledgeBaseId,
        nodeId: activeNodeId,
        targetIndex,
        targetParentId,
      })
      toast.success("位置已更新")
      await refreshAfterNodeMove(sourceParentId, targetParentId)
    } catch (error: unknown) {
      toast.error(resolveApiErrorMessage(error, "移动失败"))
    } finally {
      setMovingNodeId(null)
    }
  }, [
    computeDropIntent,
    dragDisabled,
    knowledgeBaseId,
    pageIndex,
    pageSize,
    refreshAfterNodeMove,
    roots,
  ])

  const buildTreeItem = React.useCallback((node: KnowledgeBaseTreeNode): ListItem => {
    const isFolder = node.type === "FOLDER"
    const hasChildren =
      isFolder && (node.hasChildren ?? (node.children?.length || 0) > 0)
    const isExpanded = expandedIds.has(node.id)
    const isLoadingChildren = !!nodeLoadingById[node.id]
    const hasLoadError = !!nodeLoadErrorById[node.id]

    const canDropIntoFolder =
      isFolder &&
      !!activeDragNodeId &&
      activeDragNodeId !== node.id &&
      node.id !== (activeDragNode?.parentId ?? null) &&
      !isDescendantInLoadedTree(roots, activeDragNodeId, node.id)
    // 高亮和指示线都从 dropIntent 推导，跟松手时的落库判定同源。
    const isDropIntoActive = dropIntent?.kind === "into" && dropIntent.nodeId === node.id
    const dropIndicator =
      dropIntent && dropIntent.kind !== "into" && dropIntent.nodeId === node.id
        ? dropIntent.kind
        : null

    return {
      id: node.id,
      label: node.name,
      hasChildren,
      rowRef: getRowRef(node.id),
      dropIndicator,
      className: cn(
        isDropIntoActive && "bg-primary/10 ring-1 ring-primary/40",
        movingNodeId === node.id && "opacity-60"
      ),
      icon: isFolder ? (
        <KnowledgeBaseFolderTreeIcon expanded={isExpanded} />
      ) : (
        <div className="flex h-4 w-4 items-center justify-center">
          <FileIcon name={node.name} />
        </div>
      ),
      leading: <KnowledgeBaseDragHandle disabled={dragDisabled} nodeName={node.name} />,
      trailing: (
        <>
          {!isFolder ? <ArticleStatusBadges status={node.status} /> : null}
          {isFolder && activeDragNodeId ? (
            <KnowledgeBaseFolderDropTarget
              disabled={!canDropIntoFolder}
              folderId={node.id}
            />
          ) : null}
          {!isFolder && node.articleId ? (
            <KnowledgeBaseBuildButton
              building={buildingArticleIds.has(node.articleId)}
              onBuild={() => void buildArticleKnowledge(node.articleId!)}
            />
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <ButtonDelete
                label={`删除「${node.name}」`}
                disabled={!isFolder && !node.articleId}
                onDelete={() => {
                  if (isFolder) {
                    setDeleteTarget({
                      type: "folder",
                      nodeId: node.id,
                      name: node.name,
                      parentId: node.parentId,
                    })
                  } else {
                    if (!node.articleId) return
                    setDeleteTarget({
                      type: "article",
                      articleId: node.articleId,
                      nodeId: node.id,
                      name: node.name,
                      parentId: node.parentId,
                    })
                  }
                  setDeleteOpen(true)
                }}
              />
            </TooltipTrigger>
            <TooltipContent side="top">{`删除「${node.name}」`}</TooltipContent>
          </Tooltip>
        </>
      ),
      onClick: () => {
        if (isFolder) return
        if (!knowledgeBaseId) return
        if (!node.articleId) return
        navigate(knowledgeBaseArticlePath(knowledgeBaseId, node.articleId))
      },
      emptyContent: (
        <div className="flex items-center gap-2 py-1 pl-6 text-sm text-muted-foreground">
          {isLoadingChildren ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              加载中...
            </>
          ) : hasLoadError ? (
            <span
              className="cursor-pointer text-destructive hover:underline"
              onClick={(e) => {
                e.stopPropagation()
                void loadChildren(node.id)
              }}
            >
              加载失败，点击重试
            </span>
          ) : (
            <span className="opacity-50">空文件夹</span>
          )}
        </div>
      ),
      renderWrapper: (content) => (
        <SortableKnowledgeBaseTreeNode disabled={dragDisabled} node={node}>
          {content}
        </SortableKnowledgeBaseTreeNode>
      ),
      children: node.children?.length ? node.children.map(buildTreeItem) : undefined,
    }
  }, [activeDragNode, activeDragNodeId, buildArticleKnowledge, buildingArticleIds, dragDisabled, dropIntent, expandedIds, getRowRef, knowledgeBaseId, loadChildren, movingNodeId, navigate, nodeLoadErrorById, nodeLoadingById, openCreateArticle, openCreateFolder, roots])

  const treeItems = React.useMemo(() => roots.map(buildTreeItem), [buildTreeItem, roots])

  const handleTreeExpandedChange = React.useCallback((id: string, nextExpanded: boolean) => {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (nextExpanded) next.add(id)
      else next.delete(id)
      return next
    })
    // 展开时按需拉子节点；搜索态下的树已经是全量结果，不再触发懒加载。
    if (nextExpanded && !isSearching) void loadChildren(id)
  }, [isSearching, loadChildren])

  // spring-loaded folder：拖着东西在折叠文件夹上悬停一会儿就自动展开，便于往深层拖。
  React.useEffect(() => {
    if (springLoadTimerRef.current != null) {
      window.clearTimeout(springLoadTimerRef.current)
      springLoadTimerRef.current = null
    }

    if (!activeDragNodeId || dropIntent?.kind !== "into") {
      return
    }

    const folderId = dropIntent.nodeId
    if (expandedIds.has(folderId)) {
      return
    }

    const folder = findTreeNode(roots, folderId)
    if (!folder || folder.type !== "FOLDER") {
      return
    }
    if (!(folder.hasChildren ?? (folder.children?.length || 0) > 0)) {
      return
    }

    springLoadTimerRef.current = window.setTimeout(() => {
      springLoadTimerRef.current = null
      handleTreeExpandedChange(folderId, true)
    }, SPRING_LOAD_EXPAND_DELAY_MS)

    return () => {
      if (springLoadTimerRef.current != null) {
        window.clearTimeout(springLoadTimerRef.current)
        springLoadTimerRef.current = null
      }
    }
  }, [activeDragNodeId, dropIntent, expandedIds, handleTreeExpandedChange, roots])

  const handlePageChange = React.useCallback(
    (nextPageIndex: number) => {
      if (nextPageIndex < 0 || nextPageIndex >= totalPages) return
      setPageIndex(nextPageIndex)
    },
    [totalPages],
  )

  return (
    <AstryxProvider>
    <div className="w-full p-4 lg:p-6">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 h-8 gap-1 px-2 text-muted-foreground hover:text-foreground"
            onClick={() => navigate(dashboardRoutes.knowledge)}
          >
            <ChevronLeft className="size-4" />
            知识库
          </Button>
          <div className="min-w-0">
            <h1 className="sr-only">{knowledgeBase?.name || "我的文档"}</h1>
            <AnimatedTabs
              value={activeView}
              size="lg"
              options={[
                {
                  ariaLabel: knowledgeBase?.name || "我的文档",
                  label: (
                    <KnowledgeBaseViewLabel
                      icon={<FileText className="size-[18px] shrink-0" />}
                      label={knowledgeBase?.name || "我的文档"}
                    />
                  ),
                  value: "documents",
                },
                {
                  ariaLabel: "知识空间",
                  label: (
                    <KnowledgeBaseViewLabel
                      icon={<BookOpenIcon className="shrink-0" size={18} />}
                      label="知识空间"
                    />
                  ),
                  value: "knowledge",
                },
              ]}
              ariaLabel="知识库视图"
              // 用位移而不是负 margin 做左对齐：负 margin 会把父级的 max-content 也减掉 12px，
              // 标签栏自身的 max-w-full 就按这个夹窄的宽度收，最后一个触发区和指示条会被裁掉一截。
              className="-translate-x-3"
              onValueChange={(value) => setActiveView(value === "knowledge" ? "knowledge" : "documents")}
            />
            {knowledgeBase?.description ? (
              <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                {knowledgeBase.description}
              </p>
            ) : null}
          </div>
        </div>
        <AnimatePresence initial={false}>
          {activeView === "documents" ? (
            <motion.div
              key="documents-actions"
              className="flex flex-wrap items-center gap-1"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: prefersReducedMotion ? 0 : 0.18 }}
            >
              <KnowledgeBaseHeaderAction
                icon={FolderPlusIcon}
                label="新建文件夹"
                disabled={!knowledgeBaseId || loading || saving}
                onClick={() => openCreateFolder(null)}
              />
              <KnowledgeBaseHeaderAction
                icon={ArrowUpTrayIcon}
                label="导入文档"
                disabled={!knowledgeBaseId}
                onClick={() => setImportDialogOpen(true)}
              />
              <KnowledgeBaseHeaderAction
                icon={DocumentPlusIcon}
                label="新建文章"
                disabled={!knowledgeBaseId || loading || saving}
                onClick={() => openCreateArticle(null)}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      {/* 面板跟着切换滑动：旧视图先退场，新视图再从另一侧进来，方向和标签顺序一致。 */}
      <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={activeView}
        initial={{ opacity: 0, x: prefersReducedMotion ? 0 : -12 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: prefersReducedMotion ? 0 : 12 }}
        transition={{ duration: prefersReducedMotion ? 0 : 0.22, ease: [0.32, 0.72, 0, 1] }}
      >
      {activeView === "documents" ? (
        <>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Input
            value={keyword}
            placeholder="搜索文件夹/文章名称"
            className="sm:w-[360px] lg:w-[420px]"
            onChange={(e) => {
              setKeyword(e.target.value)
              setPageIndex(0)
            }}
          />

          <div className="flex min-w-0 items-center gap-2">
            <DropdownMenu
              open={articleCreatedDateOpen}
              onOpenChange={(open) => {
                setArticleCreatedDateOpen(open)
                if (open) {
                  setArticleCreatedDateDraftRange(normalizeDateRange(articleCreatedDateRange))
                  return
                }
                setArticleCreatedDateDraftRange(undefined)
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-w-0 w-full justify-start sm:w-[320px]"
                >
                  <CalendarIcon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{articleCreatedDateLabel}</span>
                </Button>
              </DropdownMenuTrigger>

              <DropdownMenuContent
                align="end"
                side="bottom"
                sideOffset={8}
                className="p-0"
              >
                <div className="w-fit bg-background p-3">
                  <DateRangeCalendar
                    value={articleCreatedDateDraftRange ?? articleCreatedDateRange}
                    showRangeLabel={false}
                    onChange={(next) => {
                      setArticleCreatedDateDraftRange(next)
                      const normalized = normalizeDateRange(next)
                      if (normalized?.from && normalized?.to) {
                        setArticleCreatedDateRange(normalized)
                        setPageIndex(0)
                        setArticleCreatedDateOpen(false)
                        setArticleCreatedDateDraftRange(undefined)
                      }
                    }}
                  />
                  <div className="mt-2 text-muted-foreground text-xs">
                    {(() => {
                      const normalized = normalizeDateRange(articleCreatedDateDraftRange)
                      if (!normalized?.from) {
                        return "请选择开始日期"
                      }
                      if (!normalized.to) {
                        return `开始：${formatDateYmd(normalized.from)}，请继续选择结束日期`
                      }
                      return `将应用：${formatDateYmd(normalized.from)} ~ ${formatDateYmd(normalized.to)}`
                    })()}
                    <span className="ml-2">（仅按文章创建时间筛选）</span>
                  </div>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>

            {hasArticleCreatedDateFilter ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => {
                  setArticleCreatedDateRange(undefined)
                  setArticleCreatedDateDraftRange(undefined)
                  setArticleCreatedDateOpen(false)
                  setPageIndex(0)
                }}
              >
                <X className="h-4 w-4" />
                清除日期
              </Button>
            ) : null}
          </div>
        </div>

        {loading ? (
          <div
            className="flex min-h-56 items-center justify-center py-10"
            role="status"
            aria-live="polite"
            aria-label="正在加载知识库"
          >
            <OrbitingCircles
              radius={52}
              duration={12}
              iconSize={36}
              className="text-muted-foreground"
            >
              <span className="flex size-9 items-center justify-center rounded-full border border-border/60 bg-background shadow-xs">
                <Folder className="size-4" />
              </span>
              <span className="flex size-9 items-center justify-center rounded-full border border-border/60 bg-background shadow-xs">
                <FileText className="size-4" />
              </span>
              <span className="flex size-9 items-center justify-center rounded-full border border-border/60 bg-background shadow-xs">
                <BookOpen className="size-4" />
              </span>
            </OrbitingCircles>
          </div>
        ) : roots.length === 0 ? (
          <Empty className="border border-dashed py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderOpen />
              </EmptyMedia>
              <EmptyTitle>
                {debouncedKeyword || hasArticleCreatedDateFilter
                  ? "暂无匹配结果"
                  : "暂无文件 / 文件夹"}
              </EmptyTitle>
              <EmptyDescription>
                {debouncedKeyword || hasArticleCreatedDateFilter
                  ? "调整搜索词或日期筛选后再试。"
                  : "从一篇文章或一个文件夹开始整理这个知识库。"}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              {debouncedKeyword || hasArticleCreatedDateFilter ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setKeyword("")
                    setArticleCreatedDateRange(undefined)
                    setArticleCreatedDateDraftRange(undefined)
                    setPageIndex(0)
                  }}
                >
                  清除筛选
                </Button>
              ) : (
                <div className="flex flex-wrap justify-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!knowledgeBaseId || loading || saving}
                    onClick={() => openCreateFolder(null)}
                  >
                    <FolderPlus className="size-4" />
                    新建文件夹
                  </Button>
                  <Button
                    type="button"
                    disabled={!knowledgeBaseId || loading || saving}
                    onClick={() => openCreateArticle(null)}
                  >
                    <Plus className="size-4" />
                    新建文章
                  </Button>
                </div>
              )}
            </EmptyContent>
          </Empty>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragCancel={() => {
              setActiveDragNodeId(null)
              setDropIntent(null)
            }}
            onDragEnd={(event) => {
              void handleDragEnd(event)
            }}
          >
            <SortableContext items={visibleNodeDndIds} strategy={noSortingTransform}>
              <NativeNestedList
                className="p-2"
                items={treeItems}
                indentSize={TREE_NODE_INDENT_PX}
                expandedIds={expandedIds}
                onExpandedChange={handleTreeExpandedChange}
              />
            </SortableContext>
            <DragOverlay>
              <KnowledgeBaseDragOverlay node={activeDragNode} />
            </DragOverlay>
          </DndContext>
        )}
        </div>

        <div className="py-3 mt-2">
          <AppPagination
            page={pageIndex}
            totalPages={totalPages}
            total={totalFolders}
            pageSize={pageSize}
            onChange={handlePageChange}
          />
        </div>
        </>
      ) : knowledgeBaseId ? (
        <KnowledgeExplorerPanel knowledgeBaseId={knowledgeBaseId} />
      ) : null}
      </motion.div>
      </AnimatePresence>

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
          <Label htmlFor="folder-name">名称</Label>
          <Input
            id="folder-name"
            value={createFolderName}
            placeholder="例如：产品文档"
            disabled={saving}
            onChange={(e) => setCreateFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return
              e.preventDefault()
              void submitCreateFolder()
            }}
          />
        </div>
      </ModalShell>

      <ModalShell
        open={createArticleOpen}
        onOpenChange={(open) => {
          if (!open && createArticleBusy) return
          setCreateArticleOpen(open)
        }}
        disableClose={createArticleBusy}
        title={isCreateArticleBatch ? "批量导入文章" : "新建文章"}
        description={createArticleTargetText}
        contentClassName="sm:max-w-2xl"
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={createArticleBusy}
              onClick={() => setCreateArticleOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={
                createArticleBusy ||
                (isCreateArticleBatch
                  ? createArticleBatchReadyCount + createArticleBatchFailedCount === 0
                  : !createArticleTitle.trim())
              }
              onClick={submitCreateArticle}
            >
              {createArticleBusy
                ? "创建中..."
                : isCreateArticleBatch
                  ? createArticleBatchFailedCount > 0 && createArticleBatchReadyCount === 0
                    ? `重试失败（${createArticleBatchFailedCount}）`
                    : `创建 ${createArticleBatchReadyCount + createArticleBatchFailedCount} 篇文章`
                  : "创建并编辑"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <input
            ref={createArticleFileInputRef}
            type="file"
            accept=".md,.markdown,text/markdown,text/x-markdown"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? [])
              event.currentTarget.value = ""
              if (files.length === 0) return
              handleCreateArticlePickFiles(files)
            }}
          />

          {isCreateArticleBatch ? null : (
            <div className="space-y-2">
              <Label htmlFor="article-title">标题</Label>
              <Input
                id="article-title"
                value={createArticleTitle}
                placeholder="例如：产品需求梳理"
                disabled={createArticleBusy}
                maxLength={200}
                onChange={(e) => {
                  setCreateArticleDialogError(null)
                  setCreateArticleTitle(e.target.value)
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return
                  e.preventDefault()
                  void submitCreateArticle()
                }}
              />
            </div>
          )}

          {createArticleDialogError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {createArticleDialogError}
            </div>
          ) : null}

          <div className="space-y-2">
            <Label>{isCreateArticleBatch ? "Markdown 文件" : "Markdown 文件（可选）"}</Label>
            <button
              type="button"
              disabled={createArticleBusy}
              className={cn(
                "flex w-full flex-col items-center justify-center gap-3 rounded-md border border-dashed px-4 py-6 text-center transition-colors",
                createArticleDragActive
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/60 hover:bg-muted/40",
                createArticleBusy ? "cursor-not-allowed opacity-70" : "cursor-pointer"
              )}
              onClick={() => createArticleFileInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault()
                if (!createArticleBusy) {
                  setCreateArticleDragActive(true)
                }
              }}
              onDragLeave={() => setCreateArticleDragActive(false)}
              onDrop={(event) => {
                event.preventDefault()
                setCreateArticleDragActive(false)
                if (createArticleBusy) return
                const files = Array.from(event.dataTransfer.files ?? [])
                if (files.length === 0) return
                handleCreateArticlePickFiles(files)
              }}
            >
              <span className="flex size-10 items-center justify-center rounded-md border bg-background text-muted-foreground">
                <FileUp className="size-5" />
              </span>
              <span className="max-w-full space-y-1">
                <span className="block text-sm font-medium">
                  拖拽 Markdown 文件到这里，或点击选择（可多选批量导入）
                </span>
                <span className="block break-words text-xs text-muted-foreground">
                  支持 .md / .markdown，单个文件不超过 {MARKDOWN_IMPORT_MAX_FILE_BYTES / 1024 / 1024} MB，
                  一次最多 {BATCH_IMPORT_MAX_FILES} 个
                </span>
              </span>
            </button>

            {createArticleBatchParsing ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                正在读取 Markdown 文件…
              </div>
            ) : null}

            {isCreateArticleBatch ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    共 {createArticleBatchItems.length} 个文件
                    {createArticleBatchDoneCount > 0 ? `，已创建 ${createArticleBatchDoneCount} 篇` : ""}
                    {createArticleBatchFailedCount > 0 ? `，失败 ${createArticleBatchFailedCount} 篇` : ""}
                  </p>
                  {!createArticleBusy ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => setCreateArticleBatchItems([])}
                    >
                      清空
                    </Button>
                  ) : null}
                </div>
                <div className="flex max-h-64 flex-col gap-2 overflow-auto app-scrollbar pr-1">
                  {createArticleBatchItems.map((item) => (
                    <ArticleBatchItemRow
                      key={item.id}
                      item={item}
                      busy={createArticleBusy}
                      onTitleChange={(title) => updateCreateArticleBatchItem(item.id, { title })}
                      onRemove={() => removeCreateArticleBatchItem(item.id)}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <>
                {createArticleMarkdownFile ? (
                  <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {createArticleMarkdownFile.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {(createArticleMarkdownFile.size / 1024).toFixed(1)} KB
                        </div>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0"
                      disabled={createArticleBusy}
                      aria-label="移除 Markdown 文件"
                      onClick={clearCreateArticleMarkdownFile}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ) : null}

                {createArticleImportStage !== "idle" ? (
                  <div className="space-y-1.5">
                    <div
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={createArticleImportMeta.progress}
                      className={cn(
                        "h-2 overflow-hidden rounded-full bg-muted",
                        createArticleImportStage === "error" ? "bg-destructive/15" : ""
                      )}
                    >
                      <ImportProgressFill
                        progress={createArticleImportMeta.progress}
                        error={createArticleImportStage === "error"}
                      />
                    </div>
                    <div
                      className={cn(
                        "text-xs",
                        createArticleImportStage === "error"
                          ? "text-destructive"
                          : "text-muted-foreground"
                      )}
                    >
                      {createArticleImportMeta.label}
                    </div>
                  </div>
                ) : null}

                {createArticleFileError ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {createArticleFileError}
                  </div>
                ) : null}
              </>
            )}
          </div>

          <div className="space-y-2">
            <Label>创建位置</Label>
            <div className="rounded-md border p-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={createArticleParentId === null}
                  disabled={createArticleBusy}
                  aria-label="选择根目录作为创建位置"
                  onCheckedChange={() => {
                    setCreateArticleDialogError(null)
                    setCreateArticleParentId(null)
                    setCreateArticleParentName(null)
                  }}
                />
                <Folder className="size-4 shrink-0 text-blue-500" />
                <span className="truncate text-sm">根目录</span>
              </div>

              <div className="mt-3 max-h-64 overflow-auto app-scrollbar pr-1">
                {createArticleFolderTreeLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    正在加载文件夹树…
                  </div>
                ) : createArticleFolderTreeError ? (
                  <div className="space-y-2 text-sm">
                    <div className="text-destructive">{createArticleFolderTreeError}</div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={createArticleBusy}
                      onClick={() => void loadCreateArticleFolderTree()}
                    >
                      重试
                    </Button>
                  </div>
                ) : (
                  <CreateArticleFolderTree
                    roots={createArticleFolderTree}
                    selectedFolderId={createArticleParentId}
                    disabled={createArticleBusy}
                    onSelectFolder={(folder) => {
                      setCreateArticleDialogError(null)
                      setCreateArticleParentId(folder?.id ?? null)
                      setCreateArticleParentName(folder?.name ?? null)
                    }}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
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
            ? `将删除文件夹“${deleteTarget.name}”，并级联删除其下所有内容。`
            : deleteTarget?.type === "article"
              ? `将删除文章“${deleteTarget.name}”。`
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

      {knowledgeBaseId ? (
        <DocumentImportDialog
          open={importDialogOpen}
          onOpenChange={setImportDialogOpen}
          knowledgeBaseId={knowledgeBaseId}
          onViewJobs={() => navigate(dashboardRoutes.imports)}
        />
      ) : null}
    </div>
    </AstryxProvider>
  )
}

function ArticleBatchItemRow({
  item,
  busy,
  onTitleChange,
  onRemove,
}: {
  item: ArticleBatchItem
  busy: boolean
  onTitleChange: (title: string) => void
  onRemove: () => void
}) {
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          {item.status === "done" ? (
            <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
          ) : item.status === "creating" ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <FileText className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-sm">{item.fileName}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span
            className={cn(
              "text-xs",
              item.status === "failed" ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {ARTICLE_BATCH_STATUS_LABEL[item.status]}
          </span>
          {!busy && item.status !== "done" ? (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              aria-label={`移除 ${item.fileName}`}
              onClick={onRemove}
            >
              <X className="size-4" />
            </button>
          ) : null}
        </span>
      </div>

      {item.status !== "done" ? (
        <Input
          value={item.title}
          disabled={busy}
          placeholder="文章标题"
          maxLength={200}
          className="mt-2 h-8"
          onChange={(e) => onTitleChange(e.target.value)}
        />
      ) : null}

      {item.status === "failed" && item.error ? (
        <p className="mt-1.5 text-xs text-destructive">{item.error}</p>
      ) : null}
    </div>
  )
}

function ImportProgressFill({ progress, error }: { progress: number; error: boolean }) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const mountedRef = React.useRef(false)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (!mountedRef.current) {
      mountedRef.current = true
      gsap.set(el, { width: `${progress}%` })
      return
    }
    const tween = gsap.to(el, {
      width: `${progress}%`,
      duration: 0.3,
      ease: "power2.out",
      overwrite: "auto",
    })
    return () => {
      tween.kill()
    }
  }, [progress])
  return (
    <div
      ref={ref}
      className={cn(
        "h-full rounded-full will-change-[width]",
        error ? "bg-destructive" : "bg-primary"
      )}
    />
  )
}
