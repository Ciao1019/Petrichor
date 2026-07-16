"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { useAuiState } from "@assistant-ui/react"

import { cn } from "@/lib/utils"

import { deriveQaTocText, firstTextOfParts } from "./assistant-message-utils"

/* ─── 对话大纲（复用文档详情 .ftoc 悬浮目录，交互与 EditorTocOverlay 一致） ─── */

const QA_TOC_VIEWPORT_SELECTOR = ".qa-thread-viewport"
// 激活判定线：消息顶部越过视口顶部 + 该偏移即视为当前项（对齐文档页 +80 的判定）
const QA_TOC_ACTIVE_OFFSET = 80
// 点击定位后消息顶部距视口顶部的留白
const QA_TOC_CLICK_OFFSET = 16
const QA_TOC_LINE_W: Record<number, number> = { 2: 14, 3: 10 }
const QA_TOC_LINE_W_ACTIVE: Record<number, number> = { 2: 22, 3: 18 }

type QaTocItem = { id: string; level: number; text: string }

export function getQaViewport(): HTMLElement | null {
  return document.querySelector<HTMLElement>(QA_TOC_VIEWPORT_SELECTOR)
}

export function QaThreadToc() {
  const messages = useAuiState((s) => s.thread.messages)
  const items = React.useMemo<QaTocItem[]>(() => {
    const list: QaTocItem[] = []
    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant") continue
      list.push({
        id: message.id,
        level: message.role === "user" ? 2 : 3,
        text: deriveQaTocText(message.role, firstTextOfParts(message.parts)),
      })
    }
    return list
  }, [messages])
  const hasItems = items.length > 0

  const [activeId, setActiveId] = React.useState("")
  // null = 未测量；测好定位再渲染，避免首帧闪位
  const [tocRight, setTocRight] = React.useState<number | null>(null)
  const [tocTop, setTocTop] = React.useState<number | null>(null)

  React.useEffect(() => {
    if (!hasItems) { setActiveId(""); return }
    setActiveId((prev) => {
      if (!prev) return items[0].id
      return items.some((item) => item.id === prev) ? prev : items[0].id
    })
  }, [hasItems, items])

  // 定位：贴聊天视口右缘，顶部按视口高度 20% 并夹在视口范围内
  React.useLayoutEffect(() => {
    const calc = () => {
      const viewport = getQaViewport()
      if (!viewport) return
      const rect = viewport.getBoundingClientRect()
      const vh = window.innerHeight
      setTocRight(Math.max(4, window.innerWidth - rect.right + 8))
      setTocTop(Math.min(Math.max(vh * 0.2, rect.top + 16), vh * 0.75))
    }
    calc()
    const ro = new ResizeObserver(calc)
    ro.observe(document.documentElement)
    const viewport = getQaViewport()
    if (viewport) ro.observe(viewport)
    window.addEventListener("resize", calc)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", calc)
    }
  }, [])

  // 滚动跟踪激活项：滚动源是聊天视口而非 window，其余与文档页一致
  React.useEffect(() => {
    if (!hasItems) return
    const viewport = getQaViewport()
    if (!viewport) return
    let ticking = false

    const updateActive = () => {
      const nodes = Array.from(viewport.querySelectorAll<HTMLElement>("[data-qa-msg-id]"))
      if (!nodes.length) return
      const threshold = viewport.getBoundingClientRect().top + QA_TOC_ACTIVE_OFFSET
      let active = nodes[0]
      for (const node of nodes) {
        if (node.getBoundingClientRect().top <= threshold) active = node
      }
      const id = active.dataset.qaMsgId
      if (id) setActiveId(id)
    }

    updateActive()
    const requestUpdate = () => {
      if (ticking) return
      ticking = true
      window.requestAnimationFrame(() => { ticking = false; updateActive() })
    }
    viewport.addEventListener("scroll", requestUpdate, { passive: true })
    window.addEventListener("resize", requestUpdate)
    return () => {
      viewport.removeEventListener("scroll", requestUpdate)
      window.removeEventListener("resize", requestUpdate)
    }
  }, [hasItems])

  const handleTocClick = React.useCallback((id: string) => {
    const viewport = getQaViewport()
    if (!viewport) return
    const target = viewport.querySelector<HTMLElement>(`[data-qa-msg-id="${CSS.escape(id)}"]`)
    if (!target) return
    const top = target.getBoundingClientRect().top
      - viewport.getBoundingClientRect().top
      + viewport.scrollTop
      - QA_TOC_CLICK_OFFSET
    viewport.scrollTo({ top: Math.max(0, top), behavior: "smooth" })
    setActiveId(id)
  }, [])

  if (!hasItems || tocRight === null || tocTop === null) return null
  return (
    <QaTocOverlay
      items={items}
      activeId={activeId}
      rightOffset={tocRight}
      topOffset={tocTop}
      onTocClick={handleTocClick}
    />
  )
}

export function QaTocOverlay({
  items,
  activeId,
  rightOffset,
  topOffset,
  onTocClick,
}: {
  items: QaTocItem[]
  activeId: string
  rightOffset: number
  topOffset: number
  onTocClick: (id: string) => void
}) {
  const containerRef = React.useRef<HTMLElement | null>(null)
  const clickLockRef = React.useRef(false)

  React.useEffect(() => {
    if (clickLockRef.current) return
    const container = containerRef.current
    if (!container || !activeId) return
    const el = container.querySelector<HTMLElement>(`[data-toc-id="${CSS.escape(activeId)}"]`)
    if (!el) return
    const scrollTarget = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2
    container.scrollTo({ top: scrollTarget, behavior: "smooth" })
  }, [activeId])

  const handleClick = React.useCallback((id: string) => {
    const container = containerRef.current
    if (container) {
      const el = container.querySelector<HTMLElement>(`[data-toc-id="${CSS.escape(id)}"]`)
      if (el) {
        const scrollTarget = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2
        container.scrollTo({ top: scrollTarget, behavior: "smooth" })
      }
    }
    clickLockRef.current = true
    onTocClick(id)
    setTimeout(() => { clickLockRef.current = false }, 900)
  }, [onTocClick])

  // Portal 到 body，position:fixed 相对真实视口定位（同 EditorTocOverlay）
  return createPortal(
    <nav
      className="ftoc"
      ref={containerRef}
      aria-label="对话大纲"
      style={{ right: rightOffset, top: topOffset }}
    >
      {items.map((item) => {
        const active = activeId === item.id
        const w = active ? (QA_TOC_LINE_W_ACTIVE[item.level] ?? 18) : (QA_TOC_LINE_W[item.level] ?? 10)
        return (
          <div
            key={item.id}
            data-toc-id={item.id}
            data-level={item.level}
            className={cn("ftoc-item", active && "is-active")}
            onClick={() => handleClick(item.id)}
          >
            <span className="ftoc-text">{item.text}</span>
            <span className="ftoc-line" style={{ width: w }} />
          </div>
        )
      })}
    </nav>,
    document.body
  )
}
