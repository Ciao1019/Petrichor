"use client"

/**
 * 悬浮大纲：默认只露出一列长短不一的短线，鼠标移上去才展开成玻璃拟态面板显示标题文字。
 *
 * 用 portal 挂到 body：`.ftoc` 是 position:fixed，留在 SidebarInset（overflow:hidden）
 * 里会被裁掉，也无法相对真实视口定位。样式在 src/styles/public-article.css。
 *
 * 组件本身不关心内容怎么滚：由调用方给出当前高亮项并处理点击跳转，
 * 所以整页滚动的文章编辑器和内部容器滚动的文档预览都能复用同一套。
 */

import * as React from "react"
import { createPortal } from "react-dom"

import type { TocItem } from "@/lib/markdown-toc"
import { cn } from "@/lib/utils"

/** 收起状态下每级标题的短线长度，用长度差表达层级。 */
const LINE_W: Record<number, number> = { 2: 14, 3: 10, 4: 7 }
const LINE_W_ACTIVE: Record<number, number> = { 2: 22, 3: 18, 4: 13 }

/** 大纲取二到四级：一级通常是文章标题本身，五级往下在窄条里已经分不出层次。 */
export const TOC_MIN_LEVEL = 2
export const TOC_MAX_LEVEL = 4

export function filterTocForOverlay(toc: TocItem[]): TocItem[] {
  return toc.filter((item) => item.level >= TOC_MIN_LEVEL && item.level <= TOC_MAX_LEVEL)
}

export function EditorTocOverlay({
  navToc,
  activeHeadingId,
  rightOffset,
  topOffset,
  onTocClick,
}: {
  navToc: TocItem[]
  activeHeadingId: string
  rightOffset: number
  topOffset: number
  onTocClick: (id: string) => void
}) {
  const containerRef = React.useRef<HTMLElement | null>(null)
  const clickLockRef = React.useRef(false)

  React.useEffect(() => {
    if (clickLockRef.current) return
    const container = containerRef.current
    if (!container || !activeHeadingId) return
    const el = container.querySelector<HTMLElement>(`[data-toc-id="${activeHeadingId}"]`)
    if (!el) return
    const scrollTarget = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2
    container.scrollTo({ top: scrollTarget, behavior: "smooth" })
  }, [activeHeadingId])

  const handleClick = React.useCallback((id: string) => {
    const container = containerRef.current
    if (container) {
      const el = container.querySelector<HTMLElement>(`[data-toc-id="${id}"]`)
      if (el) {
        const scrollTarget = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2
        container.scrollTo({ top: scrollTarget, behavior: "smooth" })
      }
    }
    // 点击后正文会平滑滚动，期间滚动监听算出的"当前标题"是过程值，
    // 会把大纲自己又拽回去，所以先锁住自动跟随。
    clickLockRef.current = true
    onTocClick(id)
    setTimeout(() => { clickLockRef.current = false }, 900)
  }, [onTocClick])

  return createPortal(
    <nav
      className="ftoc"
      ref={containerRef}
      aria-label="目录"
      style={{ right: rightOffset, top: topOffset }}
    >
      {navToc.map((item) => {
        const active = activeHeadingId === item.id
        const w = active ? (LINE_W_ACTIVE[item.level] ?? 18) : (LINE_W[item.level] ?? 10)
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

export default EditorTocOverlay
