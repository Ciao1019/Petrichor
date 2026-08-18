"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { X } from "@/components/iconimate"

import { cn } from "@/lib/utils"

type LightboxImage = {
    src: string
    alt: string
}

const MIN_SCALE = 1
const MAX_SCALE = 6
const DOUBLE_TAP_SCALE = 2.5

type Transform = {
    scale: number
    tx: number
    ty: number
}

const IDENTITY: Transform = { scale: 1, tx: 0, ty: 0 }

function clampScale(value: number) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

/** 以视口中某点为不动点缩放：p 为该点相对视口中心的偏移。 */
function zoomAround(current: Transform, nextScale: number, p: { x: number; y: number }): Transform {
    const scale = clampScale(nextScale)
    if (scale === 1) return IDENTITY
    const ratio = scale / current.scale
    return {
        scale,
        tx: p.x - (p.x - current.tx) * ratio,
        ty: p.y - (p.y - current.ty) * ratio,
    }
}

/**
 * 公开文章正文图片灯箱。
 * 防盗链图片（s4key:）在正文里已经渲染成签名 URL，这里直接复用当前 src，
 * 不再走 Plate 自带的 ImagePreview（它拿到的是未签名的原始 url，展示会失败）。
 */
export function ArticleImageLightbox({ image, onClose }: { image: LightboxImage | null; onClose: () => void }) {
    const [transform, setTransform] = React.useState<Transform>(IDENTITY)
    const closeButtonRef = React.useRef<HTMLButtonElement | null>(null)
    const pointersRef = React.useRef(new Map<number, { x: number; y: number }>())
    const gestureRef = React.useRef<{
        startDist: number
        startMid: { x: number; y: number }
        startTransform: Transform
    } | null>(null)
    const panRef = React.useRef<{ x: number; y: number; startTx: number; startTy: number } | null>(null)

    const open = Boolean(image)

    React.useEffect(() => {
        if (!open) return
        setTransform(IDENTITY)
        closeButtonRef.current?.focus()

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.stopPropagation()
                onClose()
            }
        }
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = "hidden"
        window.addEventListener("keydown", onKeyDown, true)
        return () => {
            document.body.style.overflow = previousOverflow
            window.removeEventListener("keydown", onKeyDown, true)
        }
    }, [open, onClose])

    if (!open || !image || typeof document === "undefined") return null

    const viewportCenter = () => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    const pointFromEvent = (event: { clientX: number; clientY: number }) => {
        const center = viewportCenter()
        return { x: event.clientX - center.x, y: event.clientY - center.y }
    }

    const handleWheel = (event: React.WheelEvent) => {
        event.preventDefault()
        const factor = event.deltaY < 0 ? 1.18 : 1 / 1.18
        setTransform((current) => zoomAround(current, current.scale * factor, pointFromEvent(event)))
    }

    const handleDoubleClick = (event: React.MouseEvent) => {
        event.preventDefault()
        setTransform((current) =>
            current.scale > 1 ? IDENTITY : zoomAround(current, DOUBLE_TAP_SCALE, pointFromEvent(event)),
        )
    }

    const handlePointerDown = (event: React.PointerEvent) => {
        // 点在按钮上时不进入手势逻辑：pointer capture 会把后续 click 重定向到
        // overlay 根元素，导致关闭按钮永远收不到点击。
        if ((event.target as HTMLElement).closest("button")) return
        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
        const pointers = [...pointersRef.current.values()]
        let capture = false
        if (pointers.length === 2) {
            const [a, b] = pointers
            gestureRef.current = {
                startDist: Math.hypot(a.x - b.x, a.y - b.y),
                startMid: pointFromEvent({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }),
                startTransform: transform,
            }
            panRef.current = null
            capture = true
        } else if (pointers.length === 1 && transform.scale > 1) {
            panRef.current = {
                x: event.clientX,
                y: event.clientY,
                startTx: transform.tx,
                startTy: transform.ty,
            }
            capture = true
        }
        // 仅在真正开始拖拽/捏合时捕获指针；未缩放时不捕获，保证遮罩单击关闭可用。
        if (capture) {
            ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
        }
    }

    const handlePointerMove = (event: React.PointerEvent) => {
        if (!pointersRef.current.has(event.pointerId)) return
        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
        const pointers = [...pointersRef.current.values()]

        const gesture = gestureRef.current
        if (pointers.length === 2 && gesture) {
            const [a, b] = pointers
            const dist = Math.hypot(a.x - b.x, a.y - b.y)
            if (gesture.startDist > 0) {
                const nextScale = gesture.startTransform.scale * (dist / gesture.startDist)
                setTransform(zoomAround(gesture.startTransform, nextScale, gesture.startMid))
            }
            return
        }

        const pan = panRef.current
        if (pointers.length === 1 && pan) {
            setTransform((current) => ({
                scale: current.scale,
                tx: pan.startTx + (event.clientX - pan.x),
                ty: pan.startTy + (event.clientY - pan.y),
            }))
        }
    }

    const handlePointerEnd = (event: React.PointerEvent) => {
        pointersRef.current.delete(event.pointerId)
        if (pointersRef.current.size < 2) gestureRef.current = null
        if (pointersRef.current.size === 0) panRef.current = null
    }

    const zoomed = transform.scale > 1

    return createPortal(
        <div
            role="dialog"
            aria-modal="true"
            aria-label={image.alt ? `图片预览：${image.alt}` : "图片预览"}
            className="fixed inset-0 z-[100] flex items-center justify-center motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
            style={{ touchAction: "none" }}
            onWheel={handleWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onDoubleClick={handleDoubleClick}
            onContextMenu={(event) => event.preventDefault()}
        >
            {/* 遮罩：单击关闭 */}
            <div className="absolute inset-0 bg-black/85" onClick={onClose} />

            <img
                src={image.src}
                alt={image.alt}
                draggable={false}
                className={cn(
                    "relative max-h-[92vh] max-w-[94vw] select-none rounded-sm object-contain shadow-2xl",
                    zoomed ? "cursor-grab" : "cursor-zoom-in",
                )}
                style={{
                    transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`,
                    transition: pointersRef.current.size > 0 ? "none" : "transform 200ms ease-out",
                }}
            />

            {image.alt ? (
                <p className="pointer-events-none absolute bottom-5 left-1/2 max-w-[80vw] -translate-x-1/2 truncate text-center text-sm text-white/75">
                    {image.alt}
                </p>
            ) : null}

            <button
                ref={closeButtonRef}
                type="button"
                aria-label="关闭图片预览"
                onClick={onClose}
                className="absolute right-4 top-4 flex size-11 items-center justify-center rounded-full bg-white/10 text-white/85 backdrop-blur-sm transition-colors hover:bg-white/20 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70"
            >
                <X className="size-5" aria-hidden="true" />
            </button>
        </div>,
        document.body,
    )
}

/**
 * 在正文容器上做事件委托：点击 figure 内的图片时打开灯箱。
 * capture 阶段拦截，避免触发 Plate 自带的 ImagePreview。
 */
export function useArticleImageLightbox(containerRef: React.RefObject<HTMLElement | null>) {
    const [image, setImage] = React.useState<LightboxImage | null>(null)

    React.useEffect(() => {
        const container = containerRef.current
        if (!container) return

        const onClick = (event: MouseEvent) => {
            const target = event.target
            if (!(target instanceof HTMLImageElement) || !target.closest("figure")) return
            const src = target.currentSrc || target.src
            if (!src) return
            event.preventDefault()
            event.stopPropagation()
            setImage({ src, alt: target.alt || "" })
        }

        container.addEventListener("click", onClick, true)
        return () => container.removeEventListener("click", onClick, true)
    }, [containerRef])

    const close = React.useCallback(() => setImage(null), [])

    return { image, close }
}
