import type { SiteGraphPayload, SiteGraphPayloadLink, SiteGraphPayloadNode } from "@/lib/api"

export interface RuntimeNode extends SiteGraphPayloadNode {
  degree: number
  neighbors: Set<string>
  radius: number
  labelElement: HTMLDivElement
  /** 递归布局给出的理想位置，聚簇力会把节点往这里拉。 */
  anchorX: number
  anchorY: number
  depth: number
  siblingIndex: number
  siblingCount: number
  x?: number
  y?: number
  vx?: number
  vy?: number
  fx?: number | null
  fy?: number | null
  index?: number
}

export interface RuntimeLink extends Omit<SiteGraphPayloadLink, "source" | "target"> {
  source: RuntimeNode
  target: RuntimeNode
}

export interface SiteGraphRuntime {
  start: () => void
  stop: () => void
  resize: () => void
  dispose: () => void
  setFocusNode: (nodeId: string | null) => void
  setPreviewNode: (nodeId: string | null) => void
  focusAndCenter: (nodeId: string) => void
  fit: () => void
  updateTheme: () => void
}

export interface SiteGraphRuntimeOptions {
  stage: HTMLElement
  mount: HTMLElement
  payload: SiteGraphPayload
  onHoverNode: (node: SiteGraphPayloadNode | null) => void
  onSelectNode: (node: SiteGraphPayloadNode | null) => void
  /** 画布上发生真实点击（已排除拖拽与平移）时触发。 */
  onCanvasClick?: () => void
  onNavigate: (route: string) => void
}
