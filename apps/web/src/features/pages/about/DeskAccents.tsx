"use client"

/*
 * 桌面注记组件 —— 移植并改写自 Sn0w（github.com/lin-snow）首页的 desk.tsx。
 * 提供三件套：
 *   - HandUnderline  手绘波浪下划线（红/绿/蓝），可附带悬停浮起的注记气泡
 *   - MarkerHighlight 荧光笔涂抹，可附带注记气泡
 *   - BlueNote        蓝色虚线框边注便签（图钉 + 邮票齿边），即用户喜欢的"蓝色部分"
 *
 * 与 Sn0w 原版的区别：原版依赖一套 Tailwind @theme 颜色/字体 token，本仓库没有，
 * 故这里改用内联 style + about-desk.css 里定义的 --desk-* 变量，跨项目即插即用。
 */

import {
    useState,
    type CSSProperties,
    type ReactNode,
} from "react"

const MARKER = {
    red: "var(--desk-marker-red)",
    orange: "var(--desk-marker-orange)",
    green: "var(--desk-marker-green)",
    teal: "var(--desk-marker-teal)",
    blue: "var(--desk-marker-blue)",
    purple: "var(--desk-marker-purple)",
    pink: "var(--desk-marker-pink)",
} as const

export type MarkerColor = keyof typeof MARKER

/* 仅在「真指针」设备上，hover 时通过 bump key 重挂载 SVG 路径来重放描边动画。
   触屏会在点按时合成 mouseenter，重放一条没有注记气泡的孤零零线条、显得半坏，
   故这里忽略触屏，让移动端保持安静的静态页，桌面端才有全部的小惊喜。 */
function useHoverReplay() {
    const [key, setKey] = useState(0)
    const replay = () => {
        if (typeof window !== "undefined" && window.matchMedia?.("(hover: hover)").matches) {
            setKey((k) => k + 1)
        }
    }
    return [key, replay] as const
}

/* 手写边注气泡：默认藏起，悬停其所在短语时从上方浮起并微微转正——
   纸面、马克笔墨、轻微倾斜，像事后补贴上去的一张便利贴。
   父元素必须带 `group/note` 类。 */
function Annotation({ children, stroke }: { children: string; stroke: string }) {
    return (
        <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-full left-1/2 z-40 mb-1.5 -translate-x-1/2 -rotate-2 scale-90 whitespace-nowrap border px-2 py-[3px] text-[0.95rem] font-normal leading-none opacity-0 transition-[opacity,transform] duration-200 group-hover/note:scale-100 group-hover/note:opacity-100"
            style={
                {
                    color: stroke,
                    fontFamily: '"Caveat", ui-sans-serif, cursive',
                    borderColor: `color-mix(in srgb, ${stroke} 55%, transparent)`,
                    backgroundColor: "var(--desk-paper)",
                    // 不规则圆角，读起来像手撕的纸，而非 CSS 胶囊
                    borderRadius: "9px 6px 8px 6px / 6px 8px 6px 9px",
                    boxShadow: "0 1px 1px rgba(0,0,0,0.04), 0 3px 6px rgba(0,0,0,0.09)",
                } as CSSProperties
            }
        >
            {children}
        </span>
    )
}

/* 紧贴文字的波浪马克笔下划线。 */
export function HandUnderline({
    children,
    color = "red",
    note,
}: {
    children: ReactNode
    color?: MarkerColor
    note?: string
}) {
    // bump 这个 key 会重挂载 path，使每次悬停短语时重放一遍描边动画。
    const [trace, reTrace] = useHoverReplay()
    return (
        <span className="group/note relative inline-block whitespace-nowrap" onMouseEnter={reTrace}>
            {children}
            <svg
                viewBox="0 0 120 10"
                preserveAspectRatio="none"
                aria-hidden="true"
                className="absolute -bottom-0.5 left-0 h-[7px] w-full overflow-visible"
            >
                <path
                    key={trace}
                    className={trace === 0 ? "desk-scribble" : "desk-retrace"}
                    d="M2,6 C22,2 40,9 58,5 C78,1 98,9 118,4"
                    fill="none"
                    stroke={MARKER[color]}
                    strokeWidth="2.2"
                    strokeLinecap="round"
                />
            </svg>
            {note && <Annotation stroke={MARKER[color]}>{note}</Annotation>}
        </span>
    )
}

/* 文字背后的荧光笔涂抹——略微倾斜、深浅不匀的一道笔触。 */
export function MarkerHighlight({ children, note }: { children: ReactNode; note?: string }) {
    return (
        <span className="group/note relative inline-block whitespace-nowrap">
            <span
                aria-hidden="true"
                className="absolute inset-x-[-3px] bottom-[2px] top-[38%] -rotate-1"
                style={{
                    background: "color-mix(in srgb, var(--desk-sticky) 82%, transparent)",
                    borderRadius: "6px 4px 7px 3px / 4px 7px 3px 6px",
                }}
            />
            <span className="relative">{children}</span>
            {note && <Annotation stroke="var(--desk-stamp)">{note}</Annotation>}
        </span>
    )
}

/* 手撕黄色便签——年份标签。圆角不规则、轻微倾斜，像别在行尾的小纸条；行 hover 时
   微微浮起并转正（父元素需带 `group` 类）。 */
export function DateTag({ children, tilt }: { children: string; tilt: string }) {
    return (
        <span
            className={`${tilt} desk-sticky-note inline-block shrink-0 px-2 py-[3px] font-mono text-[0.68rem] leading-none tabular-nums transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:rotate-0`}
            style={{ borderRadius: "9px 6px 8px 6px / 6px 8px 6px 9px" }}
        >
            {children}
        </span>
    )
}

/* 手绘马克笔圈词——一圈歪歪扭扭、略微askew 的椭圆描在某个词外，像 sticky 上随手圈的
   "popular / new / WIP"。以传入的马克笔色上墨，文字用手写体。 */
export function HandStamp({ children, color }: { children: string; color: MarkerColor }) {
    return (
        <span
            className="relative inline-flex -rotate-[8deg] items-center justify-center px-3 py-1 text-[0.95rem] leading-none"
            style={{ color: MARKER[color], fontFamily: '"Caveat", ui-sans-serif, cursive' }}
        >
            <svg
                viewBox="0 0 100 44"
                preserveAspectRatio="none"
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 size-full overflow-visible"
            >
                <path
                    d="M15,9 C42,2 72,4 90,12 C100,18 96,31 83,37 C57,45 25,44 10,34 C1,28 4,15 17,8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                />
            </svg>
            <span className="relative">{children}</span>
        </span>
    )
}

/* 链接右上角悬停时画进来的手绘小箭头——"这会跳去某处"的小花字。继承链接 currentColor，
   绝对定位故不挤动布局；父链接需带 `group/link` 类。 */
export function LinkDoodle() {
    return (
        <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="pointer-events-none absolute left-full top-[0.1em] ml-[3px] size-3 -translate-x-1 -rotate-3 overflow-visible opacity-0 transition-all duration-200 group-hover/link:translate-x-0 group-hover/link:opacity-100"
        >
            <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3,12.6 C7,9 10,6 12.7,3.1" />
                <path d="M6.6,2.9 C9.4,2.7 12.4,2.9 12.9,3.2 C13.2,4.2 13.2,7 13,9.4" />
            </g>
        </svg>
    )
}

/* 邮票齿边——贴着便签内缩几像素的一圈细密虚线描边，dash 间距在任意尺寸下保持一致
   （非缩放描边），并以 currentColor 上墨。 */
function DashedFrame() {
    return (
        <svg
            aria-hidden="true"
            preserveAspectRatio="none"
            viewBox="0 0 100 100"
            className="pointer-events-none absolute left-1 top-1 h-[calc(100%-0.5rem)] w-[calc(100%-0.5rem)] overflow-visible opacity-70"
        >
            <rect
                x="0.6"
                y="0.6"
                width="98.8"
                height="98.8"
                rx="4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeDasharray="2 3.5"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
            />
        </svg>
    )
}

/* 把便签"别"在页面上的手绘小图钉。 */
function Pushpin() {
    return (
        <svg
            viewBox="0 0 28 28"
            aria-hidden="true"
            className="absolute -left-2.5 -top-2.5 size-7 -rotate-12 overflow-visible drop-shadow-sm"
        >
            {/* 针 */}
            <path
                d="M13,12 L18.5,23"
                fill="none"
                stroke="var(--desk-stamp)"
                strokeWidth="1.8"
                strokeLinecap="round"
            />
            {/* 钉帽 */}
            <circle
                cx="11"
                cy="9"
                r="6.5"
                fill="var(--desk-marker-red)"
                stroke="var(--desk-paper)"
                strokeWidth="1.4"
            />
            {/* 高光 */}
            <circle cx="8.6" cy="6.8" r="1.7" fill="rgba(255,255,255,0.55)" />
        </svg>
    )
}

/* 蓝色边注便签（"蓝色部分"）——蓝底、邮票齿边、左上角别一枚图钉、整体轻微歪斜，
   像随手贴在页边、补充一句话的小纸条。等宽字体增强"手写注记"的随手感。 */
export function BlueNote({ children }: { children: ReactNode }) {
    return (
        <aside
            className="relative -rotate-[0.6deg] px-4 py-3.5 font-mono text-[0.78rem] leading-relaxed"
            style={{
                background: "var(--desk-note-bg)",
                color: "var(--desk-note-ink)",
                borderRadius: "11px 8px 12px 9px / 8px 12px 9px 11px",
            }}
        >
            <DashedFrame />
            <Pushpin />
            {children}
        </aside>
    )
}
