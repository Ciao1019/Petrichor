"use client"

import type { CSSProperties } from "react"

import { cn } from "@/lib/utils"

export type PixelFlowerTone = "red" | "yellow"

export type PixelFlowerDecoration = {
    className: string
    tone?: PixelFlowerTone
    tall?: boolean
    speed?: number
    animationClassName?: string
    flowerClassName?: string
}

type PixelFlowerProps = {
    tone?: PixelFlowerTone
    tall?: boolean
    className?: string
}

type PixelFlowerLayerProps = {
    flowers: readonly PixelFlowerDecoration[]
    className: string
    parallax?: { x: number; y: number }
    flowerClassName?: string
}

type TitleFlowerProps = {
    variant?: "hero" | "ornament"
    className?: string
    svgClassName?: string
}

const titleFlowerVariantClassNames = {
    hero: "relative mx-1 flex h-[3.5rem] w-8 items-end justify-center sm:h-24 sm:w-11 md:h-28 md:w-12 lg:h-36 lg:w-16",
    ornament: "relative flex h-24 w-10 items-end justify-center sm:h-28 sm:w-12 lg:h-36 lg:w-16",
} as const

export function PixelFlower({ tone = "red", tall = false, className }: PixelFlowerProps) {
    const petal = tone === "red" ? "#ff3333" : "#ffd700"
    const center = tone === "red" ? "#ffd700" : "#8b4513"
    const height = tall ? 20 : 16

    return (
        <svg
            viewBox={`0 0 12 ${height}`}
            className={cn("blog-pixel-art h-full w-full", className)}
            aria-hidden="true"
            focusable="false"
        >
            <rect x="4" y="0" width="4" height="4" fill={petal} />
            <rect x="4" y="8" width="4" height="4" fill={petal} />
            <rect x="0" y="4" width="4" height="4" fill={petal} />
            <rect x="8" y="4" width="4" height="4" fill={petal} />
            <rect x="4" y="4" width="4" height="4" fill={center} />
            <rect x="4" y="12" width="4" height={tall ? "8" : "4"} fill="#228b22" />
            {tall ? <rect x="8" y="14" width="2" height="2" fill="#228b22" /> : null}
        </svg>
    )
}

export function PixelFlowerLayer({
    flowers,
    className,
    parallax,
    flowerClassName,
}: PixelFlowerLayerProps) {
    return (
        <div className={cn("pointer-events-none", className)} aria-hidden="true">
            {flowers.map((flower, index) => {
                const style: CSSProperties | undefined =
                    parallax && typeof flower.speed === "number"
                        ? { transform: `translate(${parallax.x * flower.speed}px, ${parallax.y * flower.speed}px)` }
                        : undefined

                return (
                    <div
                        key={`${flower.tone ?? "red"}-${index}`}
                        className={cn("absolute", flower.className)}
                        style={style}
                    >
                        <div className={flower.animationClassName}>
                            <PixelFlower
                                tone={flower.tone}
                                tall={flower.tall}
                                className={cn(flowerClassName, flower.flowerClassName)}
                            />
                        </div>
                    </div>
                )
            })}
        </div>
    )
}

export function TitleFlower({ variant = "hero", className, svgClassName }: TitleFlowerProps) {
    return (
        <span
            className={cn("pointer-events-none", titleFlowerVariantClassNames[variant], className)}
            aria-hidden="true"
        >
            <svg
                viewBox="0 0 24 60"
                preserveAspectRatio="xMidYMax"
                className={cn("blog-pixel-art h-full w-full overflow-visible", svgClassName)}
                aria-hidden="true"
                focusable="false"
            >
                <rect x="10" y="24" width="4" height="36" fill="#008000" />
                <rect x="6" y="44" width="4" height="4" fill="#006400" />
                <rect x="2" y="40" width="4" height="4" fill="#006400" />
                <rect x="14" y="36" width="4" height="4" fill="#006400" />
                <rect x="18" y="32" width="4" height="4" fill="#006400" />
                <rect x="8" y="8" width="8" height="8" fill="#5c3317" />
                <rect x="8" y="0" width="8" height="8" fill="#ffd700" />
                <rect x="8" y="16" width="8" height="8" fill="#ffd700" />
                <rect x="0" y="8" width="8" height="8" fill="#ffd700" />
                <rect x="16" y="8" width="8" height="8" fill="#ffd700" />
                <rect x="4" y="4" width="4" height="4" fill="#ffd700" opacity="0.8" />
                <rect x="16" y="4" width="4" height="4" fill="#ffd700" opacity="0.8" />
                <rect x="4" y="16" width="4" height="4" fill="#ffd700" opacity="0.8" />
                <rect x="16" y="16" width="4" height="4" fill="#ffd700" opacity="0.8" />
            </svg>
        </span>
    )
}
