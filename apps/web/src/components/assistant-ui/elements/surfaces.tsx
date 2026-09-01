"use client"

import type { ComponentProps } from "react"
import { useLayoutEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"

/**
 * assistant-ui Elements 的共享表面（来自 registry: elements-surfaces）。
 *
 * 只保留 tool-timeline 实际用到的两个组件。上游还带十几个样式 token（paper /
 * floating / field / inkButton…），本项目已有自己的设计令牌，照搬只会多出一套并行
 * 的视觉语言。上游的 collapsePanel 依赖 Base UI Collapsible 的 data 属性，本项目
 * 用的是 Radix，因此没有搬——折叠动画在 tool-timeline 里按 Radix 约定写。
 */

/** shimmer 类来自 tw-shimmer（globals.css 已 @import）。 */
export function ShimmerLabel({
    active = true,
    className,
    ...props
}: ComponentProps<"span"> & { active?: boolean }) {
    return (
        <span
            className={cn(active && "shimmer motion-reduce:animate-none", className)}
            {...props}
        />
    )
}

const labelSwap
    = "col-start-1 row-start-1 flex w-max items-center gap-1.5 leading-none transition-[opacity,filter] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"

const labelSwapIn = "opacity-100 blur-none"

const labelSwapOut = "pointer-events-none select-none opacity-0 blur-[2px]"

/**
 * 两层文案交叉淡入，并把容器宽度动画到当前层的实测宽度。
 * 两层都常驻 DOM（靠 opacity 切换），否则宽度过渡没有可测量的目标。
 */
export function SwapLabel({
    active,
    children,
    className,
}: {
    active: 0 | 1
    children: [React.ReactNode, React.ReactNode]
    className?: string
}) {
    const layers = [useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null)]
    const [width, setWidth] = useState<number | null>(null)

    useLayoutEffect(() => {
        const target = layers[active]?.current
        if (!target) return undefined
        const measure = () => setWidth(Math.ceil(target.getBoundingClientRect().width))
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(target)
        return () => observer.disconnect()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active])

    return (
        <span
            style={width === null ? undefined : { width }}
            className={cn(
                "grid overflow-x-clip transition-[width] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
                className,
            )}
        >
            {children.map((layer, index) => (
                <span
                    key={index}
                    ref={layers[index]}
                    aria-hidden={active !== index}
                    className={cn(labelSwap, active === index ? labelSwapIn : labelSwapOut)}
                >
                    {layer}
                </span>
            ))}
        </span>
    )
}
