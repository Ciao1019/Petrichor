"use client"

import * as React from "react"
import { Link } from "react-router-dom"

import { publicArticleShareApi, type PublicArticleListItem } from "@/lib/api"
import { ArticleStatusBadges } from "@/features/pages/blog/ArticleStatusBadges"
import { RetypesetSiteHeader, RetypesetSiteNav } from "@/features/pages/blog/RetypesetSiteChrome"
import { usePublicPageMeta } from "@/features/pages/public-page-meta"

type HomepageArticle = PublicArticleListItem

type ArticleYearGroup = {
    year: string
    articles: HomepageArticle[]
}

const articleIndexCopy = {
    loadFailed: "文章索引加载失败",
    retry: "重新加载",
    empty: "文章正在整理中。",
    repost: "转载",
    internalLink: "内部链接",
    pinnedSection: "置顶",
    expired: "已过期",
    passwordRequired: "需要访问密码",
    readArticleLabel: (title: string) => `阅读文章：${title}`,
    readingTime: (minutes: number) => `${minutes} min`,
    expiredTitle: (date: string | null) => (date ? `已过期：${date}` : "已过期"),
} as const

type ArticleIndexCopy = typeof articleIndexCopy

const PINNED_GROUP_KEY = "__pinned__"

function groupArticlesByYear(articles: readonly HomepageArticle[]): ArticleYearGroup[] {
    const pinned: HomepageArticle[] = []
    const others: HomepageArticle[] = []
    for (const article of articles) {
        if (article.isPinned) pinned.push(article)
        else others.push(article)
    }
    pinned.sort((left, right) => {
        const leftOrder = left.pinOrder ?? 0
        const rightOrder = right.pinOrder ?? 0
        if (leftOrder !== rightOrder) return rightOrder - leftOrder
        return right.updatedAt.localeCompare(left.updatedAt)
    })
    others.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

    const groups: ArticleYearGroup[] = []
    if (pinned.length > 0) groups.push({ year: PINNED_GROUP_KEY, articles: pinned })

    const yearMap = new Map<string, HomepageArticle[]>()
    for (const article of others) {
        const year = article.updatedAt.slice(0, 4)
        const group = yearMap.get(year)
        if (group) group.push(article)
        else yearMap.set(year, [article])
    }
    for (const [year, groupedArticles] of yearMap) groups.push({ year, articles: groupedArticles })
    return groups
}

function getArticleDatePart(value: string) {
    const [datePart] = value.split("T")
    return datePart || value
}

function formatArticleDate(value: string) {
    const datePart = getArticleDatePart(value)
    const [year, month, day] = datePart.split("-")
    return year && month && day ? `${year}-${month}-${day}` : value
}

/** 仅文章详情页走 SPA 路由；其余内链（如转载直跳的自托管 HTML）需要整页加载。 */
function isSpaArticleHref(href: string) {
    return href.startsWith("/p/")
}

function ArticleListItem({ article, copy }: { article: HomepageArticle; copy: ArticleIndexCopy }) {
    const date = formatArticleDate(article.updatedAt)
    const linkClassName = "break-words lg:text-[1.125rem] lg:font-medium"
    const handlePrefetchDetail = React.useCallback(() => {
        if (article.expired || article.hasPassword || !article.shareCode) return
        if (!article.href || !isSpaArticleHref(article.href)) return
        void publicArticleShareApi.prefetchDetail(article.shareCode)
    }, [article.expired, article.hasPassword, article.href, article.shareCode])

    return (
        <li className="mb-[1.375rem] lg:mb-10">
            <h3 className="retypeset-post-heading inline">
                {article.href && isSpaArticleHref(article.href) ? (
                    <Link
                        className={linkClassName}
                        to={article.href}
                        aria-label={copy.readArticleLabel(article.title)}
                        onMouseEnter={handlePrefetchDetail}
                        onFocus={handlePrefetchDetail}
                    >
                        {article.title}
                    </Link>
                ) : article.href ? (
                    <a
                        className={linkClassName}
                        href={article.href}
                        aria-label={copy.readArticleLabel(article.title)}
                        onMouseEnter={handlePrefetchDetail}
                        onFocus={handlePrefetchDetail}
                    >
                        {article.title}
                    </a>
                ) : (
                    <span className={linkClassName}>{article.title}</span>
                )}
                <ArticleStatusBadges article={article} copy={copy} formatDate={formatArticleDate} />
            </h3>

            <div className="retypeset-font-time py-[0.2rem] text-sm lg:hidden">
                <time dateTime={getArticleDatePart(article.updatedAt)}>{date}</time>
                <span className="ml-1.5">{copy.readingTime(article.readingMinutes)}</span>
            </div>
            <div className="retypeset-font-time hidden text-[0.9125rem] lg:ml-2.5 lg:inline">
                <time dateTime={getArticleDatePart(article.updatedAt)}>{date}</time>
                <span className="ml-1.5">{copy.readingTime(article.readingMinutes)}</span>
            </div>
            <div className="hidden lg:mt-[0.5625rem] lg:block">
                <p className="break-words leading-7">{article.excerpt}</p>
            </div>
        </li>
    )
}

function ArticleYearSection({ group, copy }: { group: ArticleYearGroup; copy: ArticleIndexCopy }) {
    const isPinnedGroup = group.year === PINNED_GROUP_KEY
    const headingId = `article-year-${isPinnedGroup ? "pinned" : group.year}`

    return (
        <section aria-labelledby={headingId} className="mb-[1.875rem]">
            <div className="retypeset-decorative-line" aria-hidden="true" />
            <h2 id={headingId} className="sr-only">
                {isPinnedGroup ? copy.pinnedSection : group.year}
            </h2>
            <ul>
                {group.articles.map((article) => (
                    <ArticleListItem key={article.shareCode} article={article} copy={copy} />
                ))}
            </ul>
        </section>
    )
}

function useArticleIndexDockVisibility(sectionRef: React.RefObject<HTMLElement | null>) {
    const [dockVisible, setDockVisible] = React.useState(false)

    React.useEffect(() => {
        const updateDockVisibility = () => {
            const section = sectionRef.current
            if (!section) return
            const rect = section.getBoundingClientRect()
            setDockVisible(rect.top <= 160 && rect.bottom >= 160)
        }
        updateDockVisibility()
        window.addEventListener("scroll", updateDockVisibility, { passive: true })
        window.addEventListener("resize", updateDockVisibility)
        return () => {
            window.removeEventListener("scroll", updateDockVisibility)
            window.removeEventListener("resize", updateDockVisibility)
        }
    }, [sectionRef])

    return dockVisible
}

function ArticleIndexFrame({
    dockVisible,
    sectionRef,
    children,
}: {
    dockVisible: boolean
    sectionRef: React.RefObject<HTMLElement | null>
    children: React.ReactNode
}) {
    return (
        <section id="articles" ref={sectionRef} className="retypeset-home relative z-10 min-h-screen overflow-hidden">
            <div className="blog-home-grid pointer-events-none absolute inset-0 z-0" />
            <div className="relative z-10 mx-auto min-h-dvh w-full max-w-[51.462rem] px-[min(7.25vw,3.731rem)] py-10 lg:mx-[max(5.75rem,calc(50vw-34.25rem))] lg:my-20 lg:min-h-full lg:max-w-[min(calc(75vw-16rem),44rem)] lg:p-0">
                <RetypesetSiteHeader dockVisible={dockVisible} />
                <RetypesetSiteNav activeSection="articles" dockVisible={dockVisible} />
                <main id="article-index-list" className="mb-12">
                    {children}
                </main>
            </div>
        </section>
    )
}

function ArticleIndexStatus({ message, detail, action }: { message: string; detail?: string; action?: React.ReactNode }) {
    return (
        <div className="retypeset-font-navbar border-y border-current/10 py-12 text-center">
            <p className="retypeset-c-primary text-base font-semibold">{message}</p>
            {detail ? <p className="mt-3 text-sm leading-6 opacity-75">{detail}</p> : null}
            {action ? <div className="mt-5">{action}</div> : null}
        </div>
    )
}

function ArticleIndexLoadingSkeleton() {
    const groups = [
        ["w-9/12", "w-7/12"],
        ["w-8/12", "w-5/12"],
        ["w-10/12", "w-6/12"],
    ] as const

    return (
        <div
            className="public-article public-article--retypeset animate-in fade-in-0 duration-300"
            role="status"
            aria-label="文章索引加载状态"
        >
            {groups.map((itemWidths, groupIndex) => (
                <section key={`article-index-skeleton-${groupIndex}`} className="mb-[1.875rem]">
                    <div className="retypeset-decorative-line" aria-hidden="true" />
                    <ul>
                        {itemWidths.map((width) => (
                            <li key={`${groupIndex}-${width}`} className="mb-[1.375rem] lg:mb-10">
                                <div className={`skeleton-bar h-6 max-w-full ${width} lg:h-7`} />
                                <div className="mt-3 flex items-center gap-2 lg:hidden">
                                    <div className="skeleton-bar h-3.5 w-24" />
                                    <div className="skeleton-bar h-3.5 w-14" />
                                </div>
                                <div className="hidden lg:mt-4 lg:block">
                                    <div className="skeleton-bar h-3.5 w-full" />
                                    <div className="skeleton-bar mt-3 h-3.5 w-4/5" />
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
        </div>
    )
}

function resolveArticleIndexError(error: unknown) {
    return (
        (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg
        || (error instanceof Error ? error.message : "")
        || "加载失败"
    )
}

function ArticleIndexSection({ initialDockVisible = false }: { initialDockVisible?: boolean }) {
    const sectionRef = React.useRef<HTMLElement | null>(null)
    const cachedArticleList = publicArticleShareApi.getCachedList()
    const [articles, setArticles] = React.useState<HomepageArticle[]>(() => cachedArticleList?.items ?? [])
    const [loading, setLoading] = React.useState(() => !cachedArticleList)
    const [error, setError] = React.useState<string | null>(null)
    const detectedDockVisible = useArticleIndexDockVisibility(sectionRef)
    const [initialDockVisibleActive, setInitialDockVisibleActive] = React.useState(initialDockVisible)
    const dockVisible = initialDockVisibleActive || detectedDockVisible

    React.useEffect(() => {
        if (!initialDockVisible) {
            setInitialDockVisibleActive(false)
            return
        }
        let secondFrame = 0
        const firstFrame = window.requestAnimationFrame(() => {
            secondFrame = window.requestAnimationFrame(() => setInitialDockVisibleActive(false))
        })
        return () => {
            window.cancelAnimationFrame(firstFrame)
            if (secondFrame) window.cancelAnimationFrame(secondFrame)
        }
    }, [initialDockVisible])

    const fetchArticles = React.useCallback(async (isCanceled: () => boolean = () => false) => {
        const cached = publicArticleShareApi.getCachedList()
        if (cached) {
            if (!isCanceled()) {
                setArticles(cached.items ?? [])
                setLoading(false)
                setError(null)
            }
            return
        }
        setLoading(true)
        setError(null)
        try {
            const response = await publicArticleShareApi.list()
            if (!isCanceled()) setArticles(response.data.items ?? [])
        } catch (fetchError: unknown) {
            if (!isCanceled()) {
                setArticles([])
                setError(resolveArticleIndexError(fetchError))
            }
        } finally {
            if (!isCanceled()) setLoading(false)
        }
    }, [])

    React.useEffect(() => {
        let canceled = false
        void fetchArticles(() => canceled)
        return () => { canceled = true }
    }, [fetchArticles])

    const articleYearGroups = React.useMemo(() => groupArticlesByYear(articles), [articles])
    let content: React.ReactNode
    if (loading) content = <ArticleIndexLoadingSkeleton />
    else if (error) {
        content = (
            <ArticleIndexStatus
                message={articleIndexCopy.loadFailed}
                detail={error}
                action={(
                    <button
                        type="button"
                        className="retypeset-highlight-hover retypeset-c-primary retypeset-font-navbar py-1 text-sm font-semibold"
                        onClick={() => void fetchArticles()}
                    >
                        {articleIndexCopy.retry}
                    </button>
                )}
            />
        )
    } else if (articleYearGroups.length === 0) content = <ArticleIndexStatus message={articleIndexCopy.empty} />
    else {
        content = articleYearGroups.map((group) => (
            <ArticleYearSection key={group.year} group={group} copy={articleIndexCopy} />
        ))
    }

    return (
        <ArticleIndexFrame dockVisible={dockVisible} sectionRef={sectionRef}>
            {content}
        </ArticleIndexFrame>
    )
}

export function BlogHomePage() {
    usePublicPageMeta("Petrichor", "Petrichor 知识库与博客平台。", "/")
    return <ArticleIndexSection initialDockVisible />
}
