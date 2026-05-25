import * as React from "react"

import { cn } from "@/cuicui/utils/cn"
import { gsap } from "@/lib/gsap"

type TreeProps = {
  contentTree: React.ReactNode | ((collapsed: boolean) => React.ReactNode)
  defaultCollapsed?: boolean
  className?: string
  children?: React.ReactNode
  hasChildren?: boolean
  onExpand?: () => void
  onSelect?: () => void
  onToggleCollapsed?: (collapsed: boolean) => void
}

export function Tree({
  contentTree,
  defaultCollapsed = false,
  className,
  children,
  hasChildren: hasChildrenProp,
  onExpand,
  onSelect,
  onToggleCollapsed,
}: TreeProps) {
  const computedHasChildren = React.Children.count(children) > 0
  const hasChildren = hasChildrenProp ?? computedHasChildren
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed)
  const [renderChildren, setRenderChildren] = React.useState(!defaultCollapsed)
  const outerRef = React.useRef<HTMLDivElement | null>(null)
  const innerRef = React.useRef<HTMLDivElement | null>(null)
  const resizeObserverRef = React.useRef<ResizeObserver | null>(null)
  const tweenRef = React.useRef<gsap.core.Tween | null>(null)
  const initRef = React.useRef(false)
  const ANIMATION_DURATION = 0.22

  // 展开后用 ResizeObserver 监听子内容变化，自动同步高度。
  React.useEffect(() => {
    if (!hasChildren || collapsed || !renderChildren) {
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      return
    }
    const inner = innerRef.current
    const outer = outerRef.current
    if (!inner || !outer) return
    if (typeof ResizeObserver === "undefined") return

    const observer = new ResizeObserver(() => {
      // 仅当 outer 已是 auto 状态时同步（防止动画进行中被打断）
      if (tweenRef.current?.isActive()) return
      gsap.set(outer, { height: "auto" })
    })
    observer.observe(inner)
    resizeObserverRef.current = observer
    return () => {
      observer.disconnect()
      if (resizeObserverRef.current === observer) {
        resizeObserverRef.current = null
      }
    }
  }, [collapsed, hasChildren, renderChildren])

  // defaultCollapsed 外部变化时重置
  React.useEffect(() => {
    setCollapsed(defaultCollapsed)
    if (defaultCollapsed) {
      setRenderChildren(false)
    } else {
      setRenderChildren(true)
    }
  }, [defaultCollapsed])

  // 卸载时收尾
  React.useEffect(() => {
    return () => {
      tweenRef.current?.kill()
      resizeObserverRef.current?.disconnect()
    }
  }, [])

  // 由 collapsed 驱动 GSAP 动画
  React.useLayoutEffect(() => {
    const outer = outerRef.current
    const inner = innerRef.current
    if (!hasChildren) return
    if (!outer || !inner) return

    // 首次挂载：直接 set，不动画
    if (!initRef.current) {
      initRef.current = true
      gsap.set(outer, {
        height: collapsed ? 0 : "auto",
        autoAlpha: collapsed ? 0 : 1,
        overflow: collapsed ? "hidden" : "visible",
      })
      gsap.set(inner, { y: collapsed ? -4 : 0, autoAlpha: collapsed ? 0 : 1 })
      return
    }

    tweenRef.current?.kill()
    if (collapsed) {
      const startH = inner.offsetHeight
      gsap.set(outer, { height: startH, overflow: "hidden" })
      tweenRef.current = gsap.to(outer, {
        height: 0,
        autoAlpha: 0,
        duration: ANIMATION_DURATION,
        ease: "power3.in",
      })
      gsap.to(inner, {
        y: -4,
        autoAlpha: 0,
        duration: ANIMATION_DURATION,
        ease: "power3.in",
        onComplete: () => {
          setRenderChildren(false)
        },
      })
    } else {
      // 子节点可能尚未挂载，先确保挂载
      if (!renderChildren) {
        setRenderChildren(true)
        return
      }
      const endH = inner.offsetHeight
      gsap.set(outer, { height: 0, overflow: "hidden", autoAlpha: 1 })
      gsap.set(inner, { y: -4, autoAlpha: 0 })
      tweenRef.current = gsap.to(outer, {
        height: endH,
        duration: ANIMATION_DURATION,
        ease: "power3.out",
        onComplete: () => {
          gsap.set(outer, { height: "auto", overflow: "visible" })
        },
      })
      gsap.to(inner, {
        y: 0,
        autoAlpha: 1,
        duration: ANIMATION_DURATION,
        ease: "power3.out",
      })
    }
  }, [collapsed, hasChildren, renderChildren])

  const renderedContent = React.useMemo(() => {
    if (typeof contentTree === "function") {
      return contentTree(collapsed)
    }
    return contentTree
  }, [collapsed, contentTree])

  const clickable = hasChildren || !!onSelect

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div
        className={cn(
          "group flex items-center rounded-md px-2 py-1.5",
          clickable ? "cursor-pointer hover:bg-neutral-500/10" : ""
        )}
        onClick={() => {
          if (hasChildren) {
            const nextCollapsed = !collapsed
            if (!nextCollapsed) {
              setRenderChildren(true)
              onExpand?.()
            }
            setCollapsed(nextCollapsed)
            onToggleCollapsed?.(nextCollapsed)
            return
          }
          onSelect?.()
        }}
      >
        <div className="min-w-0 flex-1">{renderedContent}</div>
      </div>

      {hasChildren && renderChildren ? (
        <div
          ref={outerRef}
          className="ml-3 border-l border-neutral-500/15 pl-3 dark:border-white/10 will-change-[height,opacity]"
        >
          <div
            ref={innerRef}
            className="flex flex-col gap-1 pb-1 will-change-[transform,opacity]"
          >
            {children}
          </div>
        </div>
      ) : null}
    </div>
  )
}
