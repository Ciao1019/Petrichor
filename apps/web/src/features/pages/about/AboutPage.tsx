"use client"

import * as React from "react"

import { PixelFlower, PixelFlowerLayer, type PixelFlowerDecoration } from "@/features/pages/blog/PixelDecorations"
import { RetypesetSiteFooter, RetypesetSiteHeader, RetypesetSiteNav } from "@/features/pages/blog/RetypesetSiteChrome"
import { publicAboutProfileApi, type AboutProfileResponse } from "@/lib/api"

const fallbackProfile: AboutProfileResponse = {
    displayName: "CiZai",
    roleTitle: "Creative Dev & Visual Artist",
    intro: "我是 CiZai，是一个普普通通的程序员。\n\n目前就职于金山办公\n\n我的兴趣主要在 Coding / AI 方向。\n\n我喜欢 Minecraft。",
    expertise: ["Frontend Architecture", "AI 应用开发", "Knowledge Systems", "Creative Coding"],
    toolkit: ["TypeScript", "React", "Next.js", "AI", "PostgreSQL", "Minecraft"],
    quote: "Code is just another medium for painting dreams.",
}

const aboutBackgroundFlowers: PixelFlowerDecoration[] = [
    {
        className: "left-[5%] top-[10%] size-12 opacity-40",
        tone: "red",
        speed: 0.4,
        animationClassName: "blog-float-medium",
    },
    {
        className: "bottom-[10%] right-[5%] size-16 opacity-40",
        tone: "yellow",
        speed: 0.8,
        animationClassName: "blog-float-slow blog-delay-500",
    },
    {
        className: "right-[18%] top-[24%] hidden size-8 opacity-30 md:block",
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

function PixelAvatar() {
    return (
        <svg
            viewBox="0 0 32 32"
            className="blog-pixel-art relative z-10 h-full w-full drop-shadow-[0_0_15px_rgba(255,255,255,0.22)]"
            aria-hidden="true"
            focusable="false"
        >
            <rect x="10" y="6" width="12" height="14" fill="#FFDBAC" />
            <rect x="8" y="4" width="16" height="8" fill="#4B3621" />
            <rect x="6" y="8" width="4" height="12" fill="#4B3621" />
            <rect x="22" y="8" width="4" height="12" fill="#4B3621" />
            <rect x="11" y="10" width="3" height="2" fill="#000000" />
            <rect x="18" y="10" width="3" height="2" fill="#000000" />
            <rect x="14" y="15" width="4" height="2" fill="#E2725B" />
            <rect x="8" y="20" width="16" height="10" fill="#003399" />
            <rect x="14" y="20" width="4" height="10" fill="#FFD700" />
        </svg>
    )
}

function ProfileList({ items }: { items: string[] }) {
    return (
        <ul className="space-y-3 text-sm">
            {items.map((item) => (
                <li key={item} className="group flex items-center gap-3">
                    <span className="text-yellow-300 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true">
                        ✦
                    </span>
                    <span>{item}</span>
                </li>
            ))}
        </ul>
    )
}

function AboutStoryLoadingSkeleton() {
    return (
        <div
            className="public-article public-article--retypeset space-y-4"
            role="status"
            aria-label="关于页内容加载状态"
        >
            <div className="skeleton-bar h-4 w-full" />
            <div className="skeleton-bar h-4 w-11/12" />
            <div className="skeleton-bar h-4 w-4/5" />
            <div className="pt-2">
                <div className="skeleton-bar h-4 w-10/12" />
                <div className="skeleton-bar mt-4 h-4 w-7/12" />
            </div>
        </div>
    )
}

export function AboutPage() {
    const [profile, setProfile] = React.useState<AboutProfileResponse>(fallbackProfile)
    const [loading, setLoading] = React.useState(true)
    const [error, setError] = React.useState<string | null>(null)
    const [parallax, setParallax] = React.useState({ x: 0, y: 0 })

    const fetchProfile = React.useCallback(async (isCanceled: () => boolean = () => false) => {
        setLoading(true)
        setError(null)
        try {
            const res = await publicAboutProfileApi.detail()
            if (isCanceled()) return
            setProfile(res.data)
        } catch (e: unknown) {
            if (isCanceled()) return
            setProfile(fallbackProfile)
            setError(resolveApiError(e))
        } finally {
            if (isCanceled()) return
            setLoading(false)
        }
    }, [])

    React.useEffect(() => {
        let canceled = false
        void fetchProfile(() => canceled)

        return () => {
            canceled = true
        }
    }, [fetchProfile])

    const introParagraphs = React.useMemo(
        () => profile.intro.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean),
        [profile.intro],
    )

    const handlePointerMove = React.useCallback((event: React.PointerEvent<HTMLElement>) => {
        if (event.pointerType === "touch") return

        const rect = event.currentTarget.getBoundingClientRect()
        setParallax({
            x: (rect.width / 2 - (event.clientX - rect.left)) / 80,
            y: (rect.height / 2 - (event.clientY - rect.top)) / 80,
        })
    }, [])

    const resetParallax = React.useCallback(() => {
        setParallax({ x: 0, y: 0 })
    }, [])

    return (
        <main
            className="scrollbar-hide retypeset-home relative flex min-h-screen flex-col overflow-hidden bg-[#0044cc] font-mono text-white selection:bg-yellow-300 selection:text-blue-950"
            onPointerMove={handlePointerMove}
            onPointerLeave={resetParallax}
        >
            <div className="blog-home-grid pointer-events-none fixed inset-0 z-0" />
            <PixelFlowerLayer
                flowers={aboutBackgroundFlowers}
                className="fixed inset-0 z-0 overflow-hidden"
                parallax={parallax}
            />

            <div className="relative z-30 mx-auto w-full max-w-6xl px-6 pt-8 md:px-24 lg:contents">
                <RetypesetSiteHeader dockVisible />
                <RetypesetSiteNav activeSection="about" dockVisible />
            </div>

            <section className="relative z-20 mx-auto flex w-full max-w-[51.462rem] flex-1 flex-col px-[min(7.25vw,3.731rem)] py-12 lg:mx-[max(5.75rem,calc(50vw-34.25rem))] lg:max-w-[min(calc(75vw-16rem),44rem)] lg:px-0">
                <div className="grid w-full grid-cols-1 items-start gap-12 md:grid-cols-12">
                    <aside className="blog-home-fade-in flex flex-col items-center md:col-span-4 md:items-start">
                        <div className="group relative flex size-64 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-white/5 p-4 shadow-2xl md:size-80">
                            <div className="absolute inset-0 bg-yellow-300/5 opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
                            <PixelAvatar />
                            <div className="blog-float-medium blog-delay-300 absolute -bottom-2 -right-2 size-10">
                                <PixelFlower tone="red" />
                            </div>
                        </div>
                        <div className="mt-8 text-center md:text-left">
                            <h1 className="break-words text-2xl font-bold uppercase">{profile.displayName}</h1>
                            <p className="mt-2 text-xs font-bold uppercase text-yellow-300">{profile.roleTitle}</p>
                        </div>
                    </aside>

                    <div className="blog-home-fade-in blog-delay-300 flex flex-col gap-12 md:col-span-8">
                        <section aria-labelledby="about-story-heading">
                            <h2 id="about-story-heading" className="mb-6 font-serif text-5xl italic md:text-7xl">
                                The Story
                            </h2>
                            <div className="max-w-2xl space-y-6 text-sm leading-relaxed text-white/90 md:text-base">
                                {loading ? (
                                    <AboutStoryLoadingSkeleton />
                                ) : (
                                    introParagraphs.map((paragraph) => (
                                        <p key={paragraph}>{paragraph}</p>
                                    ))
                                )}
                            </div>
                            {error ? (
                                <div className="mt-6 flex flex-wrap items-center gap-3 border-l-2 border-yellow-300/70 pl-4 text-sm text-white/80">
                                    <span>{error}</span>
                                    <button
                                        type="button"
                                        className="blog-home-link font-bold text-yellow-300"
                                        onClick={() => void fetchProfile()}
                                    >
                                        重新加载
                                    </button>
                                </div>
                            ) : null}
                        </section>

                        <div className="grid grid-cols-1 gap-12 md:grid-cols-2">
                            <section aria-labelledby="about-expertise-heading">
                                <h3 id="about-expertise-heading" className="mb-6 border-b border-white/10 pb-2 text-xs font-bold uppercase text-yellow-300">
                                    Expertise
                                </h3>
                                <ProfileList items={profile.expertise} />
                            </section>

                            <section aria-labelledby="about-toolkit-heading">
                                <h3 id="about-toolkit-heading" className="mb-6 border-b border-white/10 pb-2 text-xs font-bold uppercase text-yellow-300">
                                    Toolkit
                                </h3>
                                <div className="flex flex-wrap gap-2">
                                    {profile.toolkit.map((item) => (
                                        <span key={item} className="border border-white/10 bg-white/5 px-3 py-1 text-xs font-bold uppercase">
                                            {item}
                                        </span>
                                    ))}
                                </div>
                            </section>
                        </div>

                        <div className="mt-4 flex flex-col items-start justify-between gap-6 rounded-lg border border-dashed border-white/20 bg-white/5 p-6">
                            <p className="break-words text-sm italic text-white/70">"{profile.quote}"</p>
                            <a
                                href="mailto:zang@linux.do"
                                className="bg-[var(--retypeset-highlight)] px-8 py-3 text-sm font-bold uppercase text-blue-950 transition-colors hover:bg-[color-mix(in_oklab,var(--retypeset-highlight)_72%,var(--retypeset-primary)_12%)]"
                            >
                                Let's Chat
                            </a>
                        </div>
                    </div>
                </div>
            </section>

            <div className="relative z-30 mx-auto mt-auto w-full max-w-6xl px-6 pb-8 md:px-24 lg:contents">
                <RetypesetSiteFooter dockVisible />
            </div>
        </main>
    )
}
