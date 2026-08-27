"use client"

import * as React from "react"

import { RetypesetSiteFooter, RetypesetSiteHeader, RetypesetSiteNav } from "@/features/pages/blog/RetypesetSiteChrome"
import { publicAboutProfileApi, type AboutAccent, type AboutProfileResponse } from "@/lib/api"

import { BlueNote, HandUnderline, MarkerHighlight } from "./DeskAccents"

const fallbackProfile: AboutProfileResponse = {
    displayName: "CiZai",
    roleTitle: "Creative Dev & Visual Artist",
    intro: "我是 CiZai，是一个普普通通的程序员。\n\n目前就职于金山办公\n\n我的兴趣主要在 Coding / AI 方向。\n\n我喜欢 Minecraft。",
    expertise: ["Frontend Architecture", "AI 应用开发", "Knowledge Systems", "Creative Coding"],
    toolkit: ["TypeScript", "React", "Bun", "Vite", "AI", "PostgreSQL", "Minecraft"],
    quote: "Code is just another medium for painting dreams.",
    accents: [
        { phrase: "CiZai", style: "red", note: "yep, that's me" },
        { phrase: "程序员", style: "green", note: "just a dev" },
        { phrase: "金山办公", style: "blue", note: "where I work" },
        { phrase: "Coding / AI", style: "green", note: "my playground" },
        { phrase: "Minecraft", style: "blue", note: "★ my comfort game" },
    ],
    contactText: "想聊点什么？随时",
    contactLabel: "message me",
    contactHref: "mailto:zang@linux.do",
}

/* 用「关于我」配置里的注记表，把一段正文切成「普通片段 + 被包裹的点缀片段」：
   style 为 red/green/blue 时画手绘波浪下划线，yellow 时画荧光笔高亮，note 非空则
   附悬停浮出的手写小气泡。先按短语长度降序，确保较长短语优先匹配，避免被子串截断。
   注记内容全部来自后台「关于我配置」，正文里没出现的短语会被安静跳过。 */
function decorateIntro(text: string, accents: AboutAccent[]): React.ReactNode[] {
    if (accents.length === 0) return [text]
    const phrases = accents
        .map((accent) => accent.phrase)
        .sort((a, b) => b.length - a.length)
        .map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    const pattern = new RegExp(`(${phrases.join("|")})`)
    return text.split(pattern).map((part, index) => {
        const accent = accents.find((item) => item.phrase === part)
        if (!accent) return <React.Fragment key={index}>{part}</React.Fragment>
        if (accent.style === "yellow") {
            return (
                <MarkerHighlight key={index} note={accent.note}>
                    {part}
                </MarkerHighlight>
            )
        }
        return (
            <HandUnderline key={index} color={accent.style} note={accent.note}>
                {part}
            </HandUnderline>
        )
    })
}

function resolveApiError(error: unknown) {
    return (
        (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
        (error instanceof Error ? error.message : "") ||
        "加载失败"
    )
}

function PixelAvatar() {
    return (
        <img
            src="/about-avatar.png"
            alt="头像"
            className="relative z-10 h-full w-full rounded-md object-cover drop-shadow-[0_0_15px_rgba(255,255,255,0.22)]"
            loading="lazy"
            decoding="async"
        />
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

            <div className="relative z-30 mx-auto w-full max-w-6xl px-6 pt-8 md:px-24 lg:contents">
                <RetypesetSiteHeader dockVisible />
                <RetypesetSiteNav activeSection="about" dockVisible />
            </div>

            <section className="relative z-20 mx-auto flex w-full max-w-[51.462rem] flex-1 flex-col px-[min(7.25vw,3.731rem)] py-12 lg:mx-[max(5.75rem,calc(50vw-34.25rem))] lg:max-w-[min(calc(75vw-16rem),44rem)] lg:px-0">
                {/* 两列按内容定宽：原来是 grid-cols-12 + gap-12，11 个间隙吃掉大半宽度，
                    col-span-4 只剩约 200px，而头像框写死 320px，会溢出压住右侧正文。 */}
                <div className="grid w-full grid-cols-1 items-start gap-10 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] md:gap-12">
                    <aside className="blog-home-fade-in flex flex-col items-center md:items-start">
                        {/* 用 aspect-square + w-full 让头像跟随列宽收缩，不再写死尺寸 */}
                        <div className="group relative flex aspect-square w-full max-w-64 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-white/5 p-4 shadow-2xl">
                            <div className="absolute inset-0 bg-yellow-300/5 opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
                            <PixelAvatar />
                        </div>
                        <div className="mt-8 text-center md:text-left">
                            <h1 className="break-words text-2xl font-bold uppercase">{profile.displayName}</h1>
                            <p className="mt-2 text-xs font-bold uppercase text-yellow-300">{profile.roleTitle}</p>
                        </div>
                    </aside>

                    <div className="blog-home-fade-in blog-delay-300 flex min-w-0 flex-col gap-12">
                        <section aria-labelledby="about-story-heading">
                            {/* 正文列变窄后 7xl 会顶出列宽，降一档并允许换行 */}
                            <h2 id="about-story-heading" className="mb-6 break-words font-serif text-4xl italic sm:text-5xl md:text-6xl">
                                The Story
                            </h2>
                            <div className="max-w-2xl space-y-6 text-sm leading-relaxed text-white/90 md:text-base">
                                {loading ? (
                                    <AboutStoryLoadingSkeleton />
                                ) : (
                                    introParagraphs.map((paragraph) => (
                                        <p key={paragraph}>{decorateIntro(paragraph, profile.accents ?? [])}</p>
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

                        <div className="mt-4 max-w-xl">
                            <BlueNote>
                                <span className="block break-words italic">"{profile.quote}"</span>
                                {(() => {
                                    const hasLink = Boolean(profile.contactLabel && profile.contactHref)
                                    if (!profile.contactText && !hasLink) return null
                                    return (
                                        <span className="mt-2.5 block not-italic">
                                            {profile.contactText}
                                            {profile.contactText && hasLink ? " " : ""}
                                            {hasLink ? (
                                                <a
                                                    href={profile.contactHref}
                                                    className="font-semibold underline underline-offset-2"
                                                >
                                                    {profile.contactLabel}
                                                </a>
                                            ) : null}
                                        </span>
                                    )
                                })()}
                            </BlueNote>
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
