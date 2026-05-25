"use client"

import * as React from "react"
import { gsap } from "@/lib/gsap"
import { cn } from "@/lib/utils"

/**
 * <GsapFade visible> ... </GsapFade>
 * 通过 GSAP 控制 transform + opacity 的进出动画。
 * 与 transition-all CSS 过渡不同，这里只会触发 GPU 合成层属性，
 * 且不会在无关样式变化时产生意外动画。
 */
export function GsapFade({
  visible,
  scaleFrom = 0,
  duration = 0.22,
  className,
  children,
  ...rest
}: React.ComponentProps<"div"> & {
  visible: boolean
  scaleFrom?: number
  duration?: number
}) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const tweenRef = React.useRef<gsap.core.Tween | null>(null)
  const mountedRef = React.useRef(false)

  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    if (!mountedRef.current) {
      mountedRef.current = true
      gsap.set(el, {
        autoAlpha: visible ? 1 : 0,
        scale: visible ? 1 : scaleFrom,
      })
      return
    }
    tweenRef.current?.kill()
    tweenRef.current = gsap.to(el, {
      autoAlpha: visible ? 1 : 0,
      scale: visible ? 1 : scaleFrom,
      duration,
      ease: visible ? "back.out(1.3)" : "power3.in",
      overwrite: "auto",
    })
  }, [visible, scaleFrom, duration])

  return (
    <div
      ref={ref}
      className={cn("will-change-transform", className)}
      {...rest}
    >
      {children}
    </div>
  )
}

/**
 * <GsapWidth widthOpen widthClosed open>...</GsapWidth>
 * 通过 GSAP 接管宽度过渡（替代 transition-[width|max-width]）。
 * 适用于 pill / chip / 横向折叠等场景。
 */
export function GsapWidth({
  open,
  widthOpen,
  widthClosed,
  duration = 0.24,
  className,
  children,
  ...rest
}: React.ComponentProps<"div"> & {
  open: boolean
  widthOpen: string
  widthClosed: string
  duration?: number
}) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const mountedRef = React.useRef(false)

  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const target = open ? widthOpen : widthClosed
    if (!mountedRef.current) {
      mountedRef.current = true
      gsap.set(el, { width: target })
      return
    }
    const tween = gsap.to(el, {
      width: target,
      duration,
      ease: "power3.out",
      overwrite: "auto",
    })
    return () => {
      tween.kill()
    }
  }, [open, widthOpen, widthClosed, duration])

  return (
    <div
      ref={ref}
      className={cn("will-change-[width] overflow-hidden", className)}
      {...rest}
    >
      {children}
    </div>
  )
}
