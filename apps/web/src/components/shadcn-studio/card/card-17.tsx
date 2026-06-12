"use client"

import * as React from "react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

type Card17Props = {
  title?: React.ReactNode
  imageSrc?: string | null
  imageAlt?: string
  className?: string
  contentClassName?: string
  /** 覆盖图片样式；默认是 card-17 demo 的 16:9 裁剪填充。传入可改为完整显示等。 */
  imageClassName?: string
  children?: React.ReactNode
}

/**
 * shadcn-studio card-17：鼠标悬停时卡片与内部图片做不同速率的 3D 视差倾斜。
 * 图片为可选——无图时仅卡片本体倾斜。
 */
export function Card17({ title, imageSrc, imageAlt = "", className, contentClassName, imageClassName, children }: Card17Props) {
  const cardRef = React.useRef<HTMLDivElement>(null)
  const imageRef = React.useRef<HTMLImageElement>(null)
  const animationFrameRef = React.useRef<number | undefined>(undefined)
  const lastMousePosition = React.useRef({ x: 0, y: 0 })

  React.useEffect(() => {
    const card = cardRef.current
    if (!card) return
    const image = imageRef.current

    let rect: DOMRect | undefined
    let centerX = 0
    let centerY = 0

    const computeTransforms = (mouseX: number, mouseY: number) => {
      if (!rect) {
        rect = card.getBoundingClientRect()
        centerX = rect.left + rect.width / 2
        centerY = rect.top + rect.height / 2
      }
      const relativeX = mouseX - centerX
      const relativeY = mouseY - centerY
      return {
        card: { rotateX: -relativeY * 0.035, rotateY: relativeX * 0.035, scale: 1.025 },
        image: { rotateX: -relativeY * 0.025, rotateY: relativeX * 0.025, scale: 1.02 },
      }
    }

    const animate = () => {
      const { card: cardTransform, image: imageTransform } = computeTransforms(
        lastMousePosition.current.x,
        lastMousePosition.current.y
      )

      card.style.transform = `perspective(1000px) rotateX(${cardTransform.rotateX}deg) rotateY(${cardTransform.rotateY}deg) scale3d(${cardTransform.scale}, ${cardTransform.scale}, ${cardTransform.scale})`
      card.style.boxShadow = "0 10px 35px rgba(0, 0, 0, 0.2)"

      if (image) {
        image.style.transform = `perspective(1000px) rotateX(${imageTransform.rotateX}deg) rotateY(${imageTransform.rotateY}deg) scale3d(${imageTransform.scale}, ${imageTransform.scale}, ${imageTransform.scale})`
      }

      animationFrameRef.current = requestAnimationFrame(animate)
    }

    const handleMouseMove = (e: MouseEvent) => {
      lastMousePosition.current = { x: e.clientX, y: e.clientY }
    }

    const handleMouseEnter = () => {
      rect = undefined
      card.style.transition = "transform 0.2s ease, box-shadow 0.2s ease"
      if (image) image.style.transition = "transform 0.2s ease"
      animate()
    }

    const handleMouseLeave = () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }

      card.style.transform = "perspective(1000px) rotateX(0) rotateY(0) scale3d(1, 1, 1)"
      card.style.boxShadow = "none"
      card.style.transition = "transform 0.5s ease, box-shadow 0.5s ease"

      if (image) {
        image.style.transform = "perspective(1000px) rotateX(0) rotateY(0) scale3d(1, 1, 1)"
        image.style.transition = "transform 0.5s ease"
      }
    }

    card.addEventListener("mouseenter", handleMouseEnter)
    card.addEventListener("mousemove", handleMouseMove)
    card.addEventListener("mouseleave", handleMouseLeave)

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      card.removeEventListener("mouseenter", handleMouseEnter)
      card.removeEventListener("mousemove", handleMouseMove)
      card.removeEventListener("mouseleave", handleMouseLeave)
    }
  }, [imageSrc])

  return (
    <Card ref={cardRef} className={cn("border", className)}>
      {title ? (
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
      ) : null}
      <CardContent className={cn("space-y-6", contentClassName)}>
        {imageSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={imageRef}
            src={imageSrc}
            alt={imageAlt}
            className={cn("w-full rounded-md", imageClassName ?? "aspect-video object-cover")}
          />
        ) : null}
        {children}
      </CardContent>
    </Card>
  )
}
