"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"

import { publicSiteAppearanceApi, type PublicSelectionAskSource } from "@/lib/api"
import { isDemoMode } from "@/lib/demo/demo-mode"
import { cn } from "@/lib/utils"
import { SelectionAskToolbar } from "./selection-ask-toolbar"

const EASE = [0.16, 1, 0.3, 1] as const
const EXIT = { duration: 0.15, ease: [0.4, 0, 0.2, 1] } as const
/** 选区停止变化多久后再弹出工具栏（毫秒），拖选过程中不闪。 */
const SETTLE = 250
/** CSS Custom Highlight 名称：进入提问后焦点移到输入框，原生选区会消失，用它把选中的文字继续标出来。 */
const HIGHLIGHT = "selection-ask"
/** 选区落在这些元素里不算正文：目录、按钮和表单控件。 */
const IGNORED = "nav, button, input, textarea, select, [contenteditable='true'], [data-selection-ask-toolbar]"
/** 工具栏距视口左右边缘的最小留白。 */
const EDGE = 16
/** 展开后的面板宽度上限。 */
const PANEL_MAX_WIDTH = 352
/** 选区上方可视空间不足这个高度时改在下方展开，给回答留位置。 */
const ROOM_ABOVE = 360

export type SelectionAnchor = { x: number; y: number; placement: "above" | "below" }

type Rect = { top: number; bottom: number; left: number; width: number }

/** 面板宽度随视口收窄，两侧各留 EDGE。 */
export function selectionPanelWidth(viewportWidth: number) {
  return Math.max(0, Math.min(PANEL_MAX_WIDTH, viewportWidth - EDGE * 2))
}

/**
 * 以选区中点为锚，换算成相对容器的坐标。按展开后的面板宽度夹在视口内，
 * 这样从工具栏展开成输入框时位置不跳；触屏把工具栏放到选区下方，避开系统的复制菜单。
 */
export function computeSelectionAnchor(input: {
  box: Rect
  origin: { top: number; left: number }
  viewportWidth: number
  coarsePointer: boolean
}): SelectionAnchor {
  const { box, origin, viewportWidth, coarsePointer } = input
  const half = selectionPanelWidth(viewportWidth) / 2
  const centre = box.left + box.width / 2
  const x = Math.min(Math.max(centre, EDGE + half), viewportWidth - EDGE - half)
  const placement = coarsePointer || box.top < ROOM_ABOVE ? "below" : "above"
  return {
    x: x - origin.left,
    y: (placement === "above" ? box.top : box.bottom) - origin.top,
    placement,
  }
}

function inIgnoredElement(node: Node | null) {
  const element = node instanceof Element ? node : node?.parentElement
  return Boolean(element?.closest(IGNORED))
}

function supportsHighlights() {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"
}

function clearHighlight() {
  if (supportsHighlights()) CSS.highlights.delete(HIGHLIGHT)
}

/** 站长关闭前台问答或处于演示模式时不挂工具栏；取不到开关时同样不打扰阅读。 */
function usePublicSelectionAskEnabled() {
  const [enabled, setEnabled] = React.useState(false)
  React.useEffect(() => {
    if (isDemoMode()) return
    let canceled = false
    publicSiteAppearanceApi
      .detail()
      .then((res) => {
        if (!canceled) setEnabled(res.data.publicQaEnabled)
      })
      .catch(() => {
        // 开关读取失败按关闭处理
      })
    return () => {
      canceled = true
    }
  }, [])
  return enabled
}

/**
 * 前台正文划词问 AI：选中文字后在选区旁弹出工具栏，可直接解释、翻译、复制，
 * 或展开成输入框就这段内容提问。回答来自 /api/public/qa/selection，按访客独立限流。
 */
export function SelectionAsk({
  source,
  className,
  children,
}: {
  source: PublicSelectionAskSource
  className?: string
  children: React.ReactNode
}) {
  const enabled = usePublicSelectionAskEnabled()
  const wrap = React.useRef<HTMLDivElement>(null)
  const prose = React.useRef<HTMLDivElement>(null)
  const range = React.useRef<Range | null>(null)
  const dragging = React.useRef(false)
  /** 按在工具栏上的这一下（触屏点按会先清掉原生选区），期间忽略选区变化。 */
  const pressingToolbar = React.useRef(false)
  const asking = React.useRef(false)

  const [anchor, setAnchor] = React.useState<SelectionAnchor | null>(null)
  const [text, setText] = React.useState("")
  const [panelWidth, setPanelWidth] = React.useState(PANEL_MAX_WIDTH)
  const [askMode, setAskMode] = React.useState(false)

  const place = React.useCallback((target: Range) => {
    const wrapEl = wrap.current
    if (!wrapEl) return
    const viewportWidth = document.documentElement.clientWidth
    setPanelWidth(selectionPanelWidth(viewportWidth))
    setAnchor(computeSelectionAnchor({
      box: target.getBoundingClientRect(),
      origin: wrapEl.getBoundingClientRect(),
      viewportWidth,
      coarsePointer: window.matchMedia("(pointer: coarse)").matches,
    }))
  }, [])

  const close = React.useCallback(() => {
    clearHighlight()
    asking.current = false
    range.current = null
    setAskMode(false)
    setAnchor(null)
  }, [])

  const enterAskMode = React.useCallback(() => {
    if (range.current && supportsHighlights()) {
      CSS.highlights.set(HIGHLIGHT, new Highlight(range.current))
    }
    asking.current = true
    setAskMode(true)
  }, [])

  React.useEffect(() => {
    if (!enabled) return
    let timer = 0

    const show = () => {
      const selection = window.getSelection()
      const proseEl = prose.current
      const selected = selection?.toString().trim() ?? ""
      if (
        !selection ||
        selection.isCollapsed ||
        !selected ||
        !proseEl ||
        !proseEl.contains(selection.anchorNode) ||
        !proseEl.contains(selection.focusNode) ||
        inIgnoredElement(selection.anchorNode) ||
        inIgnoredElement(selection.focusNode)
      ) {
        range.current = null
        setAnchor(null)
        return
      }
      range.current = selection.getRangeAt(0).cloneRange()
      setText(selected)
      place(range.current)
    }

    const onSelectionChange = () => {
      // 提问期间焦点在输入框、访客也可能在回答里选字复制，这些选区变化都不该关掉面板。
      if (asking.current || pressingToolbar.current) return
      window.clearTimeout(timer)
      setAnchor(null)
      if (!dragging.current) timer = window.setTimeout(show, SETTLE)
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-selection-ask-toolbar]")) {
        pressingToolbar.current = true
        return
      }
      window.clearTimeout(timer)
      close()
      dragging.current = true
    }

    const onPointerUp = () => {
      if (pressingToolbar.current) {
        // 等这次点按引起的选区变化都派发完再恢复监听。
        window.setTimeout(() => {
          pressingToolbar.current = false
        }, 0)
        return
      }
      if (asking.current) return
      dragging.current = false
      show()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && range.current) close()
    }

    const onResize = () => {
      if (range.current) place(range.current)
    }

    document.addEventListener("selectionchange", onSelectionChange)
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("pointerup", onPointerUp)
    // 触屏长按选字被系统手势接管时只会收到 pointercancel。
    document.addEventListener("pointercancel", onPointerUp)
    document.addEventListener("keydown", onKeyDown)
    window.addEventListener("resize", onResize)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener("selectionchange", onSelectionChange)
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("pointerup", onPointerUp)
      document.removeEventListener("pointercancel", onPointerUp)
      document.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("resize", onResize)
      clearHighlight()
    }
  }, [enabled, close, place])

  return (
    <div
      ref={wrap}
      className={cn(
        "relative [&_*::highlight(selection-ask)]:bg-(--retypeset-highlight) [&_*::highlight(selection-ask)]:text-(--retypeset-primary)",
        className,
      )}
    >
      <div ref={prose}>{children}</div>

      <AnimatePresence>
        {enabled && anchor ? (
          <motion.div
            key="toolbar"
            className="absolute z-50"
            style={{ left: anchor.x, top: anchor.y }}
            initial={{ opacity: 0, scale: 0.96, y: anchor.placement === "above" ? 6 : -6, filter: "blur(4px)" }}
            animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, scale: 0.99, y: anchor.placement === "above" ? 2 : -2, transition: EXIT }}
            transition={{ duration: 0.25, ease: EASE }}
          >
            <div className={cn("absolute -translate-x-1/2", anchor.placement === "above" ? "bottom-1.5" : "top-1.5")}>
              <SelectionAskToolbar
                source={source}
                text={text}
                askMode={askMode}
                panelWidth={panelWidth}
                onAsk={enterAskMode}
              />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
