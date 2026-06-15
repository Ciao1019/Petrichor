"use client"

import * as React from "react"

import { PixelFlowerLayer, type PixelFlowerDecoration } from "@/features/pages/blog/PixelDecorations"
import { RetypesetSiteFooter, RetypesetSiteHeader, RetypesetSiteNav } from "@/features/pages/blog/RetypesetSiteChrome"
import { publicProjectShowcaseApi, type ProjectItem, type ProjectShowcaseResponse } from "@/lib/api"

import { DateTag, HandStamp, LinkDoodle } from "../about/DeskAccents"

const projectsBackgroundFlowers: PixelFlowerDecoration[] = [
    {
        className: "left-[5%] top-[12%] size-12 opacity-40",
        tone: "red",
        speed: 0.4,
        animationClassName: "blog-float-medium",
    },
    {
        className: "bottom-[12%] right-[6%] size-16 opacity-40",
        tone: "yellow",
        speed: 0.8,
        animationClassName: "blog-float-slow blog-delay-500",
    },
    {
        className: "right-[16%] top-[22%] hidden size-8 opacity-30 md:block",
        tone: "red",
        speed: 1.2,
        animationClassName: "blog-float-fast blog-delay-300",
    },
]

function resolveApiError(error: unknown) {
    return (
        (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
        (error instanceof Error ? error.message : "") ||
        "加载失败"
    )
}

const detailLinkClass =
    "group/link relative inline-flex items-center font-mono text-[0.72rem] underline decoration-transparent underline-offset-4 transition-colors duration-200 hover:decoration-current"

/* 单个项目行：行本身即按钮（整行易点），点开在下方展开「细线便条 + 技术栈 + 圈词 + 链接」。
   展开态由父级持有，确保同一时刻只展开一行。闭合时 inert，避免被裁剪的链接进入 Tab 顺序。 */
function ProjectRow({
    item,
    dateTilt,
    open,
    onToggle,
}: {
    item: ProjectItem
    dateTilt: string
    open: boolean
    onToggle: () => void
}) {
    const panelId = `proj-${item.name.replace(/\W+/g, "-")}`
    const hasDetail = Boolean(item.blurb || item.stack.length > 0 || item.stamp || item.repoUrl || item.siteUrl)

    return (
        <li className="border-t first:border-t-0" style={{ borderColor: "var(--desk-sheet-hair)" }}>
            <button
                type="button"
                aria-expanded={hasDetail ? open : undefined}
                aria-controls={hasDetail ? panelId : undefined}
                onClick={hasDetail ? onToggle : undefined}
                className={`group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-3 text-left ${hasDetail ? "cursor-pointer" : "cursor-default"}`}
            >
                <span
                    className={`min-w-0 text-[1.05rem] leading-snug underline decoration-transparent underline-offset-4 transition-colors duration-200 ${hasDetail ? "group-hover:decoration-[#26221c66]" : ""}`}
                    style={{ color: "var(--desk-sheet-ink)" }}
                >
                    {item.name}
                </span>
                {item.year ? <DateTag tilt={dateTilt}>{item.year}</DateTag> : <span />}
            </button>

            {hasDetail ? (
                <div id={panelId} className={`desk-fold ${open ? "open" : ""}`} inert={!open}>
                    <div>
                        <div className="mb-3 mt-1">
                            {item.blurb ? (
                                <p
                                    className="desk-framed-note py-2.5 font-mono text-[0.78rem] font-medium leading-[1.6]"
                                    style={{ color: "var(--desk-sheet-soft)" }}
                                >
                                    {item.blurb}
                                </p>
                            ) : null}
                            <div className="mt-2.5 flex items-center gap-3">
                                {item.stack.length > 0 ? (
                                    <span
                                        className="min-w-0 truncate font-mono text-[0.7rem]"
                                        style={{ color: "var(--desk-sheet-muted)" }}
                                    >
                                        {item.stack.join("  ·  ")}
                                    </span>
                                ) : null}
                                <span className="ml-auto flex shrink-0 items-center gap-4 pr-2">
                                    {item.stamp ? <HandStamp color={item.stampColor}>{item.stamp}</HandStamp> : null}
                                    {item.siteUrl ? (
                                        <a
                                            href={item.siteUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className={detailLinkClass}
                                            style={{ color: "var(--desk-sheet-soft)" }}
                                        >
                                            Website
                                            <LinkDoodle />
                                        </a>
                                    ) : null}
                                    {item.repoUrl ? (
                                        <a
                                            href={item.repoUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className={detailLinkClass}
                                            style={{ color: "var(--desk-sheet-soft)" }}
                                        >
                                            GitHub
                                            <LinkDoodle />
                                        </a>
                                    ) : null}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}
        </li>
    )
}

function ProjectListSkeleton() {
    const widths = ["w-1/2", "w-2/3", "w-2/5"]
    return (
        <ul className="mt-6" aria-hidden="true">
            {widths.map((width, index) => (
                <li
                    key={index}
                    className="border-t py-3 first:border-t-0"
                    style={{ borderColor: "var(--desk-sheet-hair)" }}
                >
                    <div className="flex items-center justify-between gap-4">
                        <div className={`h-4 ${width} animate-pulse rounded`} style={{ background: "var(--desk-sheet-hair)" }} />
                        <div className="h-4 w-10 animate-pulse rounded" style={{ background: "var(--desk-sheet-hair)" }} />
                    </div>
                </li>
            ))}
        </ul>
    )
}

export function ProjectsPage() {
    const [showcase, setShowcase] = React.useState<ProjectShowcaseResponse | null>(null)
    const [loading, setLoading] = React.useState(true)
    const [error, setError] = React.useState<string | null>(null)
    const [openName, setOpenName] = React.useState<string | null>(null)
    const [parallax, setParallax] = React.useState({ x: 0, y: 0 })

    const fetchShowcase = React.useCallback(async (isCanceled: () => boolean = () => false) => {
        setLoading(true)
        setError(null)
        try {
            const res = await publicProjectShowcaseApi.detail()
            if (isCanceled()) return
            setShowcase(res.data)
        } catch (e: unknown) {
            if (isCanceled()) return
            setError(resolveApiError(e))
        } finally {
            if (isCanceled()) return
            setLoading(false)
        }
    }, [])

    React.useEffect(() => {
        let canceled = false
        void fetchShowcase(() => canceled)
        return () => {
            canceled = true
        }
    }, [fetchShowcase])

    const handlePointerMove = React.useCallback((event: React.PointerEvent<HTMLElement>) => {
        if (event.pointerType === "touch") return
        const rect = event.currentTarget.getBoundingClientRect()
        setParallax({
            x: (rect.width / 2 - (event.clientX - rect.left)) / 80,
            y: (rect.height / 2 - (event.clientY - rect.top)) / 80,
        })
    }, [])

    const resetParallax = React.useCallback(() => setParallax({ x: 0, y: 0 }), [])

    return (
        <main
            className="scrollbar-hide retypeset-home relative flex min-h-screen flex-col overflow-hidden bg-[#0044cc] font-mono text-white selection:bg-yellow-300 selection:text-blue-950"
            onPointerMove={handlePointerMove}
            onPointerLeave={resetParallax}
        >
            <div className="blog-home-grid pointer-events-none fixed inset-0 z-0" />
            <PixelFlowerLayer
                flowers={projectsBackgroundFlowers}
                className="fixed inset-0 z-0 overflow-hidden"
                parallax={parallax}
            />

            <div className="relative z-30 mx-auto w-full max-w-6xl px-6 pt-8 md:px-24 lg:contents">
                <RetypesetSiteHeader dockVisible />
                <RetypesetSiteNav activeSection="projects" dockVisible />
            </div>

            <section className="relative z-20 mx-auto flex w-full max-w-[51.462rem] flex-1 flex-col px-[min(7.25vw,3.731rem)] py-12 lg:mx-[max(5.75rem,calc(50vw-34.25rem))] lg:max-w-[min(calc(75vw-16rem),44rem)] lg:px-0">
                <div
                    className="blog-home-fade-in relative w-full rounded-2xl px-6 py-8 shadow-2xl sm:px-9 sm:py-10"
                    style={{ background: "var(--desk-sheet)", color: "var(--desk-sheet-ink)" }}
                >
                    <h1 className="text-2xl font-bold tracking-tight sm:text-3xl" style={{ color: "var(--desk-sheet-ink)" }}>
                        {showcase?.heading ?? "开源项目"}
                    </h1>
                    {showcase?.intro ? (
                        <p className="mt-2 max-w-prose text-[0.85rem] leading-relaxed" style={{ color: "var(--desk-sheet-soft)" }}>
                            {showcase.intro}
                        </p>
                    ) : null}

                    {loading && !showcase ? (
                        <ProjectListSkeleton />
                    ) : showcase && showcase.items.length > 0 ? (
                        <ul className="mt-6">
                            {showcase.items.map((item, index) => (
                                <ProjectRow
                                    key={item.name || index}
                                    item={item}
                                    dateTilt={index % 2 === 0 ? "-rotate-2" : "rotate-1"}
                                    open={openName === (item.name || String(index))}
                                    onToggle={() =>
                                        setOpenName((current) => {
                                            const id = item.name || String(index)
                                            return current === id ? null : id
                                        })
                                    }
                                />
                            ))}
                        </ul>
                    ) : showcase ? (
                        <p className="mt-8 font-mono text-sm" style={{ color: "var(--desk-sheet-muted)" }}>
                            还没有项目，去后台「开源项目」里添加吧。
                        </p>
                    ) : null}

                    {error ? (
                        <div
                            className="mt-6 flex flex-wrap items-center gap-3 border-l-2 pl-4 text-sm"
                            style={{ borderColor: "var(--desk-marker-red)", color: "var(--desk-sheet-soft)" }}
                        >
                            <span>{error}</span>
                            <button
                                type="button"
                                className="font-bold underline underline-offset-2"
                                style={{ color: "var(--desk-marker-red)" }}
                                onClick={() => void fetchShowcase()}
                            >
                                重新加载
                            </button>
                        </div>
                    ) : null}
                </div>
            </section>

            <div className="relative z-30 mx-auto mt-auto w-full max-w-6xl px-6 pb-8 md:px-24 lg:contents">
                <RetypesetSiteFooter dockVisible />
            </div>
        </main>
    )
}
