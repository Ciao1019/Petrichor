"use client"

import * as React from "react"
import { useNavigate } from "react-router-dom"

import { SiteGraphExplorer } from "@/components/site-graph/SiteGraphExplorer"
import { RetypesetSiteHeader, RetypesetSiteNav } from "@/features/pages/blog/RetypesetSiteChrome"
import { publicSiteGraphApi, type SiteGraphPayload } from "@/lib/api"

const siteGraphCopy = {
    title: "全站星图",
    intro: "把公开文章、分类、标签，以及 AI 抽取出的概念与实体连成一张网。点一下看详情，双击进入页面。",
    loading: "正在加载全站星图…",
    empty: "全站星图还没有发布内容。",
    loadFailed: "星图加载失败",
    retry: "重新加载",
} as const

function resolveApiError(error: unknown) {
    return (
        (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
        (error instanceof Error ? error.message : "") ||
        "加载失败"
    )
}

function formatGeneratedAt(value: string | null) {
    if (!value) return null
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return null
    return date.toLocaleString()
}

/** 站内路径走 SPA 路由；外部或非 /p/ 内链需要整页跳转 */
function isSpaRoute(route: string) {
    return route.startsWith("/p/") || route === "/" || route.startsWith("/tags")
}

export function SiteGraphPage() {
    const navigate = useNavigate()
    const [payload, setPayload] = React.useState<SiteGraphPayload | null>(null)
    const [loading, setLoading] = React.useState(true)
    const [error, setError] = React.useState<string | null>(null)

    const fetchGraph = React.useCallback(async (isCanceled: () => boolean = () => false) => {
        setLoading(true)
        setError(null)
        try {
            const res = await publicSiteGraphApi.detail()
            if (isCanceled()) return
            setPayload(res.data)
        } catch (e: unknown) {
            if (isCanceled()) return
            setPayload(null)
            setError(resolveApiError(e))
        } finally {
            if (!isCanceled()) setLoading(false)
        }
    }, [])

    React.useEffect(() => {
        let canceled = false
        void fetchGraph(() => canceled)
        return () => {
            canceled = true
        }
    }, [fetchGraph])

    const handleNavigate = React.useCallback((route: string) => {
        if (isSpaRoute(route)) {
            navigate(route)
            return
        }
        window.location.assign(route)
    }, [navigate])

    const generatedAt = formatGeneratedAt(payload?.generatedAt ?? null)

    let content: React.ReactNode
    if (loading) {
        content = <p className="py-16 text-center text-sm opacity-80">{siteGraphCopy.loading}</p>
    } else if (error) {
        content = (
            <div className="py-16 text-center">
                <p className="text-sm font-semibold">{siteGraphCopy.loadFailed}</p>
                <p className="mt-1 text-xs opacity-80">{error}</p>
                <button
                    type="button"
                    className="retypeset-highlight-hover retypeset-font-navbar mt-3 py-1 text-sm font-semibold"
                    onClick={() => void fetchGraph()}
                >
                    {siteGraphCopy.retry}
                </button>
            </div>
        )
    } else if (!payload || payload.nodes.length === 0) {
        content = <p className="py-16 text-center text-sm opacity-80">{siteGraphCopy.empty}</p>
    } else {
        content = (
            // 必须给定高度而不是 min-height：点群舞台是绝对定位的，自身不产生高度，
            // 容器高度靠这里一次性定死，避免又退回到靠内容撑开
            <div className="flex h-[78vh] min-h-[28rem] flex-col text-foreground">
                <SiteGraphExplorer payload={payload} onNavigate={handleNavigate} />
            </div>
        )
    }

    return (
        <main className="scrollbar-hide retypeset-home relative flex min-h-screen flex-col overflow-hidden bg-[#0044cc] text-white selection:bg-yellow-300 selection:text-blue-950">
            <div className="blog-home-grid pointer-events-none fixed inset-0 z-0" />

                <div className="relative z-30 mx-auto w-full max-w-[51.462rem] px-[min(7.25vw,3.731rem)] pt-10 lg:contents">
                <RetypesetSiteHeader dockVisible />
                <RetypesetSiteNav activeSection="graph" dockVisible />
            </div>

            <section className="site-graph-section relative z-20 mx-auto flex w-full max-w-[72rem] flex-1 flex-col px-[min(7.25vw,3.731rem)] py-12 lg:py-20">
                <div className="blog-home-fade-in retypeset-decorative-line" aria-hidden="true" />
                <header className="blog-home-fade-in blog-delay-300 mb-6">
                    <h1 className="retypeset-font-title text-2xl font-bold">{siteGraphCopy.title}</h1>
                    <p className="mt-2 max-w-2xl text-sm leading-relaxed opacity-85">{siteGraphCopy.intro}</p>
                    {generatedAt ? (
                        <p className="mt-1 text-xs opacity-70">更新于 {generatedAt}</p>
                    ) : null}
                </header>
                <div className="blog-home-fade-in blog-delay-500 flex min-h-0 flex-1 flex-col">
                    {content}
                </div>
            </section>

        </main>
    )
}
