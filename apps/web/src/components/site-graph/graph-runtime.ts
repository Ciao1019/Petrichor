import type { SiteGraphPayload, SiteGraphPayloadLink, SiteGraphPayloadNode } from "@/lib/api"

/**
 * 全站星图运行时。
 *
 * 技术选型对齐 newechoes：d3-force-3d 的力导求解器（固定 2 维）+ Canvas 2D 绘制 + HTML 标签层。
 * 与其不同的是我们的节点带「属性」和「关系名称」，因此悬停面板展示的是结构化信息而非纯标题。
 */

type ForceModule = typeof import("d3-force-3d")

export interface RuntimeNode extends SiteGraphPayloadNode {
    degree: number
    neighbors: Set<string>
    radius: number
    labelElement: HTMLDivElement
    /** 递归布局给出的理想位置，聚簇力会把节点往这里拉 */
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
    /** 悬停/选中节点变化时回调，宿主组件用它渲染详情面板 */
    onHoverNode: (node: SiteGraphPayloadNode | null) => void
    onSelectNode: (node: SiteGraphPayloadNode | null) => void
    /**
     * 画布上发生了一次真实点击（已排除拖拽与平移）时触发。
     * 与 onSelectNode 分开是因为后者也会被左侧树的聚焦调用，
     * 用它做「点画布收起目录」会导致点树即收起自己。
     */
    onCanvasClick?: () => void
    /** 双击节点触发跳转 */
    onNavigate: (route: string) => void
}

const CLICK_THRESHOLD_PX = 3
const DRAG_THRESHOLD_PX = 5
const NODE_HIT_PADDING_PX = 12
const CLOUD_JITTER = 58

const LINK_CURVE = { structure: 10, relation: 24, focus: 18 } as const
const LINK_ALPHA = {
    structure: 0.32,
    relation: 0.16,
    focusStructure: 0.9,
    focusRelation: 0.8,
} as const
const LINK_WIDTH = { structure: 1.3, relation: 1.05, focus: 2.1 } as const

const LAYOUT = {
    rootRadius: 130,
    branchDistance: 88,
    minBranchDistance: 48,
    depthFalloff: 0.86,
    sectionSpread: Math.PI * 0.78,
    leafSpread: Math.PI * 0.95,
    leafDistance: 56,
    siblingJitter: 16,
} as const

interface ThemePalette {
    root: string
    section: string
    article: string
    concept: string
    entity: string
    tag: string
    structure: string
    structureActive: string
    relation: string
}

interface ViewState {
    width: number
    height: number
    pixelRatio: number
    zoom: number
    offsetX: number
    offsetY: number
}

let forceModulePromise: Promise<ForceModule> | null = null

/** 力导库按需加载：点群页面是低频入口，不占首屏体积 */
function loadForceModule() {
    if (!forceModulePromise) {
        forceModulePromise = import("d3-force-3d").catch((error: unknown) => {
            forceModulePromise = null
            throw error
        })
    }
    return forceModulePromise
}

export function preloadSiteGraphRuntime() {
    return loadForceModule()
}

/** 稳定伪随机：同一个节点每次渲染抖动一致，避免刷新后点群跳位 */
function seededNoise(seed: number) {
    const raw = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
    return raw - Math.floor(raw)
}

function readCssColor(styles: CSSStyleDeclaration, token: string, fallback: string) {
    return styles.getPropertyValue(token).trim() || fallback
}

function readThemePalette(): ThemePalette {
    const styles = getComputedStyle(document.documentElement)
    const isDark = document.documentElement.classList.contains("dark")
    return {
        root: readCssColor(styles, "--site-graph-root", isDark ? "#f4f4f5" : "#18181b"),
        section: readCssColor(styles, "--site-graph-section", isDark ? "#d4d4d8" : "#3f3f46"),
        article: readCssColor(styles, "--site-graph-article", isDark ? "#93c5fd" : "#2563eb"),
        concept: readCssColor(styles, "--site-graph-concept", isDark ? "#c4b5fd" : "#7c3aed"),
        entity: readCssColor(styles, "--site-graph-entity", isDark ? "#6ee7b7" : "#059669"),
        tag: readCssColor(styles, "--site-graph-tag", isDark ? "#fcd34d" : "#d97706"),
        structure: isDark ? "rgba(161, 161, 170, 0.7)" : "rgba(63, 63, 70, 0.62)",
        structureActive: isDark ? "rgba(244, 244, 245, 0.92)" : "rgba(24, 24, 27, 0.9)",
        relation: isDark ? "rgba(196, 181, 253, 0.72)" : "rgba(124, 58, 237, 0.62)",
    }
}

function getNodeColor(node: RuntimeNode, palette: ThemePalette) {
    switch (node.kind) {
        case "root": return palette.root
        case "section": return palette.section
        case "article": return palette.article
        case "entity": return palette.entity
        case "tag": return palette.tag
        default: return palette.concept
    }
}

/** 半径按类型 + 度数 + 权重递增，让枢纽节点自然变大 */
function getNodeRadius(node: SiteGraphPayloadNode, degree = 0) {
    if (node.kind === "root") return 8.2
    if (node.kind === "section") return Math.min(7.4, 5 + degree * 0.22)
    if (node.kind === "article") return Math.min(5.2, 3 + degree * 0.16 + node.weight * 0.1)
    return Math.min(5.8, 3.2 + degree * 0.2 + node.weight * 0.12)
}

function isStructureLink(link: RuntimeLink) {
    return link.kind === "structure"
}

/** 沿 parentId 给每个节点算深度与兄弟序号，供递归锚点布局使用 */
function assignLayoutMetadata(nodes: RuntimeNode[]) {
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const childrenByParent = new Map<string, RuntimeNode[]>()

    for (const node of nodes) {
        node.depth = 0
        node.siblingIndex = 0
        node.siblingCount = 1
        if (!node.parentId) continue
        childrenByParent.set(node.parentId, [...(childrenByParent.get(node.parentId) ?? []), node])
    }

    const roots = nodes.filter((node) => !node.parentId || !byId.has(node.parentId))
    const queue = [...roots]
    const visited = new Set<string>(roots.map((node) => node.id))

    while (queue.length > 0) {
        const parent = queue.shift()
        if (!parent) continue
        const children = (childrenByParent.get(parent.id) ?? []).sort((left, right) => {
            if (left.kind !== right.kind) return left.kind === "section" ? -1 : 1
            return left.label.localeCompare(right.label, "zh-Hans-CN")
        })
        children.forEach((child, index) => {
            if (visited.has(child.id)) return
            visited.add(child.id)
            child.depth = parent.depth + 1
            child.siblingIndex = index
            child.siblingCount = children.length
            queue.push(child)
        })
    }

    return { childrenByParent, roots }
}

function getBranchDistance(depth: number) {
    return Math.max(
        LAYOUT.minBranchDistance,
        LAYOUT.branchDistance * LAYOUT.depthFalloff ** Math.max(0, depth - 1),
    )
}

/** 从根开始扇形展开子节点，得到一份稳定的初始布局（力导只在此基础上微调） */
function seedPositions(nodes: RuntimeNode[]) {
    const { childrenByParent, roots } = assignLayoutMetadata(nodes)

    const place = (parent: RuntimeNode, parentAngle: number) => {
        const children = childrenByParent.get(parent.id) ?? []
        if (children.length === 0) return

        const hasSection = children.some((child) => child.kind === "section")
        const spread = hasSection ? LAYOUT.sectionSpread : LAYOUT.leafSpread
        const startAngle = parentAngle - spread / 2
        const step = children.length > 1 ? spread / (children.length - 1) : 0
        const distance = parent.depth === 0 ? LAYOUT.rootRadius : getBranchDistance(parent.depth + 1)

        children.forEach((child, index) => {
            const angle = children.length > 1 ? startAngle + step * index : parentAngle
            const cloudAngle = angle + (seededNoise(child.index ?? index) - 0.5) * 0.18
            const leafOffset = child.kind === "article" || child.kind === "tag"
                ? LAYOUT.leafDistance * Math.sqrt(index / Math.max(1, children.length) + 0.55) * 0.3
                : 0
            const siblingOffset = (child.siblingIndex - (child.siblingCount - 1) / 2)
                * (child.kind === "section" ? 2.6 : 4.8)
            const jitter = (seededNoise((child.index ?? index) + 19.5) - 0.5) * LAYOUT.siblingJitter
            const childDistance = distance + leafOffset + jitter

            child.anchorX = parent.anchorX
                + Math.cos(cloudAngle) * childDistance
                + Math.cos(cloudAngle + Math.PI / 2) * siblingOffset
            child.anchorY = parent.anchorY
                + Math.sin(cloudAngle) * childDistance
                + Math.sin(cloudAngle + Math.PI / 2) * siblingOffset
            child.x = child.anchorX + (seededNoise((child.index ?? index) + 3.1) - 0.5) * CLOUD_JITTER
            child.y = child.anchorY + (seededNoise((child.index ?? index) + 4.6) - 0.5) * CLOUD_JITTER * 0.72
            child.vx = 0
            child.vy = 0

            place(child, cloudAngle)
        })
    }

    roots.forEach((root, index) => {
        const rootAngle = roots.length > 1 ? (index / roots.length) * Math.PI * 2 : -Math.PI / 2
        root.anchorX = roots.length > 1 ? Math.cos(rootAngle) * LAYOUT.rootRadius : 0
        root.anchorY = roots.length > 1 ? Math.sin(rootAngle) * LAYOUT.rootRadius : 0
        root.x = root.anchorX
        root.y = root.anchorY
        root.vx = 0
        root.vy = 0
        place(root, rootAngle)
    })

    for (const node of nodes) {
        if (node.x != null && node.y != null) continue
        node.anchorX = 0
        node.anchorY = 0
        node.x = (seededNoise((node.index ?? 0) + 3.1) - 0.5) * CLOUD_JITTER
        node.y = (seededNoise((node.index ?? 0) + 4.6) - 0.5) * CLOUD_JITTER
        node.vx = 0
        node.vy = 0
    }
}

/** 聚簇力：把节点往递归布局的锚点拉，防止力导把层级揉成一团 */
function createClusterForce(strength = 0.04) {
    let nodes: RuntimeNode[] = []
    const force = (alpha: number) => {
        for (const node of nodes) {
            if (node.depth === 0) continue
            const local = strength * alpha
                * (node.kind === "section" ? 1.06 : 0.68)
                * Math.max(0.62, 1 - node.depth * 0.035)
            node.vx = (node.vx ?? 0) + (node.anchorX - (node.x ?? 0)) * local
            node.vy = (node.vy ?? 0) + (node.anchorY - (node.y ?? 0)) * local
        }
    }
    force.initialize = (initialized: RuntimeNode[]) => {
        nodes = initialized
    }
    return force
}

/** 环境漂移：静止时点群仍有轻微呼吸感，聚焦节点周边会减弱抖动 */
function createDriftForce(getQuietIds: () => Set<string>, strength = 0.0035) {
    let nodes: RuntimeNode[] = []
    let frame = 0
    const force = (alpha: number) => {
        frame += 1
        const quiet = getQuietIds()
        nodes.forEach((node, index) => {
            if (node.depth === 0 || node.fx != null || node.fy != null) return
            const seed = (node.index ?? index) + 1
            const phase = frame * 0.018 + seededNoise(seed + 23.4) * Math.PI * 2
            const local = strength * alpha * (quiet.has(node.id) ? 0.28 : 1) * (node.kind === "section" ? 0.62 : 1)
            node.vx = (node.vx ?? 0) + Math.cos(phase) * local
            node.vy = (node.vy ?? 0) + Math.sin(phase * 0.83 + seededNoise(seed + 7.9)) * local
        })
    }
    force.initialize = (initialized: RuntimeNode[]) => {
        nodes = initialized
    }
    return force
}

function buildRuntimeGraph(payload: SiteGraphPayload, labelLayer: HTMLElement) {
    const nodeMap = new Map<string, RuntimeNode>()
    const nodes = payload.nodes.map((node, index) => {
        const label = document.createElement("div")
        label.className = `site-graph-label site-graph-label--${node.kind}`
        label.textContent = node.label
        labelLayer.appendChild(label)

        const runtimeNode: RuntimeNode = {
            ...node,
            degree: 0,
            neighbors: new Set<string>(),
            radius: getNodeRadius(node),
            labelElement: label,
            anchorX: 0,
            anchorY: 0,
            depth: 0,
            siblingIndex: 0,
            siblingCount: 1,
            index,
        }
        nodeMap.set(node.id, runtimeNode)
        return runtimeNode
    })

    const links: RuntimeLink[] = []
    for (const link of payload.links) {
        const source = nodeMap.get(link.source)
        const target = nodeMap.get(link.target)
        if (!source || !target || source === target) continue
        source.degree += 1
        target.degree += 1
        source.neighbors.add(target.id)
        target.neighbors.add(source.id)
        links.push({ ...link, source, target })
    }

    for (const node of nodes) {
        node.radius = getNodeRadius(node, node.degree)
    }
    seedPositions(nodes)

    return { nodeMap, nodes, links }
}

export async function createSiteGraphRuntime(options: SiteGraphRuntimeOptions): Promise<SiteGraphRuntime> {
    const force = await loadForceModule()
    const { stage, mount, payload, onHoverNode, onSelectNode, onNavigate, onCanvasClick } = options
    const palette = readThemePalette()

    const canvas = document.createElement("canvas")
    canvas.className = "site-graph-canvas"
    mount.appendChild(canvas)
    const context = canvas.getContext("2d")
    if (!context) {
        throw new Error("当前环境不支持 Canvas 2D")
    }
    const ctx = context

    const labelLayer = document.createElement("div")
    labelLayer.className = "site-graph-labels"
    mount.appendChild(labelLayer)

    const { nodeMap, nodes, links } = buildRuntimeGraph(payload, labelLayer)
    const structureLinks = links.filter(isStructureLink)
    const relationLinks = links.filter((link) => !isStructureLink(link))

    let hoverNodeId: string | null = null
    let previewNodeId: string | null = null
    let selectedNodeId: string | null = null
    let animationId: number | null = null
    let running = false
    let disposed = false
    let dragNode: RuntimeNode | null = null
    let pointerMode: "node" | "pan" | null = null
    let pointerState: {
        x: number
        y: number
        originX: number
        originY: number
        worldX: number
        worldY: number
        nodeId: string | null
        dragged: boolean
        offsetX: number
        offsetY: number
    } | null = null

    const view: ViewState = { width: 1, height: 1, pixelRatio: 1, zoom: 1, offsetX: 0, offsetY: 0 }

    const simulation = force.forceSimulation<RuntimeNode>(nodes, 2).stop()
    simulation
        .alpha(0.9)
        .alphaMin(0.001)
        .alphaDecay(0.028)
        .alphaTarget(0.012)
        .velocityDecay(0.32)
        .force("link", force
            .forceLink<RuntimeNode, RuntimeLink>(structureLinks)
            .id((node) => node.id)
            .iterations(2)
            .distance((link) => {
                const base = getBranchDistance(Math.max(link.source.depth, link.target.depth))
                const relief = Math.min(26, Math.sqrt(link.target.siblingCount) * 5)
                return link.target.kind === "section"
                    ? Math.max(46, base * 0.96 + relief)
                    : Math.max(40, base * 0.72 + relief)
            })
            .strength((link) => (link.target.kind === "section" ? 0.58 : 0.48)))
        .force("charge", force
            .forceManyBody<RuntimeNode>()
            .strength((node) => {
                if (node.depth === 0) return -440
                if (node.kind === "section") return -150 - node.degree * 6 - node.siblingCount * 1.2
                return -54 - node.degree * 1.8 - Math.min(28, node.siblingCount * 0.8)
            })
            .distanceMin(14)
            .distanceMax(290))
        .force("collide", force
            .forceCollide<RuntimeNode>((node) =>
                node.radius + 8 + Math.min(12, Math.sqrt(node.siblingCount) * 1.8))
            .strength(0.86)
            .iterations(2))
        .force("center", force.forceCenter<RuntimeNode>(0, 0))
        .force("cluster", createClusterForce())
        .force("drift", createDriftForce(() =>
            new Set([selectedNodeId, hoverNodeId, previewNodeId].filter((id): id is string => Boolean(id)))))

    simulation.tick(260)

    function getFocusNodeId() {
        return previewNodeId || hoverNodeId || selectedNodeId
    }

    function worldToScreen(x = 0, y = 0) {
        return {
            x: view.width / 2 + view.offsetX + x * view.zoom,
            y: view.height / 2 + view.offsetY + y * view.zoom,
        }
    }

    function screenToWorld(x: number, y: number) {
        return {
            x: (x - view.width / 2 - view.offsetX) / view.zoom,
            y: (y - view.height / 2 - view.offsetY) / view.zoom,
        }
    }

    function getPointer(event: PointerEvent | WheelEvent) {
        const rect = canvas.getBoundingClientRect()
        const x = event.clientX - rect.left
        const y = event.clientY - rect.top
        const world = screenToWorld(x, y)
        return { x, y, worldX: world.x, worldY: world.y }
    }

    function getNodeAtPoint(x: number, y: number) {
        let best: RuntimeNode | null = null
        let bestDistance = Infinity
        for (const node of nodes) {
            const point = worldToScreen(node.x, node.y)
            const radius = Math.max(12, node.radius * view.zoom + NODE_HIT_PADDING_PX)
            const distance = Math.hypot(point.x - x, point.y - y)
            if (distance <= radius && distance < bestDistance) {
                best = node
                bestDistance = distance
            }
        }
        return best
    }

    function getFocusSet() {
        const focusId = getFocusNodeId()
        const focusNode = focusId ? nodeMap.get(focusId) : null
        if (!focusNode) return new Set<string>()
        return new Set<string>([focusNode.id, ...focusNode.neighbors])
    }

    function setCanvasSize() {
        view.width = Math.max(stage.clientWidth, 1)
        view.height = Math.max(stage.clientHeight, 1)
        view.pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
        canvas.width = Math.round(view.width * view.pixelRatio)
        canvas.height = Math.round(view.height * view.pixelRatio)
        canvas.style.width = `${view.width}px`
        canvas.style.height = `${view.height}px`
        ctx.setTransform(view.pixelRatio, 0, 0, view.pixelRatio, 0, 0)
    }

    function fit() {
        if (nodes.length === 0) return
        const xs = nodes.map((node) => node.x ?? 0)
        const ys = nodes.map((node) => node.y ?? 0)
        const minX = Math.min(...xs)
        const maxX = Math.max(...xs)
        const minY = Math.min(...ys)
        const maxY = Math.max(...ys)
        const fitZoom = Math.min(
            view.width / (Math.max(1, maxX - minX) + 180),
            view.height / (Math.max(1, maxY - minY) + 150),
        )
        view.zoom = Math.min(1.35, Math.max(0.4, fitZoom))
        view.offsetX = -((minX + maxX) / 2) * view.zoom
        view.offsetY = -((minY + maxY) / 2) * view.zoom
    }

    function centerOnNode(nodeId: string) {
        const node = nodeMap.get(nodeId)
        if (!node) return
        view.offsetX = -(node.x ?? 0) * view.zoom
        view.offsetY = -(node.y ?? 0) * view.zoom
    }

    function getControlPoint(
        source: { x: number; y: number },
        target: { x: number; y: number },
        curve: number,
        seed: number,
    ) {
        const midX = (source.x + target.x) / 2
        const midY = (source.y + target.y) / 2
        const dx = target.x - source.x
        const dy = target.y - source.y
        const length = Math.max(1, Math.hypot(dx, dy))
        const direction = seededNoise(seed + 31.4) > 0.5 ? 1 : -1
        return {
            x: midX + (-dy / length) * curve * direction,
            y: midY + (dx / length) * curve * direction,
        }
    }

    function drawLinkSet(linkSet: RuntimeLink[], focusSet: Set<string>, structure: boolean) {
        const zoomScale = Math.max(1, Math.sqrt(view.zoom))
        for (const link of linkSet) {
            const source = worldToScreen(link.source.x, link.source.y)
            const target = worldToScreen(link.target.x, link.target.y)
            const focused = focusSet.has(link.source.id) && focusSet.has(link.target.id)

            ctx.save()
            ctx.strokeStyle = structure
                ? (focused ? palette.structureActive : palette.structure)
                : palette.relation
            ctx.globalAlpha = structure
                ? (focused ? LINK_ALPHA.focusStructure : LINK_ALPHA.structure)
                : (focused ? LINK_ALPHA.focusRelation : LINK_ALPHA.relation)
            ctx.lineWidth = (focused
                ? LINK_WIDTH.focus
                : structure ? LINK_WIDTH.structure : LINK_WIDTH.relation) * zoomScale
            ctx.beginPath()
            ctx.moveTo(source.x, source.y)
            const curve = focused ? LINK_CURVE.focus : structure ? LINK_CURVE.structure : LINK_CURVE.relation
            const control = getControlPoint(source, target, curve, link.target.index ?? 0)
            ctx.quadraticCurveTo(control.x, control.y, target.x, target.y)
            ctx.stroke()

            // 聚焦时把关系名称画在连线中点，这是本项目相对参考实现新增的信息层
            if (focused && !structure && view.zoom > 0.7) {
                ctx.globalAlpha = 0.9
                ctx.fillStyle = palette.relation
                ctx.font = `${Math.round(10 * zoomScale)}px system-ui, sans-serif`
                ctx.textAlign = "center"
                ctx.textBaseline = "middle"
                ctx.fillText(link.relation, control.x, control.y)
            }
            ctx.restore()
        }
    }

    function drawNodes(focusSet: Set<string>) {
        for (const node of nodes) {
            const point = worldToScreen(node.x, node.y)
            const isSelected = node.id === selectedNodeId
            const isInteractive = node.id === hoverNodeId || node.id === previewNodeId
            const inFocus = focusSet.size === 0 || focusSet.has(node.id)
            const radius = node.radius * view.zoom
                * (isSelected ? 1.7 : isInteractive ? 1.42 : node.kind === "root" ? 1.18 : 1)

            ctx.save()
            if (isSelected || isInteractive) {
                ctx.strokeStyle = palette.structureActive
                ctx.globalAlpha = isSelected ? 0.46 : 0.28
                ctx.lineWidth = 1.2
                ctx.beginPath()
                ctx.arc(point.x, point.y, radius + 8, 0, Math.PI * 2)
                ctx.stroke()
            }
            ctx.globalAlpha = inFocus ? 1 : node.kind === "article" ? 0.34 : 0.5
            ctx.fillStyle = getNodeColor(node, palette)
            ctx.beginPath()
            ctx.arc(point.x, point.y, Math.max(1.8, radius), 0, Math.PI * 2)
            ctx.fill()
            ctx.restore()
        }
    }

    function updateLabels(focusSet: Set<string>) {
        // 只有真正的窄屏才整体隐藏标签；点群列在桌面端也就 500~900px 宽，
        // 按 900 判定会导致桌面端一个标签都不显示
        const compact = view.width <= 420
        for (const node of nodes) {
            const point = worldToScreen(node.x, node.y)
            const isSelected = node.id === selectedNodeId
            const isHover = node.id === hoverNodeId || node.id === previewNodeId
            const showLabel = isSelected
                || isHover
                || node.kind === "root"
                || node.kind === "section"
                || (focusSet.has(node.id) && view.zoom > 0.85)

            node.labelElement.classList.toggle("is-visible", !compact && showLabel)
            node.labelElement.classList.toggle("is-active", isSelected || isHover)
            node.labelElement.style.transform =
                `translate(${point.x}px, ${point.y - node.radius * view.zoom - 12}px) translate(-50%, -100%)`
        }
    }

    function render() {
        const focusSet = getFocusSet()
        ctx.clearRect(0, 0, view.width, view.height)
        drawLinkSet(structureLinks, focusSet, true)
        drawLinkSet(relationLinks, focusSet, false)
        drawNodes(focusSet)
        updateLabels(focusSet)
    }

    function setHoverNode(nodeId: string | null) {
        if (hoverNodeId === nodeId) return
        hoverNodeId = nodeId
        onHoverNode(nodeId ? nodeMap.get(nodeId) ?? null : null)
        render()
    }

    function loop() {
        if (!running || disposed) return
        simulation.tick(1)
        render()
        animationId = window.requestAnimationFrame(loop)
    }

    function resize() {
        const previousWidth = view.width
        const previousHeight = view.height
        setCanvasSize()
        // 首次量到真实尺寸、或容器尺寸发生明显变化时重新取景，
        // 否则点群会停在按旧尺寸算出的偏移上（表现为画布一片空白）
        const wasUninitialized = previousWidth <= 1 || previousHeight <= 1
        const changedALot = Math.abs(view.width - previousWidth) > previousWidth * 0.25
            || Math.abs(view.height - previousHeight) > previousHeight * 0.25
        if (wasUninitialized || changedALot) fit()
        render()
    }

    canvas.addEventListener("pointermove", (event) => {
        const pointer = getPointer(event)

        if (dragNode && pointerState) {
            const moved = Math.hypot(pointer.x - pointerState.originX, pointer.y - pointerState.originY)
            if (moved >= DRAG_THRESHOLD_PX) pointerState.dragged = true
            const dx = pointer.worldX - pointerState.worldX
            const dy = pointer.worldY - pointerState.worldY
            dragNode.fx = pointer.worldX - pointerState.offsetX
            dragNode.fy = pointer.worldY - pointerState.offsetY

            // 拖动枢纽节点时带动邻居，视觉上更像在拽一张网
            for (const candidate of nodes) {
                if (candidate.id === dragNode.id) continue
                if (!dragNode.neighbors.has(candidate.id)) continue
                candidate.vx = (candidate.vx ?? 0) + dx * 0.18
                candidate.vy = (candidate.vy ?? 0) + dy * 0.18
            }

            pointerState.worldX = pointer.worldX
            pointerState.worldY = pointer.worldY
            simulation.alpha(0.22).restart()
            render()
            return
        }

        if (pointerMode === "pan" && pointerState) {
            view.offsetX += pointer.x - pointerState.x
            view.offsetY += pointer.y - pointerState.y
            pointerState.x = pointer.x
            pointerState.y = pointer.y
            render()
            return
        }

        const node = getNodeAtPoint(pointer.x, pointer.y)
        canvas.style.cursor = node ? "pointer" : "grab"
        setHoverNode(node?.id ?? null)
    }, { passive: true })

    canvas.addEventListener("pointerleave", () => {
        if (dragNode || pointerMode === "pan") return
        canvas.style.cursor = "grab"
        setHoverNode(null)
    }, { passive: true })

    canvas.addEventListener("pointerdown", (event) => {
        const pointer = getPointer(event)
        const node = getNodeAtPoint(pointer.x, pointer.y)
        pointerState = {
            ...pointer,
            originX: pointer.x,
            originY: pointer.y,
            nodeId: node?.id ?? null,
            dragged: false,
            offsetX: node ? pointer.worldX - (node.x ?? pointer.worldX) : 0,
            offsetY: node ? pointer.worldY - (node.y ?? pointer.worldY) : 0,
        }
        pointerMode = node ? "node" : "pan"
        dragNode = node
        canvas.style.cursor = "grabbing"
        canvas.setPointerCapture(event.pointerId)
        if (dragNode) {
            dragNode.fx = dragNode.x ?? pointer.worldX
            dragNode.fy = dragNode.y ?? pointer.worldY
            simulation.alphaTarget(0.18).restart()
        }
    })

    function finishPointer(event: PointerEvent) {
        const pointer = getPointer(event)
        const node = event.type === "pointercancel" ? null : getNodeAtPoint(pointer.x, pointer.y)
        const moved = pointerState
            ? Math.hypot(pointer.x - pointerState.originX, pointer.y - pointerState.originY)
            : Infinity

        const isClick = event.type !== "pointercancel"
            && pointerState
            && !pointerState.dragged
            && moved <= CLICK_THRESHOLD_PX

        if (isClick && pointerState?.nodeId && pointerState.nodeId === node?.id) {
            selectedNodeId = node.id
            onSelectNode(node)
        } else if (isClick && !node) {
            selectedNodeId = null
            onSelectNode(null)
        }

        // 真实点击（非拖拽、非平移）才上报，宿主据此收起左侧目录
        if (isClick) {
            onCanvasClick?.()
        }

        if (dragNode) {
            dragNode.fx = null
            dragNode.fy = null
        }
        dragNode = null
        pointerMode = null
        pointerState = null
        canvas.style.cursor = node ? "pointer" : "grab"
        simulation.alphaTarget(0.012).restart()
        if (canvas.hasPointerCapture(event.pointerId)) {
            canvas.releasePointerCapture(event.pointerId)
        }
        render()
    }

    canvas.addEventListener("pointerup", finishPointer)
    canvas.addEventListener("pointercancel", finishPointer)

    // 双击直接跳转到节点对应的站内页面
    canvas.addEventListener("dblclick", (event) => {
        const rect = canvas.getBoundingClientRect()
        const node = getNodeAtPoint(event.clientX - rect.left, event.clientY - rect.top)
        if (node?.route) onNavigate(node.route)
    })

    canvas.addEventListener("wheel", (event) => {
        event.preventDefault()
        const pointer = getPointer(event)
        const before = screenToWorld(pointer.x, pointer.y)
        view.zoom = Math.min(2.8, Math.max(0.32, view.zoom * Math.exp(-event.deltaY * 0.0012)))
        const after = screenToWorld(pointer.x, pointer.y)
        view.offsetX += (after.x - before.x) * view.zoom
        view.offsetY += (after.y - before.y) * view.zoom
        render()
    }, { passive: false })

    resize()
    fit()
    render()

    return {
        start() {
            if (running || disposed) return
            running = true
            stage.classList.add("is-ready")
            resize()
            simulation.alphaTarget(0.012).restart()
            loop()
        },
        stop() {
            running = false
            simulation.stop()
            if (animationId != null) {
                window.cancelAnimationFrame(animationId)
                animationId = null
            }
        },
        resize,
        dispose() {
            if (disposed) return
            disposed = true
            running = false
            simulation.stop()
            if (animationId != null) {
                window.cancelAnimationFrame(animationId)
                animationId = null
            }
            canvas.remove()
            labelLayer.remove()
        },
        setFocusNode(nodeId) {
            selectedNodeId = nodeId
            onSelectNode(nodeId ? nodeMap.get(nodeId) ?? null : null)
            render()
        },
        setPreviewNode(nodeId) {
            previewNodeId = nodeId
            render()
        },
        focusAndCenter(nodeId) {
            selectedNodeId = nodeId
            centerOnNode(nodeId)
            onSelectNode(nodeMap.get(nodeId) ?? null)
            render()
        },
        fit() {
            fit()
            render()
        },
        updateTheme() {
            Object.assign(palette, readThemePalette())
            render()
        },
    }
}
