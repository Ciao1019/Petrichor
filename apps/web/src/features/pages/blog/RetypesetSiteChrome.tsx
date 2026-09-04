"use client"

import * as React from "react"
import { Github, MessageCircleQuestion, Search } from "@/components/iconimate"
import { Link } from "react-router-dom"

import { BlogSearchDialog, useBlogSearchHotkey } from "@/components/blog-search-dialog"
import { PublicSiteFooter } from "@/components/public-site-footer"
import { StaticNoise } from "@/cuicui/other/creative-effects/animated-noise/static-noise"
import { isDemoOnlyBuild } from "@/lib/demo/demo-mode"

export type RetypesetSiteActiveSection = "articles" | "tags" | "wiki" | "search" | "ask" | "projects" | "petrichor" | "about"
type RetypesetSiteNavSection = RetypesetSiteActiveSection
type RetypesetSiteNavItem = {
    section: RetypesetSiteNavSection
    href: string
    label: string
    internal?: boolean
}

let retypesetScrollbarMounts = 0

const RETYPESET_SCROLLBAR_HIDDEN_CLASS = "retypeset-scrollbar-hidden"
const retypesetSiteCopy = {
    siteTitle: "Petrichor",
    siteSubtitle: "Knowledge, Articles & Inspiration",
    navLabel: "站点导航",
    navPosts: "文章",
    navAsk: "问答",
    navProjects: "开源",
    navPetrichor: "项目",
    navAbout: "关于",
    searchTrigger: "搜索文章",
    githubTrigger: "GitHub 仓库",
} as const

const RETYPESET_SITE_GITHUB_HREF = "https://github.com/Ciao1019/Petrichor"

const retypesetSiteNavItems: RetypesetSiteNavItem[] = [
    { section: "articles", href: "/#articles", label: retypesetSiteCopy.navPosts, internal: true },
    // Wiki 能力保留在服务端，当前不在公开前台展示。
    { section: "projects", href: "/projects", label: retypesetSiteCopy.navProjects, internal: true },
    { section: "petrichor", href: "/petrichor", label: retypesetSiteCopy.navPetrichor, internal: true },
    { section: "about", href: "/about", label: retypesetSiteCopy.navAbout, internal: true },
] as const

function getDockVisibilityClass(dockVisible: boolean) {
    return dockVisible ? "lg:opacity-100" : "lg:pointer-events-none lg:opacity-0"
}

function getChromeLinkClassName(active: boolean) {
    return active
        ? "retypeset-highlight-static retypeset-c-primary font-bold"
        : "retypeset-highlight-hover transition-colors hover:font-bold"
}

function useRetypesetScrollbarVisibility() {
    React.useLayoutEffect(() => {
        const root = document.documentElement
        const body = document.body
        retypesetScrollbarMounts += 1
        root.classList.add(RETYPESET_SCROLLBAR_HIDDEN_CLASS)
        body.classList.add(RETYPESET_SCROLLBAR_HIDDEN_CLASS)

        return () => {
            retypesetScrollbarMounts = Math.max(0, retypesetScrollbarMounts - 1)

            if (retypesetScrollbarMounts === 0) {
                root.classList.remove(RETYPESET_SCROLLBAR_HIDDEN_CLASS)
                body.classList.remove(RETYPESET_SCROLLBAR_HIDDEN_CLASS)
            }
        }
    }, [])
}

export function RetypesetSiteHeader({ dockVisible }: { dockVisible: boolean }) {
    useRetypesetScrollbarVisibility()
    const dockVisibilityClass = getDockVisibilityClass(dockVisible)

    return (
        <div className="retypeset-home contents">
            {/* 噪点纹理：与后台右侧内容区（SidebarInset）同一组件、同一档透明度，
                前台整页铺满故改为 fixed。头部在每个公开页都渲染，挂这里即全站覆盖。 */}
            <StaticNoise opacity={0.08} className="fixed" />

            <header
                className={`${dockVisibilityClass} retypeset-c-secondary mb-[2.625rem] transition-opacity duration-150 lg:fixed lg:right-[max(5rem,calc(50vw-35rem))] lg:top-20 lg:z-30 lg:mb-0 lg:w-56`}
            >
                <h1 className="retypeset-font-title retypeset-c-primary mb-[0.45rem] w-3/4 text-[2rem] font-bold leading-none lg:w-full lg:text-4xl">
                    <span className="box-content inline-block pr-1">
                        <Link id="site-title-link" to="/#articles">
                            {retypesetSiteCopy.siteTitle}
                        </Link>
                    </span>
                </h1>
                <h2 className="retypeset-font-navbar w-3/4 text-sm leading-snug lg:w-full lg:text-base">
                    {retypesetSiteCopy.siteSubtitle}
                </h2>
            </header>
        </div>
    )
}

export function RetypesetSiteNav({
    activeSection,
    dockVisible,
}: {
    activeSection: RetypesetSiteActiveSection
    dockVisible: boolean
}) {
    const dockVisibilityClass = getDockVisibilityClass(dockVisible)
    const [searchOpen, setSearchOpen] = React.useState(false)
    const openSearch = React.useCallback(() => setSearchOpen(true), [])
    useBlogSearchHotkey(openSearch)

    return (
        <div className="retypeset-home contents">
            <div className="mb-[2.625rem] lg:contents" data-public-site-navigation>
                <nav
                    aria-label={retypesetSiteCopy.navLabel}
                    className={`${dockVisibilityClass} retypeset-font-navbar text-[0.9rem] font-semibold leading-[2.45em] transition-opacity duration-150 lg:fixed lg:right-[max(5rem,calc(50vw-35rem))] lg:bottom-[min(calc(9.04rem+3.85vw),12.5rem)] lg:z-30 lg:w-56 lg:text-base`}
                >
                    <ul>
                        {retypesetSiteNavItems.map((item) => {
                            const active = item.section === activeSection
                            const className = getChromeLinkClassName(active)

                            return (
                                <li key={item.href}>
                                    {item.internal ? (
                                        <Link className={className} to={item.href}>
                                            {item.label}
                                        </Link>
                                    ) : (
                                        <a className={className} href={item.href}>
                                            {item.label}
                                        </a>
                                    )}
                                </li>
                            )
                        })}
                        {isDemoOnlyBuild() ? (
                            <li className="mt-1">
                                <Link
                                    className="retypeset-highlight-static retypeset-c-primary inline-flex font-bold"
                                    to="/dashboard/knowledge"
                                >
                                    进入后台演示 →
                                </Link>
                            </li>
                        ) : null}
                    </ul>
                    <div className="mt-3 flex items-center gap-3 lg:mt-4">
                        <button
                            type="button"
                            onClick={openSearch}
                            aria-label={retypesetSiteCopy.searchTrigger}
                            title={retypesetSiteCopy.searchTrigger}
                            className="retypeset-c-secondary inline-flex size-7 cursor-pointer items-center justify-center rounded-full"
                        >
                            <Search className="size-4" aria-hidden="true" />
                            <span className="sr-only">{retypesetSiteCopy.searchTrigger}</span>
                        </button>
                        <Link
                            to="/ask"
                            aria-label={retypesetSiteCopy.navAsk}
                            aria-current={activeSection === "ask" ? "page" : undefined}
                            title={retypesetSiteCopy.navAsk}
                            className={`${activeSection === "ask" ? "retypeset-c-primary" : "retypeset-c-secondary"} inline-flex size-7 cursor-pointer items-center justify-center rounded-full transition-colors`}
                        >
                            <MessageCircleQuestion className="size-4" aria-hidden="true" />
                            <span className="sr-only">{retypesetSiteCopy.navAsk}</span>
                        </Link>
                        <a
                            href={RETYPESET_SITE_GITHUB_HREF}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={retypesetSiteCopy.githubTrigger}
                            title={retypesetSiteCopy.githubTrigger}
                            className="retypeset-c-secondary inline-flex size-7 cursor-pointer items-center justify-center rounded-full"
                        >
                            <Github className="size-4" aria-hidden="true" />
                            <span className="sr-only">{retypesetSiteCopy.githubTrigger}</span>
                        </a>
                    </div>
                </nav>
                <PublicSiteFooter
                    className={`${dockVisibilityClass} mt-2 transition-opacity duration-150 lg:fixed lg:right-[max(5rem,calc(50vw-35rem))] lg:bottom-20 lg:z-30 lg:mt-0 lg:w-56`}
                />
            </div>
            <BlogSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
        </div>
    )
}
