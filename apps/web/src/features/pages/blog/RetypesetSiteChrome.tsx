"use client"

import * as React from "react"
import { Search } from "lucide-react"
import { Link } from "react-router-dom"

import { BlogSearchDialog, useBlogSearchHotkey } from "@/components/blog-search-dialog"
import { RetypesetThemeToggle } from "@/features/retypeset-theme/RetypesetThemeToggle"

export type RetypesetSiteActiveSection = "articles" | "tags" | "about"
type RetypesetSiteNavSection = RetypesetSiteActiveSection
type RetypesetSiteNavItem = {
    section: RetypesetSiteNavSection
    href: string
    label: string
    internal?: boolean
}

let retypesetScrollbarMounts = 0

const RETYPESET_SCROLLBAR_HIDDEN_CLASS = "retypeset-scrollbar-hidden"
const RETYPESET_SITE_EMAIL = "zang@linux.do"
const RETYPESET_SITE_RSS_HREF = "/atom.xml"
const RETYPESET_SITE_START_YEAR = 2024

const retypesetSiteCopy = {
    siteTitle: "Petrichor",
    siteSubtitle: "Knowledge, Articles & Inspiration",
    navLabel: "站点导航",
    navPosts: "文章",
    navTags: "标签",
    navAbout: "关于",
    searchTrigger: "搜索文章",
} as const

const retypesetSiteNavItems: RetypesetSiteNavItem[] = [
    { section: "articles", href: "/#articles", label: retypesetSiteCopy.navPosts, internal: true },
    { section: "tags", href: "/tags", label: retypesetSiteCopy.navTags, internal: true },
    { section: "about", href: "/about", label: retypesetSiteCopy.navAbout, internal: true },
] as const

function getDockVisibilityClass(dockVisible: boolean) {
    return dockVisible ? "lg:opacity-100" : "lg:pointer-events-none lg:opacity-0"
}

function getCopyrightYearRange() {
    const currentYear = new Date().getFullYear()
    return RETYPESET_SITE_START_YEAR === currentYear
        ? `${RETYPESET_SITE_START_YEAR}`
        : `${RETYPESET_SITE_START_YEAR}-${currentYear}`
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
            <nav
                aria-label={retypesetSiteCopy.navLabel}
                className={`${dockVisibilityClass} retypeset-font-navbar mb-[2.625rem] text-[0.9rem] font-semibold leading-[2.45em] transition-opacity duration-150 lg:fixed lg:right-[max(5rem,calc(50vw-35rem))] lg:bottom-[min(calc(9.04rem+3.85vw),12.5rem)] lg:z-30 lg:mb-0 lg:w-56 lg:text-base`}
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
                    <RetypesetThemeToggle />
                </div>
            </nav>
            <BlogSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
        </div>
    )
}

export function RetypesetSiteFooter({ dockVisible }: { dockVisible: boolean }) {
    const dockVisibilityClass = getDockVisibilityClass(dockVisible)
    const year = getCopyrightYearRange()

    return (
        <div className="retypeset-home contents">
            <footer
                className={`${dockVisibilityClass} retypeset-font-navbar text-xs leading-[1.25em] transition-opacity duration-150 lg:fixed lg:right-[max(5rem,calc(50vw-35rem))] lg:bottom-20 lg:z-30 lg:w-56 lg:text-sm`}
            >
                <p>
                    <a className="retypeset-highlight-hover retypeset-footer-link py-[0.2rem] transition-colors" href={RETYPESET_SITE_RSS_HREF}>
                        RSS
                    </a>
                    /
                    <a
                        className="retypeset-highlight-hover retypeset-footer-link py-[0.2rem] transition-colors"
                        href={`mailto:${RETYPESET_SITE_EMAIL}`}
                    >
                        Email
                    </a>
                </p>
                <p>© {year} Petrichor</p>
                <p>
                    Powered by{" "}
                    <a
                        className="retypeset-highlight-hover retypeset-footer-link py-[0.2rem] transition-colors"
                        href="https://github.com/LittleBunVerse"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        CiZaii
                    </a>
                </p>
            </footer>
        </div>
    )
}
