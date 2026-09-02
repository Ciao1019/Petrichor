import { Loader2 } from "@/components/iconimate"
import { useReducedMotion } from "motion/react"
import * as React from "react"
import type { DateRange } from "react-day-picker"
import { useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"

import { FileIcon } from "@/components/kibo-ui/tree/file-icon"
import { ButtonDelete } from "@/components/ruixen/button-delete"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { ListItem } from "@/components/uitripled/native-nested-list-shadcnui"
import { rememberKnowledgeBase } from "@/features/pages/knowledge/kb-recent"
import {
  buildArticleKnowledgeAndWait,
  knowledgeBaseApi,
  knowledgeBaseArticleApi,
  knowledgeBaseNodeApi,
  type ArticleKnowledgeBuildProgress,
  type KnowledgeBaseResponse,
  type KnowledgeBaseTreeNode,
} from "@/lib/api"
import { knowledgeBaseArticlePath } from "@/lib/dashboard-routes"
import { cn } from "@/lib/utils"
import type { CreateArticleTarget } from "./knowledge-base-tree-create-article-dialog"
import { KnowledgeBaseTreePageView } from "./knowledge-base-tree-page-view"
import {
  ArticleStatusBadges,
  collectVisibleNodeDndIds,
  findTreeNode,
  formatDateYmd,
  KnowledgeBaseBuildButton,
  KnowledgeBaseDragHandle,
  KnowledgeBaseFolderDropTarget,
  KnowledgeBaseFolderTreeIcon,
  isDescendantInLoadedTree,
  resolveApiErrorMessage,
  SortableKnowledgeBaseTreeNode,
  treeContainsNode,
  updateNodeChildren,
  type DeleteTarget,
  type KnowledgeBaseView,
} from "./knowledge-base-tree-support"
import { useKnowledgeBaseTreeDnd } from "./use-knowledge-base-tree-dnd"

/**
 * 文章节点状态：用 StatusDot 降噪，悬停看含义，避免彩色胶囊墙抢标题注意力。
 */
export function KnowledgeBaseTreePage() {
  const { knowledgeBaseId } = useParams()
  const navigate = useNavigate()

  const [knowledgeBase, setKnowledgeBase] = React.useState<KnowledgeBaseResponse | null>(null)
  const [roots, setRoots] = React.useState<KnowledgeBaseTreeNode[]>([])
  const [totalRootNodes, setTotalRootNodes] = React.useState(0)
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
  const [createArticleTarget, setCreateArticleTarget] = React.useState<CreateArticleTarget | null>(null)
  const [importDialogOpen, setImportDialogOpen] = React.useState(false)
  const [activeView, setActiveView] = React.useState<KnowledgeBaseView>("documents")
  // 从 Wiki 图谱双击节点跳到知识空间时带过去的落点；知识空间挂载后消费一次
  const [wikiFocusPageKey, setWikiFocusPageKey] = React.useState<string | null>(null)
  const openWikiPageFromGraph = React.useCallback((pageKey: string) => {
    setWikiFocusPageKey(pageKey)
    setActiveView("knowledge")
  }, [])
  const prefersReducedMotion = useReducedMotion()
  const [buildingArticleIds, setBuildingArticleIds] = React.useState<Set<string>>(new Set())
  const [buildProgressByArticleId, setBuildProgressByArticleId] = React.useState<
    Record<string, ArticleKnowledgeBuildProgress>
  >({})
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deleteTarget, setDeleteTarget] = React.useState<DeleteTarget | null>(null)
  // 行元素本体（不含展开的子树），命中测试要按行高算，sortable 包裹层的矩形是整棵子树。

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
  const totalPages = Math.max(1, Math.ceil(totalRootNodes / pageSize))
  const isSearching = debouncedKeyword.length > 0 || hasArticleCreatedDateFilter
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
    setCreateArticleTarget(null)
    setImportDialogOpen(false)
    setActiveView("documents")
    setBuildingArticleIds(new Set())
    setBuildProgressByArticleId({})
    setDeleteOpen(false)
    setDeleteTarget(null)
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
      setTotalRootNodes(res.data.totalRootNodes ?? 0)
    } catch {
      setRoots([])
      setTotalRootNodes(0)
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
    setBuildProgressByArticleId((current) => ({
      ...current,
      [articleId]: {
        percent: 0,
        phase: "queued",
        message: "正在提交知识构建任务",
        updatedAt: new Date().toISOString(),
      },
    }))
    try {
      const result = await buildArticleKnowledgeAndWait({
        knowledgeBaseId,
        articleId,
      }, {
        onProgress: (progress) => {
          setBuildProgressByArticleId((current) => ({ ...current, [articleId]: progress }))
        },
      })
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

  const openCreateArticle = React.useCallback((parent: CreateArticleTarget | null) => {
    setCreateArticleTarget(parent)
    setCreateArticleOpen(true)
  }, [])

  const refreshTreeAfterCreateArticle = React.useCallback(async (parentId: string | null) => {
    if (isSearching) {
      await fetchTree()
    } else if (parentId && treeContainsNode(roots, parentId)) {
      setExpandedIds((prev) => {
        const next = new Set(prev)
        next.add(parentId)
        return next
      })
      await loadChildren(parentId)
    } else {
      await fetchTree()
    }
  }, [fetchTree, isSearching, loadChildren, roots])

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

  const handleTreeExpandedChange = React.useCallback((id: string, nextExpanded: boolean) => {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (nextExpanded) next.add(id)
      else next.delete(id)
      return next
    })
    if (nextExpanded && !isSearching) void loadChildren(id)
  }, [isSearching, loadChildren])

  const expandFolderForDrop = React.useCallback(
    (nodeId: string) => handleTreeExpandedChange(nodeId, true),
    [handleTreeExpandedChange],
  )
  const {
    activeDragNodeId,
    collisionDetection,
    dragDisabled,
    dropIntent,
    getRowRef,
    handleDragEnd,
    handleDragMove,
    handleDragStart,
    movingNodeId,
    resetDrag,
    sensors,
  } = useKnowledgeBaseTreeDnd({
    knowledgeBaseId,
    roots,
    pageIndex,
    pageSize,
    disabled: isSearching || loading || saving,
    expandedIds,
    fetchTree,
    loadChildren,
    onExpandFolder: expandFolderForDrop,
  })
  const visibleNodeDndIds = React.useMemo(
    () => collectVisibleNodeDndIds(roots, expandedIds),
    [expandedIds, roots],
  )
  const activeDragNode = React.useMemo(
    () => activeDragNodeId ? findTreeNode(roots, activeDragNodeId) : null,
    [activeDragNodeId, roots],
  )

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
              progress={buildProgressByArticleId[node.articleId]?.percent}
              progressMessage={buildProgressByArticleId[node.articleId]?.message}
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
            <button
              type="button"
              className="cursor-pointer text-destructive hover:underline"
              onClick={(e) => {
                e.stopPropagation()
                void loadChildren(node.id)
              }}
            >
              加载失败，点击重试
            </button>
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
  }, [activeDragNode, activeDragNodeId, buildArticleKnowledge, buildProgressByArticleId, buildingArticleIds, dragDisabled, dropIntent, expandedIds, getRowRef, knowledgeBaseId, loadChildren, movingNodeId, navigate, nodeLoadErrorById, nodeLoadingById, roots])

  const treeItems = React.useMemo(() => roots.map(buildTreeItem), [buildTreeItem, roots])

  const handlePageChange = React.useCallback(
    (nextPageIndex: number) => {
      if (nextPageIndex < 0 || nextPageIndex >= totalPages) return
      setPageIndex(nextPageIndex)
    },
    [totalPages],
  )

  return (
    <KnowledgeBaseTreePageView
      {...{
        knowledgeBaseId, navigate, knowledgeBase, activeView, setActiveView, wikiFocusPageKey,
        setWikiFocusPageKey, openWikiPageFromGraph, prefersReducedMotion, loading, saving, roots,
        keyword, setKeyword, debouncedKeyword, pageIndex, setPageIndex, pageSize, totalPages,
        totalRootNodes, articleCreatedDateRange, setArticleCreatedDateRange, articleCreatedDateDraftRange,
        setArticleCreatedDateDraftRange, articleCreatedDateOpen, setArticleCreatedDateOpen,
        articleCreatedDateLabel, hasArticleCreatedDateFilter, openCreateFolder, openCreateArticle,
        setImportDialogOpen, importDialogOpen, sensors, collisionDetection, handleDragStart,
        handleDragMove, handleDragEnd, resetDrag, visibleNodeDndIds, treeItems, expandedIds,
        handleTreeExpandedChange, activeDragNode, handlePageChange, createFolderOpen,
        setCreateFolderOpen, createFolderParentId, createFolderParentName, createFolderName,
        setCreateFolderName, submitCreateFolder, createArticleOpen, createArticleTarget,
        setCreateArticleOpen, setSaving, refreshTreeAfterCreateArticle, deleteOpen, setDeleteOpen,
        deleteTarget, confirmDelete,
      }}
    />
  )
}
