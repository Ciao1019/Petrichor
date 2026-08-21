/**
 * 知识库树拖拽的落点判定。
 *
 * 抽成纯函数是为了让「悬停高亮」和「松手落库」共用同一套判断——两边各算一次
 * 曾经导致行亮了却没放进文件夹。同级排序的下标也在这里算，必须和后端
 * `moveNodeIdIntoSiblingOrder` 的语义对齐。
 */

export type DropIntentKind = "into" | "before" | "after"

/** 一次拖拽的落点意图：放进某个文件夹，或排到某个节点前/后。 */
export type DropIntent = {
  kind: DropIntentKind
  nodeId: string
}

/** 文件夹行上下各留这个比例做「排到前/后」，中间 60% 都算「放进去」。 */
export const FOLDER_DROP_EDGE_RATIO = 0.2

/**
 * 当前指针的视口 Y。
 * dnd-kit 不直接给指针坐标，但「按下时的坐标 + 累计位移」等价，且与 pointerWithin
 * 的碰撞判定用的是同一个点——用被拖元素的矩形中心会和碰撞结果对不上。
 */
export function resolvePointerY(
  activatorEvent: Event | null,
  delta: { y: number },
): number | null {
  const clientY = (activatorEvent as PointerEvent | null)?.clientY
  return typeof clientY === "number" && Number.isFinite(clientY) ? clientY + delta.y : null
}

/** 按指针落在行内的相对位置决定落点意图。 */
export function resolveDropIntentKind(
  pointerY: number,
  rowRect: { height: number; top: number },
  canDropInto: boolean,
): DropIntentKind {
  if (rowRect.height <= 0) {
    return canDropInto ? "into" : "before"
  }

  const ratio = (pointerY - rowRect.top) / rowRect.height
  if (!canDropInto) {
    return ratio < 0.5 ? "before" : "after"
  }
  if (ratio < FOLDER_DROP_EDGE_RATIO) return "before"
  if (ratio > 1 - FOLDER_DROP_EDGE_RATIO) return "after"
  return "into"
}

/**
 * 同级排序的落库下标。
 *
 * 后端会先把被移动节点从同级列表里摘掉，再按 targetIndex 插入，所以下标必须按
 * 「摘掉之后」的列表来算。返回 null 表示位置没变，不用发请求。
 *
 * pageOffset 用于根级列表——前端只持有当前页，后端拿到的是完整列表。
 */
export function resolveSiblingTargetIndex(params: {
  activeId: string
  kind: "before" | "after"
  overId: string
  pageOffset: number
  sameParent: boolean
  siblingIds: string[]
}): number | null {
  const { activeId, kind, overId, pageOffset, sameParent, siblingIds } = params

  const withoutActive = siblingIds.filter((id) => id !== activeId)
  const overIndex = withoutActive.indexOf(overId)
  if (overIndex < 0) {
    return null
  }

  const localIndex = kind === "after" ? overIndex + 1 : overIndex
  if (sameParent && siblingIds.indexOf(activeId) === localIndex) {
    return null
  }

  return pageOffset + localIndex
}
