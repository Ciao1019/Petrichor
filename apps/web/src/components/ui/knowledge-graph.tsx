"use client"

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react"
import { Minus, Plus, Download, Maximize, ScanSearch, Loader2 } from "lucide-react"
import type { MindElixirData } from "mind-elixir"
import { cn } from "@/lib/utils"

/* ───────────────────────── Types ───────────────────────── */

interface GNode {
  id: string
  topic: string
  level: number
  parentId: string | null
  color: string
  radius: number
  x: number
  y: number
  vx: number
  vy: number
  fx: number | null
  fy: number | null
}

interface GEdge {
  source: string
  target: string
  type: "hierarchy" | "crosslink"
  label?: string
  color?: string
  dashed?: boolean
}

interface ResolvedEdge {
  source: GNode
  target: GNode
  type: "hierarchy" | "crosslink"
  label?: string
  color?: string
  dashed?: boolean
}

interface Transform {
  x: number
  y: number
  k: number
}

/* ───────────────────────── Constants ───────────────────────── */

const LIGHT_PALETTE = ["#3b82f6", "#10b981", "#8b5cf6", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899", "#84cc16"]
const DARK_PALETTE = ["#60a5fa", "#34d399", "#a78bfa", "#fbbf24", "#f87171", "#22d3ee", "#f472b6", "#a3e635"]
const RADIUS = [34, 24, 19, 15, 13]
const FONT_SIZE = [14, 12, 11, 10, 10]
const FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"

const THEME_COLORS = {
  light: { bg: "#ffffff", fg: "#171717", muted: "#a3a3a3", border: "#e5e5e5", card: "#f5f5f5", rootBg: "#1c1c1c", rootFg: "#fafafa" },
  dark: { bg: "#0f0f0f", fg: "#fafafa", muted: "#737373", border: "#2a2a2a", card: "#1c1c1c", rootBg: "#e5e5e5", rootFg: "#171717" },
}

/* ── Physics ── */
const ALPHA_INITIAL = 1
const ALPHA_MIN = 0.001
const ALPHA_DECAY = 0.0228
const VELOCITY_DECAY = 0.4
const REPULSION = -450
const CENTER_GRAVITY = 0.03
const COLLISION_PAD = 14
const LINK_DIST = [180, 135, 105, 85]
const LINK_STRENGTH = 0.07

/* ───────────────────────── Theme detection ───────────────────────── */

function detectDark(): boolean {
  if (typeof document === "undefined") return false
  if (document.documentElement.classList.contains("dark")) return true
  if (document.documentElement.classList.contains("light")) return false
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
}

/* ───────────────────────── Data parsing ───────────────────────── */

function parseGraphData(data: MindElixirData, dark: boolean) {
  const nodes: GNode[] = []
  const edges: GEdge[] = []
  const palette = dark ? DARK_PALETTE : LIGHT_PALETTE
  let colorIdx = 0

  function walk(node: any, level: number, parentId: string | null, branch: string | null) {
    const id: string = node.id || `n_${nodes.length}`
    let color: string
    if (level === 0) {
      color = dark ? THEME_COLORS.dark.rootBg : THEME_COLORS.light.rootBg
    } else if (branch) {
      color = branch
    } else if (node.branchColor) {
      color = node.branchColor
    } else {
      color = palette[colorIdx++ % palette.length]
    }

    const r = RADIUS[Math.min(level, RADIUS.length - 1)]
    nodes.push({ id, topic: node.topic || "", level, parentId, color, radius: r, x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null })

    if (parentId) {
      edges.push({ source: parentId, target: id, type: "hierarchy" })
    }

    const nextBranch = level === 0 ? null : (branch || node.branchColor || color)
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        const cb = level === 0 ? (child.branchColor || null) : nextBranch
        walk(child, level + 1, id, cb)
      }
    }
  }

  if (data.nodeData) walk(data.nodeData, 0, null, null)

  const nodeIds = new Set(nodes.map((n) => n.id))
  const arrows = (data as any).arrows
  if (Array.isArray(arrows)) {
    for (const a of arrows) {
      if (a.from && a.to && nodeIds.has(a.from) && nodeIds.has(a.to)) {
        edges.push({
          source: a.from,
          target: a.to,
          type: "crosslink",
          label: a.label || "",
          color: a.style?.stroke || (dark ? "#60a5fa" : "#3b82f6"),
          dashed: true,
        })
      }
    }
  }

  return { nodes, edges }
}

/* ───────────────────────── Force simulation ───────────────────────── */

function resolveEdges(nodes: GNode[], edges: GEdge[]): ResolvedEdge[] {
  const map = new Map(nodes.map((n) => [n.id, n]))
  return edges
    .map((e) => ({ ...e, source: map.get(e.source)!, target: map.get(e.target)! }))
    .filter((e) => e.source && e.target)
}

function buildAdjacency(nodes: GNode[], resolved: ResolvedEdge[]) {
  const adj = new Map<string, Set<string>>()
  for (const n of nodes) adj.set(n.id, new Set())
  for (const e of resolved) {
    adj.get(e.source.id)!.add(e.target.id)
    adj.get(e.target.id)!.add(e.source.id)
  }
  return adj
}

function initPositions(nodes: GNode[]) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n.level === 0) {
      n.x = 0; n.y = 0
    } else {
      const angle = (2 * Math.PI * i) / nodes.length + (Math.random() - 0.5) * 0.6
      const r = 20 + Math.random() * 40
      n.x = Math.cos(angle) * r
      n.y = Math.sin(angle) * r
    }
    n.vx = 0; n.vy = 0
  }
}

function runSimulation(nodes: GNode[], resolved: ResolvedEdge[], iterations: number) {
  let alpha = ALPHA_INITIAL

  for (let iter = 0; iter < iterations; iter++) {
    if (alpha < ALPHA_MIN) break

    // Repulsion (many-body)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j]
        let dx = b.x - a.x, dy = b.y - a.y
        const dist2 = dx * dx + dy * dy || 1
        const dist = Math.sqrt(dist2)
        const f = REPULSION * alpha / dist2
        const fx = (dx / dist) * f
        const fy = (dy / dist) * f
        a.vx -= fx; a.vy -= fy
        b.vx += fx; b.vy += fy
      }
    }

    // Link attraction
    for (const e of resolved) {
      const s = e.source, t = e.target
      let dx = t.x - s.x, dy = t.y - s.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const ideal = LINK_DIST[Math.min(s.level, LINK_DIST.length - 1)]
      const f = (dist - ideal) * LINK_STRENGTH * alpha
      const fx = (dx / dist) * f
      const fy = (dy / dist) * f
      s.vx += fx; s.vy += fy
      t.vx -= fx; t.vy -= fy
    }

    // Center gravity
    for (const n of nodes) {
      n.vx -= n.x * CENTER_GRAVITY * alpha
      n.vy -= n.y * CENTER_GRAVITY * alpha
    }

    // Collision
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j]
        let dx = b.x - a.x, dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const minDist = a.radius + b.radius + COLLISION_PAD
        if (dist < minDist) {
          const push = (minDist - dist) * 0.5
          const fx = (dx / dist) * push
          const fy = (dy / dist) * push
          a.vx -= fx; a.vy -= fy
          b.vx += fx; b.vy += fy
        }
      }
    }

    // Integrate
    for (const n of nodes) {
      if (n.fx != null) { n.x = n.fx; n.vx = 0 } else { n.vx *= VELOCITY_DECAY; n.x += n.vx }
      if (n.fy != null) { n.y = n.fy; n.vy = 0 } else { n.vy *= VELOCITY_DECAY; n.y += n.vy }
    }

    alpha *= (1 - ALPHA_DECAY)
  }
}

/* Incremental tick for drag interactions */
function tickOnce(nodes: GNode[], resolved: ResolvedEdge[], alpha: number): number {
  if (alpha < ALPHA_MIN) return alpha

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j]
      let dx = b.x - a.x, dy = b.y - a.y
      const dist2 = dx * dx + dy * dy || 1
      const dist = Math.sqrt(dist2)
      const f = REPULSION * alpha / dist2
      const fx = (dx / dist) * f, fy = (dy / dist) * f
      a.vx -= fx; a.vy -= fy
      b.vx += fx; b.vy += fy
    }
  }

  for (const e of resolved) {
    const s = e.source, t = e.target
    let dx = t.x - s.x, dy = t.y - s.y
    const dist = Math.sqrt(dx * dx + dy * dy) || 1
    const ideal = LINK_DIST[Math.min(s.level, LINK_DIST.length - 1)]
    const f = (dist - ideal) * LINK_STRENGTH * alpha
    const fx = (dx / dist) * f, fy = (dy / dist) * f
    s.vx += fx; s.vy += fy; t.vx -= fx; t.vy -= fy
  }

  for (const n of nodes) {
    n.vx -= n.x * CENTER_GRAVITY * alpha
    n.vy -= n.y * CENTER_GRAVITY * alpha
  }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j]
      let dx = b.x - a.x, dy = b.y - a.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const minDist = a.radius + b.radius + COLLISION_PAD
      if (dist < minDist) {
        const push = (minDist - dist) * 0.5
        const fx = (dx / dist) * push, fy = (dy / dist) * push
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy
      }
    }
  }

  for (const n of nodes) {
    if (n.fx != null) { n.x = n.fx; n.vx = 0 } else { n.vx *= VELOCITY_DECAY; n.x += n.vx }
    if (n.fy != null) { n.y = n.fy; n.vy = 0 } else { n.vy *= VELOCITY_DECAY; n.y += n.vy }
  }

  return alpha * (1 - ALPHA_DECAY)
}

/* ───────────────────────── Drawing utilities ───────────────────────── */

function lightenHex(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const nr = Math.min(255, Math.round(r + (255 - r) * amount))
  const ng = Math.min(255, Math.round(g + (255 - g) * amount))
  const nb = Math.min(255, Math.round(b + (255 - b) * amount))
  return `#${nr.toString(16).padStart(2, "0")}${ng.toString(16).padStart(2, "0")}${nb.toString(16).padStart(2, "0")}`
}

function darkenHex(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const nr = Math.max(0, Math.round(r * (1 - amount)))
  const ng = Math.max(0, Math.round(g * (1 - amount)))
  const nb = Math.max(0, Math.round(b * (1 - amount)))
  return `#${nr.toString(16).padStart(2, "0")}${ng.toString(16).padStart(2, "0")}${nb.toString(16).padStart(2, "0")}`
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let t = text
  while (t.length > 1) {
    t = t.slice(0, -1)
    if (ctx.measureText(t + "…").width <= maxWidth) return t + "…"
  }
  return "…"
}

function fitToView(nodes: GNode[], width: number, height: number, padding = 80): Transform {
  if (nodes.length === 0) return { x: width / 2, y: height / 2, k: 1 }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.radius - 40)
    maxX = Math.max(maxX, n.x + n.radius + 40)
    minY = Math.min(minY, n.y - n.radius - 30)
    maxY = Math.max(maxY, n.y + n.radius + 30)
  }
  const gw = maxX - minX || 1
  const gh = maxY - minY || 1
  const k = Math.min((width - padding * 2) / gw, (height - padding * 2) / gh, 2)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return { x: width / 2 - cx * k, y: height / 2 - cy * k, k }
}

/* ───────────────────────── Main draw ───────────────────────── */

function drawGraph(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  nodes: GNode[],
  resolved: ResolvedEdge[],
  transform: Transform,
  hovered: GNode | null,
  adj: Map<string, Set<string>>,
  dark: boolean,
) {
  const dpr = window.devicePixelRatio || 1
  const tc = dark ? THEME_COLORS.dark : THEME_COLORS.light

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  // Background
  ctx.fillStyle = tc.bg
  ctx.fillRect(0, 0, w, h)

  // Background dot grid
  ctx.save()
  ctx.translate(transform.x, transform.y)
  ctx.scale(transform.k, transform.k)

  const gridSize = 30
  const startX = Math.floor((-transform.x / transform.k - 200) / gridSize) * gridSize
  const endX = Math.ceil(((-transform.x + w) / transform.k + 200) / gridSize) * gridSize
  const startY = Math.floor((-transform.y / transform.k - 200) / gridSize) * gridSize
  const endY = Math.ceil(((-transform.y + h) / transform.k + 200) / gridSize) * gridSize

  ctx.fillStyle = dark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)"
  for (let gx = startX; gx <= endX; gx += gridSize) {
    for (let gy = startY; gy <= endY; gy += gridSize) {
      ctx.beginPath()
      ctx.arc(gx, gy, 1, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // Connected set for hover highlight
  const connected = new Set<string>()
  if (hovered) {
    connected.add(hovered.id)
    const neighbors = adj.get(hovered.id)
    if (neighbors) for (const nid of neighbors) connected.add(nid)
  }

  // Draw hierarchy edges
  for (const e of resolved) {
    if (e.type !== "hierarchy") continue
    const s = e.source, t = e.target
    const dimmed = hovered && !connected.has(s.id) && !connected.has(t.id)
    const highlighted = hovered && connected.has(s.id) && connected.has(t.id)

    ctx.beginPath()
    ctx.moveTo(s.x, s.y)
    ctx.lineTo(t.x, t.y)

    if (highlighted) {
      // Gradient edge
      const grad = ctx.createLinearGradient(s.x, s.y, t.x, t.y)
      grad.addColorStop(0, s.color + "99")
      grad.addColorStop(1, t.color + "99")
      ctx.strokeStyle = grad
      ctx.lineWidth = 2
      ctx.globalAlpha = 1
    } else {
      ctx.strokeStyle = dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)"
      ctx.lineWidth = 1
      ctx.globalAlpha = dimmed ? 0.15 : 1
    }

    ctx.setLineDash([])
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // Draw crosslink edges
  for (const e of resolved) {
    if (e.type !== "crosslink") continue
    const s = e.source, t = e.target
    const dimmed = hovered && !connected.has(s.id) && !connected.has(t.id)

    const dx = t.x - s.x, dy = t.y - s.y
    const dist = Math.sqrt(dx * dx + dy * dy) || 1
    // Perpendicular offset for curve
    const nx = -dy / dist, ny = dx / dist
    const curvature = Math.min(dist * 0.2, 60)
    const cpx = (s.x + t.x) / 2 + nx * curvature
    const cpy = (s.y + t.y) / 2 + ny * curvature

    // Clamp to circle edges
    const sAngle = Math.atan2(cpy - s.y, cpx - s.x)
    const tAngle = Math.atan2(cpy - t.y, cpx - t.x)
    const sx = s.x + Math.cos(sAngle) * s.radius
    const sy = s.y + Math.sin(sAngle) * s.radius
    const tx = t.x + Math.cos(tAngle) * t.radius
    const ty = t.y + Math.sin(tAngle) * t.radius

    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.quadraticCurveTo(cpx, cpy, tx, ty)
    ctx.strokeStyle = e.color || (dark ? "#60a5fa" : "#3b82f6")
    ctx.lineWidth = 1.5
    ctx.globalAlpha = dimmed ? 0.1 : 0.7
    ctx.setLineDash([6, 4])
    ctx.stroke()
    ctx.setLineDash([])

    // Arrow head
    const arrowSize = 7
    const angle = Math.atan2(t.y - cpy, t.x - cpx)
    ctx.beginPath()
    ctx.moveTo(tx, ty)
    ctx.lineTo(tx - Math.cos(angle - 0.4) * arrowSize, ty - Math.sin(angle - 0.4) * arrowSize)
    ctx.lineTo(tx - Math.cos(angle + 0.4) * arrowSize, ty - Math.sin(angle + 0.4) * arrowSize)
    ctx.closePath()
    ctx.fillStyle = e.color || (dark ? "#60a5fa" : "#3b82f6")
    ctx.fill()

    // Label
    if (e.label) {
      const lx = (sx + tx) / 2 + nx * curvature * 0.5
      const ly = (sy + ty) / 2 + ny * curvature * 0.5
      ctx.font = `10px ${FONT}`
      const tw = ctx.measureText(e.label).width
      const ph = 6, pv = 3

      ctx.fillStyle = dark ? "rgba(15,15,15,0.85)" : "rgba(255,255,255,0.85)"
      ctx.beginPath()
      ctx.roundRect(lx - tw / 2 - ph, ly - 6 - pv, tw + ph * 2, 12 + pv * 2, 4)
      ctx.fill()

      ctx.strokeStyle = dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)"
      ctx.lineWidth = 0.5
      ctx.stroke()

      ctx.fillStyle = e.color || (dark ? "#60a5fa" : "#3b82f6")
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText(e.label, lx, ly)
    }

    ctx.globalAlpha = 1
  }

  // Draw nodes
  for (const n of nodes) {
    const dimmed = hovered && !connected.has(n.id)
    const isHovered = hovered?.id === n.id
    const isRoot = n.level === 0

    ctx.globalAlpha = dimmed ? 0.15 : 1

    // Glow for hovered
    if (isHovered) {
      ctx.save()
      ctx.shadowColor = n.color + "88"
      ctx.shadowBlur = 20
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.radius + 3, 0, Math.PI * 2)
      ctx.fillStyle = n.color
      ctx.fill()
      ctx.restore()
    }

    // Node circle with gradient
    const grad = ctx.createRadialGradient(
      n.x - n.radius * 0.25, n.y - n.radius * 0.25, n.radius * 0.1,
      n.x, n.y, n.radius,
    )
    if (isRoot) {
      grad.addColorStop(0, dark ? "#ffffff" : "#404040")
      grad.addColorStop(1, n.color)
    } else {
      grad.addColorStop(0, lightenHex(n.color, 0.25))
      grad.addColorStop(1, n.color)
    }

    ctx.beginPath()
    ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2)
    ctx.fillStyle = grad
    ctx.fill()

    // Border
    ctx.strokeStyle = isHovered ? (dark ? "#ffffff" : "#000000") : darkenHex(n.color, 0.15) + "60"
    ctx.lineWidth = isHovered ? 2.5 : 1.5
    ctx.stroke()

    // Label
    const fontSize = FONT_SIZE[Math.min(n.level, FONT_SIZE.length - 1)]
    const fontWeight = n.level <= 1 ? "600" : "400"
    ctx.font = `${fontWeight} ${fontSize}px ${FONT}`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"

    if (n.level <= 1) {
      // Text inside node
      const maxW = n.radius * 1.6
      const label = truncateText(ctx, n.topic, maxW)
      ctx.fillStyle = isRoot ? (dark ? tc.rootFg : tc.rootFg) : "#ffffff"
      ctx.fillText(label, n.x, n.y)
    } else {
      // Text below node
      const label = truncateText(ctx, n.topic, 100)
      ctx.fillStyle = dimmed ? (dark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.15)") : tc.fg
      ctx.fillText(label, n.x, n.y + n.radius + fontSize + 2)
    }

    ctx.globalAlpha = 1
  }

  ctx.restore()

  // Tooltip (screen space)
  if (hovered) {
    const sx = hovered.x * transform.k + transform.x
    const sy = hovered.y * transform.k + transform.y - hovered.radius * transform.k - 14

    ctx.font = `500 12px ${FONT}`
    const tw = ctx.measureText(hovered.topic).width
    const ph = 10, pv = 6
    const bw = tw + ph * 2
    const bh = 20 + pv * 2

    // Clamp to viewport
    const tx = Math.max(ph, Math.min(w - bw - ph, sx - bw / 2))
    const ty = Math.max(pv, sy - bh - 4)

    ctx.fillStyle = dark ? "rgba(28,28,28,0.95)" : "rgba(255,255,255,0.96)"
    ctx.beginPath()
    ctx.roundRect(tx, ty, bw, bh, 6)
    ctx.fill()

    ctx.strokeStyle = dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)"
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.fillStyle = tc.fg
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(hovered.topic, tx + bw / 2, ty + bh / 2)
  }
}

/* ───────────────────────── Context ───────────────────────── */

interface KnowledgeGraphContextValue {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  transformRef: React.MutableRefObject<Transform>
  nodesRef: React.MutableRefObject<GNode[]>
  requestRender: () => void
  isLoaded: boolean
}

const KnowledgeGraphContext = createContext<KnowledgeGraphContextValue | null>(null)

function useKnowledgeGraph() {
  const ctx = useContext(KnowledgeGraphContext)
  if (!ctx) throw new Error("useKnowledgeGraph must be used within KnowledgeGraph")
  return ctx
}

/* ───────────────────────── Main component ───────────────────────── */

interface KnowledgeGraphProps {
  data: MindElixirData
  className?: string
  children?: ReactNode
}

export function KnowledgeGraph({ data, className, children }: KnowledgeGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isLoaded, setIsLoaded] = useState(false)
  const [dark, setDark] = useState(detectDark)

  // Graph state refs (not React state, for performance)
  const nodesRef = useRef<GNode[]>([])
  const resolvedRef = useRef<ResolvedEdge[]>([])
  const adjRef = useRef<Map<string, Set<string>>>(new Map())
  const transformRef = useRef<Transform>({ x: 0, y: 0, k: 1 })
  const hoveredRef = useRef<GNode | null>(null)
  const sizeRef = useRef({ w: 0, h: 0 })

  // Animation state
  const animFrameRef = useRef(0)
  const simAlphaRef = useRef(0)
  const entryAnimRef = useRef(0)
  const isDraggingRef = useRef(false)
  const dragNodeRef = useRef<GNode | null>(null)
  const isPanningRef = useRef(false)
  const panStartRef = useRef({ mx: 0, my: 0, tx: 0, ty: 0 })

  // Render function
  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const { w, h } = sizeRef.current
    if (w === 0 || h === 0) return
    drawGraph(ctx, w, h, nodesRef.current, resolvedRef.current, transformRef.current, hoveredRef.current, adjRef.current, dark)
  }, [dark])

  const requestRender = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current)
    animFrameRef.current = requestAnimationFrame(render)
  }, [render])

  // Simulation animation loop (for drag reheat)
  const startSimLoop = useCallback(() => {
    function loop() {
      if (simAlphaRef.current < ALPHA_MIN && !isDraggingRef.current) {
        requestRender()
        return
      }
      simAlphaRef.current = tickOnce(nodesRef.current, resolvedRef.current, simAlphaRef.current)
      requestRender()
      animFrameRef.current = requestAnimationFrame(loop)
    }
    cancelAnimationFrame(animFrameRef.current)
    animFrameRef.current = requestAnimationFrame(loop)
  }, [requestRender])

  // Resize canvas
  const resizeCanvas = useCallback(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const rect = container.getBoundingClientRect()
    const w = rect.width, h = rect.height
    if (w === 0 || h === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    sizeRef.current = { w, h }
    return { w, h }
  }, [])

  // Initialize graph from data
  useEffect(() => {
    if (!data?.nodeData) return

    const { nodes, edges } = parseGraphData(data, dark)
    const resolved = resolveEdges(nodes, edges)
    const adj = buildAdjacency(nodes, resolved)

    initPositions(nodes)
    runSimulation(nodes, resolved, 300)

    nodesRef.current = nodes
    resolvedRef.current = resolved
    adjRef.current = adj
    simAlphaRef.current = 0
    hoveredRef.current = null

    // Save final positions
    const finalPos = nodes.map((n) => ({ x: n.x, y: n.y }))

    // Reset to center for entry animation
    for (const n of nodes) { n.x = 0; n.y = 0 }

    const size = resizeCanvas()
    if (size) {
      const targetTransform = fitToView(
        nodes.map((n, i) => ({ ...n, x: finalPos[i].x, y: finalPos[i].y })),
        size.w,
        size.h,
      )
      transformRef.current = targetTransform
    }

    // Entry animation
    setIsLoaded(true)
    const duration = 900
    const start = performance.now()
    cancelAnimationFrame(entryAnimRef.current)

    function animateEntry() {
      const elapsed = performance.now() - start
      const t = Math.min(1, elapsed / duration)
      const ease = 1 - Math.pow(1 - t, 3) // easeOutCubic

      for (let i = 0; i < nodes.length; i++) {
        nodes[i].x = finalPos[i].x * ease
        nodes[i].y = finalPos[i].y * ease
      }

      requestRender()

      if (t < 1) {
        entryAnimRef.current = requestAnimationFrame(animateEntry)
      }
    }

    entryAnimRef.current = requestAnimationFrame(animateEntry)

    return () => {
      cancelAnimationFrame(entryAnimRef.current)
      cancelAnimationFrame(animFrameRef.current)
    }
  }, [data, dark, resizeCanvas, requestRender])

  // ResizeObserver
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(() => {
      const size = resizeCanvas()
      if (size && nodesRef.current.length > 0) {
        transformRef.current = fitToView(nodesRef.current, size.w, size.h)
        requestRender()
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [resizeCanvas, requestRender])

  // Theme observer
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(detectDark()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const handler = () => setDark(detectDark())
    mq.addEventListener("change", handler)
    return () => { observer.disconnect(); mq.removeEventListener("change", handler) }
  }, [])

  // Re-render on theme change
  useEffect(() => { requestRender() }, [dark, requestRender])

  // Hit test
  const nodeAtPoint = useCallback((screenX: number, screenY: number): GNode | null => {
    const tf = transformRef.current
    const gx = (screenX - tf.x) / tf.k
    const gy = (screenY - tf.y) / tf.k
    for (let i = nodesRef.current.length - 1; i >= 0; i--) {
      const n = nodesRef.current[i]
      const dx = gx - n.x, dy = gy - n.y
      if (dx * dx + dy * dy <= (n.radius + 4) * (n.radius + 4)) return n
    }
    return null
  }, [])

  // Wheel zoom
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const rect = canvasRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const tf = transformRef.current
    const gx = (mx - tf.x) / tf.k
    const gy = (my - tf.y) / tf.k
    const factor = e.deltaY > 0 ? 0.92 : 1.08
    const newK = Math.max(0.1, Math.min(5, tf.k * factor))
    transformRef.current = { x: mx - gx * newK, y: my - gy * newK, k: newK }
    requestRender()
  }, [requestRender])

  // Pointer events
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.setPointerCapture(e.pointerId)
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    const node = nodeAtPoint(mx, my)
    if (node) {
      isDraggingRef.current = true
      dragNodeRef.current = node
      node.fx = node.x
      node.fy = node.y
      simAlphaRef.current = 0.3
      startSimLoop()
    } else {
      isPanningRef.current = true
      panStartRef.current = { mx, my, tx: transformRef.current.x, ty: transformRef.current.y }
      canvas.style.cursor = "grabbing"
    }
  }, [nodeAtPoint, startSimLoop])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    if (isDraggingRef.current && dragNodeRef.current) {
      const tf = transformRef.current
      dragNodeRef.current.fx = (mx - tf.x) / tf.k
      dragNodeRef.current.fy = (my - tf.y) / tf.k
      simAlphaRef.current = Math.max(simAlphaRef.current, 0.1)
      return
    }

    if (isPanningRef.current) {
      const ps = panStartRef.current
      transformRef.current = { ...transformRef.current, x: ps.tx + (mx - ps.mx), y: ps.ty + (my - ps.my) }
      requestRender()
      return
    }

    // Hover detection
    const node = nodeAtPoint(mx, my)
    if (node !== hoveredRef.current) {
      hoveredRef.current = node
      canvas.style.cursor = node ? "pointer" : "grab"
      requestRender()
    }
  }, [nodeAtPoint, requestRender])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const canvas = canvasRef.current
    if (canvas) canvas.releasePointerCapture(e.pointerId)

    if (isDraggingRef.current && dragNodeRef.current) {
      dragNodeRef.current.fx = null
      dragNodeRef.current.fy = null
      dragNodeRef.current = null
      isDraggingRef.current = false
      simAlphaRef.current = 0.15
    }

    if (isPanningRef.current) {
      isPanningRef.current = false
      if (canvasRef.current) canvasRef.current.style.cursor = "grab"
    }
  }, [])

  const onPointerLeave = useCallback(() => {
    if (hoveredRef.current) {
      hoveredRef.current = null
      requestRender()
    }
  }, [requestRender])

  return (
    <KnowledgeGraphContext.Provider value={{ canvasRef, containerRef, transformRef, nodesRef, requestRender, isLoaded }}>
      <div ref={containerRef} className={cn("relative w-full h-full", className)}>
        <canvas
          ref={canvasRef}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
          className="w-full h-full"
          style={{ touchAction: "none", cursor: "grab" }}
        />
        {!isLoaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
          </div>
        )}
        {children}
      </div>
    </KnowledgeGraphContext.Provider>
  )
}

/* ───────────────────────── Controls ───────────────────────── */

interface KnowledgeGraphControlsProps {
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right"
  className?: string
}

export function KnowledgeGraphControls({ position = "top-right", className }: KnowledgeGraphControlsProps) {
  const { canvasRef, containerRef, transformRef, nodesRef, requestRender, isLoaded } = useKnowledgeGraph()
  const [mounted, setMounted] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 0)
    return () => clearTimeout(t)
  }, [])

  const handleZoomIn = useCallback(() => {
    const tf = transformRef.current
    const { w, h } = { w: canvasRef.current?.clientWidth || 0, h: canvasRef.current?.clientHeight || 0 }
    const cx = w / 2, cy = h / 2
    const gx = (cx - tf.x) / tf.k, gy = (cy - tf.y) / tf.k
    const newK = Math.min(5, tf.k * 1.3)
    transformRef.current = { x: cx - gx * newK, y: cy - gy * newK, k: newK }
    requestRender()
  }, [canvasRef, transformRef, requestRender])

  const handleZoomOut = useCallback(() => {
    const tf = transformRef.current
    const { w, h } = { w: canvasRef.current?.clientWidth || 0, h: canvasRef.current?.clientHeight || 0 }
    const cx = w / 2, cy = h / 2
    const gx = (cx - tf.x) / tf.k, gy = (cy - tf.y) / tf.k
    const newK = Math.max(0.1, tf.k * 0.77)
    transformRef.current = { x: cx - gx * newK, y: cy - gy * newK, k: newK }
    requestRender()
  }, [canvasRef, transformRef, requestRender])

  const handleFit = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const w = canvas.clientWidth, h = canvas.clientHeight
    transformRef.current = fitToView(nodesRef.current, w, h)
    requestRender()
  }, [canvasRef, nodesRef, transformRef, requestRender])

  const handleFullscreen = useCallback(() => {
    const container = containerRef.current?.parentElement
    if (!container) return
    if (!document.fullscreenElement) {
      container.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {})
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false))
    }
  }, [containerRef])

  useEffect(() => {
    const handler = () => {
      const isFull = !!document.fullscreenElement
      setIsFullscreen(isFull)
      if (!isFull) {
        setTimeout(() => {
          const canvas = canvasRef.current
          if (canvas && nodesRef.current.length > 0) {
            transformRef.current = fitToView(nodesRef.current, canvas.clientWidth, canvas.clientHeight)
            requestRender()
          }
        }, 100)
      }
    }
    document.addEventListener("fullscreenchange", handler)
    return () => document.removeEventListener("fullscreenchange", handler)
  }, [canvasRef, nodesRef, transformRef, requestRender])

  const handleExport = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = "knowledge-graph.png"
      a.click()
      URL.revokeObjectURL(url)
    }, "image/png")
  }, [canvasRef])

  if (!mounted || !isLoaded) return null

  const pos = {
    "top-left": "top-3 left-3",
    "top-right": "top-3 right-3",
    "bottom-left": "bottom-3 left-3",
    "bottom-right": "bottom-3 right-3",
  }

  const btn = "size-8 rounded-md bg-background/95 backdrop-blur-md border border-border/50 shadow-lg flex items-center justify-center hover:bg-accent transition-colors"

  return (
    <div className={cn("absolute z-10 flex flex-col gap-1", pos[position], className)}>
      <button onClick={handleZoomIn} className={btn} aria-label="放大"><Plus className="size-4" /></button>
      <button onClick={handleZoomOut} className={btn} aria-label="缩小"><Minus className="size-4" /></button>
      <button onClick={handleFit} className={btn} aria-label="适配视图"><ScanSearch className="size-4" /></button>
      <button onClick={handleFullscreen} className={btn} aria-label={isFullscreen ? "退出全屏" : "全屏"}>
        <Maximize className="size-4" />
      </button>
      <button onClick={handleExport} className={btn} aria-label="导出图片"><Download className="size-4" /></button>
    </div>
  )
}
