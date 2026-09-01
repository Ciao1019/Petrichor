import {
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  PointerSensor,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import * as React from "react"
import { toast } from "sonner"

import { knowledgeBaseNodeApi, type KnowledgeBaseTreeNode } from "@/lib/api"
import {
  resolveDropIntentKind,
  resolvePointerY,
  resolveSiblingTargetIndex,
  type DropIntent,
} from "./knowledge-tree-drop"
import {
  findTreeNode,
  getSiblingNodes,
  isDescendantInLoadedTree,
  parseFolderDropDndId,
  parseNodeDndId,
  resolveApiErrorMessage,
  SPRING_LOAD_EXPAND_DELAY_MS,
} from "./knowledge-base-tree-support"

interface UseKnowledgeBaseTreeDndOptions {
  knowledgeBaseId?: string
  roots: KnowledgeBaseTreeNode[]
  pageIndex: number
  pageSize: number
  disabled: boolean
  expandedIds: Set<string>
  fetchTree: () => Promise<void>
  loadChildren: (nodeId: string) => Promise<void>
  onExpandFolder: (nodeId: string) => void
}

export function useKnowledgeBaseTreeDnd({
  knowledgeBaseId,
  roots,
  pageIndex,
  pageSize,
  disabled,
  expandedIds,
  fetchTree,
  loadChildren,
  onExpandFolder,
}: UseKnowledgeBaseTreeDndOptions) {
  const [activeNodeId, setActiveNodeId] = React.useState<string | null>(null)
  const [dropIntent, setDropIntent] = React.useState<DropIntent | null>(null)
  const [movingNodeId, setMovingNodeId] = React.useState<string | null>(null)
  const rowElementsRef = React.useRef(new Map<string, HTMLDivElement>())
  const rowRefCallbacksRef = React.useRef(new Map<string, React.RefCallback<HTMLDivElement>>())
  const springLoadTimerRef = React.useRef<number | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const dragDisabled = disabled || Boolean(movingNodeId)

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

  const collisionDetection = React.useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args)
    if (pointerCollisions.length === 0) return closestCenter(args)
    const folderDropCollision = pointerCollisions.find((collision) => parseFolderDropDndId(collision.id))
    if (folderDropCollision) return [folderDropCollision]

    const pointerY = args.pointerCoordinates?.y
    if (pointerY != null) {
      const rowCollision = pointerCollisions.find((collision) => {
        const nodeId = parseNodeDndId(collision.id)
        if (!nodeId) return false
        const rect = rowElementsRef.current.get(nodeId)?.getBoundingClientRect()
        return !!rect && pointerY >= rect.top && pointerY <= rect.bottom
      })
      if (rowCollision) return [rowCollision]
    }
    return pointerCollisions
  }, [])

  const refreshAfterMove = React.useCallback(async (sourceParentId: string | null, targetParentId: string | null) => {
    const folderParentIds = new Set<string>()
    let refreshRoots = false
    if (sourceParentId && sourceParentId !== targetParentId) folderParentIds.add(sourceParentId)
    else if (!sourceParentId) refreshRoots = true
    if (targetParentId) onExpandFolder(targetParentId)
    else refreshRoots = true
    if (refreshRoots) await fetchTree()
    await Promise.all([...folderParentIds].map((parentId) => loadChildren(parentId)))
  }, [fetchTree, loadChildren, onExpandFolder])

  const computeDropIntent = React.useCallback((event: DragMoveEvent | DragEndEvent): DropIntent | null => {
    const draggedNodeId = parseNodeDndId(event.active.id)
    const overId = event.over?.id
    if (!draggedNodeId || !overId) return null
    const overFolderId = parseFolderDropDndId(overId)
    if (overFolderId) return { kind: "into", nodeId: overFolderId }

    const overNodeId = parseNodeDndId(overId)
    if (!overNodeId || overNodeId === draggedNodeId) return null
    const overNode = findTreeNode(roots, overNodeId)
    if (!overNode) return null
    const activeNode = findTreeNode(roots, draggedNodeId)
    const sourceParentId = activeNode?.parentId ?? null
    const canDropInto = overNode.type === "FOLDER" && overNode.id !== sourceParentId
      && !isDescendantInLoadedTree(roots, draggedNodeId, overNode.id)
    const rowRect = rowElementsRef.current.get(overNodeId)?.getBoundingClientRect()
    const pointerY = resolvePointerY(event.activatorEvent, event.delta)
    if (!rowRect || pointerY == null) return { kind: canDropInto ? "into" : "before", nodeId: overNodeId }
    return { kind: resolveDropIntentKind(pointerY, rowRect, canDropInto), nodeId: overNodeId }
  }, [roots])

  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    if (dragDisabled) return
    setActiveNodeId(parseNodeDndId(event.active.id))
    setDropIntent(null)
  }, [dragDisabled])

  const handleDragMove = React.useCallback((event: DragMoveEvent) => {
    const next = computeDropIntent(event)
    setDropIntent((current) => current?.kind === next?.kind && current?.nodeId === next?.nodeId ? current : next)
  }, [computeDropIntent])

  const handleDragEnd = React.useCallback(async (event: DragEndEvent) => {
    const draggedNodeId = parseNodeDndId(event.active.id)
    const intent = computeDropIntent(event)
    setActiveNodeId(null)
    setDropIntent(null)
    if (!knowledgeBaseId || dragDisabled || !draggedNodeId || !intent) return
    const activeNode = findTreeNode(roots, draggedNodeId)
    if (!activeNode) return

    const sourceParentId = activeNode.parentId ?? null
    let targetParentId: string | null
    let targetIndex: number | undefined
    if (intent.kind === "into") {
      if (intent.nodeId === sourceParentId) return
      targetParentId = intent.nodeId
    } else {
      const overNode = findTreeNode(roots, intent.nodeId)
      if (!overNode) return
      targetParentId = overNode.parentId ?? null
      const resolvedIndex = resolveSiblingTargetIndex({
        activeId: draggedNodeId,
        kind: intent.kind,
        overId: intent.nodeId,
        pageOffset: targetParentId == null ? pageIndex * pageSize : 0,
        sameParent: sourceParentId === targetParentId,
        siblingIds: getSiblingNodes(roots, targetParentId).map((node) => node.id),
      })
      if (resolvedIndex == null) return
      targetIndex = resolvedIndex
    }
    if (targetParentId === draggedNodeId || isDescendantInLoadedTree(roots, draggedNodeId, targetParentId)) {
      toast.error("不能移动到自身或子文件夹中")
      return
    }

    setMovingNodeId(draggedNodeId)
    try {
      await knowledgeBaseNodeApi.move({ knowledgeBaseId, nodeId: draggedNodeId, targetIndex, targetParentId })
      toast.success("位置已更新")
      await refreshAfterMove(sourceParentId, targetParentId)
    } catch (error: unknown) {
      toast.error(resolveApiErrorMessage(error, "移动失败"))
    } finally {
      setMovingNodeId(null)
    }
  }, [computeDropIntent, dragDisabled, knowledgeBaseId, pageIndex, pageSize, refreshAfterMove, roots])

  React.useEffect(() => {
    if (!activeNodeId || dropIntent?.kind !== "into") return
    const folderId = dropIntent.nodeId
    const folder = findTreeNode(roots, folderId)
    if (!folder || folder.type !== "FOLDER" || expandedIds.has(folderId)) return
    springLoadTimerRef.current = window.setTimeout(() => {
      springLoadTimerRef.current = null
      onExpandFolder(folderId)
    }, SPRING_LOAD_EXPAND_DELAY_MS)
    return () => {
      if (springLoadTimerRef.current != null) {
        window.clearTimeout(springLoadTimerRef.current)
        springLoadTimerRef.current = null
      }
    }
  }, [activeNodeId, dropIntent, expandedIds, onExpandFolder, roots])

  const resetDrag = React.useCallback(() => {
    setActiveNodeId(null)
    setDropIntent(null)
    setMovingNodeId(null)
  }, [])

  React.useEffect(() => resetDrag(), [knowledgeBaseId, resetDrag])

  return {
    activeDragNodeId: activeNodeId,
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
    setDropIntent,
  }
}
