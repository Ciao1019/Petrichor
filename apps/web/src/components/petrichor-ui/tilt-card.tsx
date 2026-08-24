"use client"

import { useCallback, useEffect, useRef } from "react"
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

/** 卡片在四角能达到的最大倾斜角度。 */
const MAX_TILT_DEG = 7
/** 悬停时卡片整体的放大比例。 */
const HOVER_SCALE = 1.02

export type TiltCardProps = {
  title?: ReactNode
  imageSrc?: string | null
  imageAlt?: string
  className?: string
  contentClassName?: string
  /** 覆盖默认的 16:9 裁剪，例如改成完整显示原图。 */
  imageClassName?: string
  children?: ReactNode
}

/**
 * 跟随指针轻微倾斜的卡片。
 *
 * 倾斜角写在 `--tilt-x` / `--tilt-y` 两个自定义属性上，卡片和插图共用同一组数值，
 * 插图只是按比例缩小取值，于是「图比卡更慢一拍」的层次感完全交给 CSS，
 * JS 每帧只做一次几何测量。指针停止移动时不再排帧，触摸设备和
 * `prefers-reduced-motion` 下则完全不启用倾斜。
 */
export function TiltCard({
  title,
  imageSrc,
  imageAlt = "",
  className,
  contentClassName,
  imageClassName,
  children,
}: TiltCardProps) {
  const frameRef = useRef<HTMLDivElement>(null)
  const pointerRef = useRef({ x: 0, y: 0 })
  const rafRef = useRef<number | null>(null)

  const cancelPendingFrame = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  // 组件卸载时确保没有排队中的帧继续访问已卸载的节点。
  useEffect(() => cancelPendingFrame, [cancelPendingFrame])

  const paint = useCallback(() => {
    rafRef.current = null
    const frame = frameRef.current
    if (!frame) return

    const rect = frame.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return

    // 把指针位置映射到以卡片中心为原点的 [-1, 1] 区间。
    const ratioX = clampUnit(((pointerRef.current.x - rect.left) / rect.width) * 2 - 1)
    const ratioY = clampUnit(((pointerRef.current.y - rect.top) / rect.height) * 2 - 1)

    frame.style.setProperty("--tilt-x", `${(-ratioY * MAX_TILT_DEG).toFixed(2)}deg`)
    frame.style.setProperty("--tilt-y", `${(ratioX * MAX_TILT_DEG).toFixed(2)}deg`)
  }, [])

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isTiltablePointer(event)) return
      pointerRef.current = { x: event.clientX, y: event.clientY }
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(paint)
      }
    },
    [paint]
  )

  const handlePointerEnter = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isTiltablePointer(event)) return
    const frame = frameRef.current
    if (!frame) return
    frame.dataset.tilting = "true"
    frame.style.setProperty("--tilt-scale", String(HOVER_SCALE))
  }, [])

  const handlePointerLeave = useCallback(() => {
    cancelPendingFrame()
    const frame = frameRef.current
    if (!frame) return
    frame.removeAttribute("data-tilting")
    frame.style.removeProperty("--tilt-x")
    frame.style.removeProperty("--tilt-y")
    frame.style.removeProperty("--tilt-scale")
  }, [cancelPendingFrame])

  return (
    <div
      ref={frameRef}
      onPointerEnter={handlePointerEnter}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerLeave}
      className="rounded-xl transition-[transform,box-shadow] duration-500 ease-out data-[tilting=true]:shadow-2xl data-[tilting=true]:duration-150 motion-reduce:transition-none"
      style={{
        transform:
          "perspective(1000px) rotateX(var(--tilt-x, 0deg)) rotateY(var(--tilt-y, 0deg)) scale(var(--tilt-scale, 1))",
      }}
    >
      <Card className={cn("border", className)}>
        {title ? (
          <CardHeader>
            <CardTitle>{title}</CardTitle>
          </CardHeader>
        ) : null}
        <CardContent className={cn("space-y-6", contentClassName)}>
          {imageSrc ? (
            // 封面图来自任意外部 URL，直接使用浏览器图片加载管线。
            <img
              src={imageSrc}
              alt={imageAlt}
              className={cn(
                "w-full rounded-md transition-transform duration-500 ease-out motion-reduce:transition-none",
                imageClassName ?? "aspect-video object-cover"
              )}
              style={{
                // 插图沿用同一组角度，但只取 60%，形成与卡片错开的视差。
                transform:
                  "perspective(1000px) rotateX(calc(var(--tilt-x, 0deg) * 0.6)) rotateY(calc(var(--tilt-y, 0deg) * 0.6))",
              }}
            />
          ) : null}
          {children}
        </CardContent>
      </Card>
    </div>
  )
}

function clampUnit(value: number): number {
  if (value < -1) return -1
  if (value > 1) return 1
  return value
}

/** 触摸与手写笔不参与倾斜：没有「悬停」概念，跟手反而像卡顿。 */
function isTiltablePointer(event: ReactPointerEvent<HTMLElement>): boolean {
  return event.pointerType === "mouse" && !prefersReducedMotion()
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

export default TiltCard
