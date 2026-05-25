"use client"

import * as React from "react"
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
  const tweenRef = React.useRef<gsap.core.Tween | null>(null)
  const mountedRef = React.useRef(false)

  React.useLayoutEffect(() => {
    const outer = outerRef.current
    const inner = innerRef.current
    if (!outer || !inner) return

    if (!mountedRef.current) {
      mountedRef.current = true
      gsap.set(outer, {
        height: open ? "auto" : 0,
        overflow: open ? "visible" : "hidden",
        opacity: open ? 1 : 0,
      })
      return
    }

    tweenRef.current?.kill()
    const measured = inner.offsetHeight

    if (open) {
      gsap.set(outer, { overflow: "hidden", display: "block" })
      tweenRef.current = gsap.fromTo(
        outer,
        { height: 0, opacity: 0 },
        {
          height: measured,
          opacity: 1,
          duration,
          ease: "power3.out",
          onComplete: () => {
            gsap.set(outer, { height: "auto", overflow: "visible" })
          },
        },
      )
    } else {
      gsap.set(outer, { height: measured, overflow: "hidden" })
      tweenRef.current = gsap.to(outer, {
        height: 0,
        opacity: 0,
        duration,
        ease: "power3.in",
      })
    }
  }, [open, duration])

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
