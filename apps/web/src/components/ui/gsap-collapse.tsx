"use client"

import * as React from "react"
import { useReducedMotion } from "motion/react"
import { gsap } from "@/lib/gsap"
import { cn } from "@/lib/utils"

/**
 * <GsapCollapse open>...</GsapCollapse>
 * GSAP 驱动的 height: auto 折叠动画。
 *
 * 设计要点：
 * - 内部包 inner wrapper 测量真实高度，外层 height 0 → measured → auto。
 * - 动画结束设回 height: auto，避免子元素布局变化导致裁切。
 * - overflow:hidden 在动画期间生效；闲置时移除以避免 :focus-visible 等被裁切。
 */
export function GsapCollapse({
  open,
  duration = 0.24,
  className,
  children,
  ...rest
}: React.ComponentProps<"div"> & { open: boolean; duration?: number }) {
  const outerRef = React.useRef<HTMLDivElement | null>(null)
  const innerRef = React.useRef<HTMLDivElement | null>(null)
  const mountedRef = React.useRef(false)
  const reducedMotion = useReducedMotion()

  React.useLayoutEffect(() => {
    const outer = outerRef.current
    const inner = innerRef.current
    if (!outer || !inner) return

    if (!mountedRef.current || reducedMotion) {
      mountedRef.current = true
      gsap.set(outer, {
        height: open ? "auto" : 0,
        overflow: open ? "visible" : "hidden",
        opacity: open ? 1 : 0,
      })
      return
    }

    // 连续点击时从当前高度接续，避免每次强制归零或跳回完整高度。
    gsap.set(outer, { overflow: "hidden" })
    const tween = gsap.to(outer, {
      height: open ? inner.offsetHeight : 0,
      opacity: open ? 1 : 0,
      duration,
      ease: open ? "power3.out" : "power3.in",
      overwrite: "auto",
      onComplete: () => {
        if (open) gsap.set(outer, { height: "auto", overflow: "visible" })
      },
    })
    return () => { tween.kill() }
  }, [open, duration, reducedMotion])

  return (
    <div
      ref={outerRef}
      data-state={open ? "open" : "closed"}
      className={cn("will-change-[height,opacity]", className)}
      {...rest}
    >
      <div ref={innerRef}>{children}</div>
    </div>
  )
}
