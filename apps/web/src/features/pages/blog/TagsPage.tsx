"use client"

import { LockKeyhole } from "lucide-react"
import * as React from "react"
import { Link } from "react-router-dom"

import { PixelFlowerLayer, type PixelFlowerDecoration } from "@/features/pages/blog/PixelDecorations"
import { RetypesetSiteFooter, RetypesetSiteHeader, RetypesetSiteNav } from "@/features/pages/blog/RetypesetSiteChrome"
import { buildPublicTagGroups, resolveSelectedPublicTagGroup, type PublicTagGroup } from "@/features/pages/blog/tags-page-utils"
import { publicArticleShareApi, type PublicArticleListItem } from "@/lib/api"

const tagsBackgroundFlowers: PixelFlowerDecoration[] = [
    {
        className: "left-[4%] top-[14%] size-10 opacity-35 sm:size-12",
        tone: "yellow",
        speed: 0.45,
        animationClassName: "blog-float-medium",
    },
    {
        className: "right-[12%] top-[18%] hidden size-12 opacity-35 md:block",
        tone: "red",
        speed: 0.75,
        tall: true,
        animationClassName: "blog-float-slow blog-delay-500",
    },
    {
        className: "bottom-[16%] left-[10%] hidden size-8 opacity-30 sm:block",
        tone: "red",
        speed: 0.9,
        animationClassName: "blog-float-fast blog-delay-300",
    },
    {
        className: "bottom-[9%] right-[8%] size-11 opacity-30",
        tone: "yellow",
        speed: 0.55,
        animationClassName: "blog-float-medium blog-delay-700",
    },
]

const tagsPageCopy = {
    loadFailed: "标签加载失败",
    retry: "重新加载",
    empty: "暂无公开文章标签。",
    readArticleLabel: (title: string) => `阅读文章：${title}`,
    readingTime: (minutes: number) => `${minutes} min`,
    repost: "转载",
    expired: "已过期",
    passwordRequired: "需要访问密码",
    expiredTitle: (date: string | null) => (date ? `已过期：${date}` : "已过期"),
} as const

function formatTagDate(value: string) {
    const [datePart] = value.split("T")
    return datePart || value
}

function isInternalPublicHref(href: string) {
    return href.startsWith("/") && !href.startsWith("//")
}

function resolveArticleListError(error: unknown) {
    return (
        (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
        (error instanceof Error ? error.message : "") ||
        "加载失败"
    )
}

function TagsPageChrome({ children }: { children: React.ReactNode }) {
    return (
        <main className="scrollbar-hide retypeset-home relative flex min-h-screen flex-col overflow-hidden bg-[#0044cc] text-white selection:bg-yellow-300 selection:text-blue-950">
            <div className="blog-home-grid pointer-events-none fixed inset-0 z-0" />
            <PixelFlowerLayer
                flowers={tagsBackgroundFlowers}
                className="fixed inset-0 z-0 overflow-hidden"
                flowerClassName="drop-shadow-lg"
            />

            <div className="relative z-30 mx-auto w-full max-w-[51.462rem] px-[min(7.25vw,3.731rem)] pt-10 lg:contents">
                <RetypesetSiteHeader dockVisible />
                <RetypesetSiteNav activeSection="tags" dockVisible />
            </div>

            {children}

            <div className="relative z-30 mx-auto mt-auto w-full max-w-[51.462rem] px-[min(7.25vw,3.731rem)] pb-10 lg:contents">
                <RetypesetSiteFooter dockVisible />
            </div>
        </main>
    )
}

function TagPill({
    group,
    active,
    onSelect,
}: {
    group: PublicTagGroup
    active: boolean
    onSelect: (tagId: string) => void
}) {
    return (
        <button
            type="button"
            className="retypeset-tag-pill"
            aria-pressed={active}
            onClick={() => onSelect(group.id)}
            title={`${group.articleCount} 篇文章`}
        >
            <span className="retypeset-tag-pill-name">{group.name}</span>
        </button>
    )
}

function ArticleStatusBadges({ article }: { article: PublicArticleListItem }) {
    if (!article.isRepost && !article.expired && !article.hasPassword) {
        return null
    }

    return (
        <span className="ml-2 inline-flex translate-y-[-0.12em] items-center gap-1 align-middle">
            {article.isRepost ? (
                <span className="retypeset-status-tag" title={tagsPageCopy.repost}>
                    {tagsPageCopy.repost}
                </span>
            ) : null}
            {article.expired ? (
                <span
                    className="retypeset-status-tag"
                    title={tagsPageCopy.expiredTitle(article.expiresAt ? formatTagDate(article.expiresAt) : null)}
                >
                    {tagsPageCopy.expired}
                </span>
            ) : null}
            {article.hasPassword ? (
                <span
                    className="retypeset-lock-tag"
                    aria-label={tagsPageCopy.passwordRequired}
                    title={tagsPageCopy.passwordRequired}
                >
                    <LockKeyhole className="size-3" aria-hidden="true" />
                    <span className="sr-only">{tagsPageCopy.passwordRequired}</span>
                </span>
            ) : null}
        </span>
    )
}

function TagArticleItem({ article }: { article: PublicArticleListItem }) {
    const date = formatTagDate(article.updatedAt)
    const linkClassName = "retypeset-post-heading break-words tracking-[0.02em] transition-colors"
    const handlePrefetchDetail = React.useCallback(() => {
        if (article.expired || article.hasPassword || !article.shareCode) {
            return
        }

        void publicArticleShareApi.prefetchDetail(article.shareCode)
    }, [article.expired, article.hasPassword, article.shareCode])

    return (
        <li className="mb-[1.375rem] lg:mb-[1.75rem]">
            <h3 className="inline text-[1.06rem] font-medium leading-relaxed lg:text-[1.125rem]">
                {article.href && isInternalPublicHref(article.href) ? (
                    <Link
                        className={linkClassName}
                        to={article.href}
                        aria-label={tagsPageCopy.readArticleLabel(article.title)}
                        onMouseEnter={handlePrefetchDetail}
                        onFocus={handlePrefetchDetail}
                    >
                        {article.title}
                    </Link>
                ) : article.href ? (
                    <a
                        className={linkClassName}
                        href={article.href}
                        aria-label={tagsPageCopy.readArticleLabel(article.title)}
                        onMouseEnter={handlePrefetchDetail}
                        onFocus={handlePrefetchDetail}
                    >
                        {article.title}
                    </a>
                ) : (
                    <span className={linkClassName}>{article.title}</span>
                )}
                <ArticleStatusBadges article={article} />
            </h3>

            {/* 移动端：时间换行 */}
            <div className="retypeset-font-time mt-1 block text-[0.85rem] opacity-70 lg:hidden">
                <time dateTime={date}>{date}</time>
                <span className="ml-2">{tagsPageCopy.readingTime(article.readingMinutes)}</span>
            </div>

            {/* 桌面端：时间紧跟标题 */}
            <span className="retypeset-font-time hidden text-[0.9rem] opacity-70 lg:ml-3 lg:inline">
                <time dateTime={date}>{date}</time>
                <span className="ml-2">{tagsPageCopy.readingTime(article.readingMinutes)}</span>
            </span>
        </li>
    )
}

function TagArticleList({ group }: { group: PublicTagGroup }) {
    return (
        <section aria-label={`标签 ${group.name} 的文章`} className="mt-10 lg:mt-12">
            <div className="retypeset-decorative-line" aria-hidden="true" />
            <ul className="m-0 list-none p-0">
                {group.articles.map((article) => (
                    <TagArticleItem key={article.shareCode} article={article} />
                ))}
            </ul>
        </section>
    )
}

function TagsPageStatus({
    message,
    detail,
    action,
}: {
    message: string
    detail?: string
    action?: React.ReactNode
}) {
    return (
        <div className="retypeset-font-navbar border-y border-current/10 py-12 text-center">
            <p className="retypeset-c-primary text-base font-semibold">{message}</p>
            {detail ? <p className="mt-3 break-words text-sm leading-6 opacity-75">{detail}</p> : null}
            {action ? <div className="mt-5">{action}</div> : null}
        </div>
    )
}

function TagsPageLoadingSkeleton() {
    const tagWidths = ["w-16", "w-20", "w-12", "w-24", "w-14", "w-20", "w-16"] as const
    const articleWidths = ["w-9/12", "w-7/12", "w-10/12", "w-8/12"] as const

    return (
        <div
            className="public-article public-article--retypeset animate-in fade-in-0 duration-300"
            role="status"
            aria-label="标签页加载状态"
        >
            <div className="flex flex-wrap gap-x-5 gap-y-2">
                {tagWidths.map((width, index) => (
                    <div
                        key={`tag-skeleton-${index}`}
                        className={`skeleton-bar h-5 ${width}`}
                    />
                ))}
            </div>

            <section className="mt-10 lg:mt-12">
                <div className="retypeset-decorative-line" aria-hidden="true" />
                <ul className="m-0 list-none space-y-5 p-0">
                    {articleWidths.map((width, index) => (
                        <li key={`tag-article-skeleton-${index}`}>
                            <div className={`skeleton-bar h-5 ${width} max-w-full`} />
                            <div className="skeleton-bar mt-2 h-3 w-24" />
                        </li>
                    ))}
                </ul>
            </section>
        </div>
    )
}

export function TagsPage() {
    const cachedArticleList = publicArticleShareApi.getCachedList()
    const [articles, setArticles] = React.useState<PublicArticleListItem[]>(() => cachedArticleList?.items ?? [])
    const [selectedTagId, setSelectedTagId] = React.useState("")
    const [loading, setLoading] = React.useState(() => !cachedArticleList)
    const [error, setError] = React.useState<string | null>(null)
    const tagGroups = React.useMemo(() => buildPublicTagGroups(articles), [articles])
    const selectedTagGroup = React.useMemo(
        () => resolveSelectedPublicTagGroup(tagGroups, selectedTagId),
        [selectedTagId, tagGroups],
    )

    const fetchArticles = React.useCallback(async (
        isCanceled: () => boolean = () => false,
        options: { forceRefresh?: boolean } = {},
    ) => {
        const cached = options.forceRefresh ? null : publicArticleShareApi.getCachedList()
        if (cached) {
            if (isCanceled()) return
            setArticles(cached.items ?? [])
            setLoading(false)
            setError(null)
            return
        }

        setLoading(true)
        setError(null)
        try {
            const res = await publicArticleShareApi.list({ forceRefresh: Boolean(options.forceRefresh) })
            if (isCanceled()) return
            setArticles(res.data.items ?? [])
        } catch (e: unknown) {
            if (isCanceled()) return
            setArticles([])
            setError(resolveArticleListError(e))
        } finally {
            if (isCanceled()) return
            setLoading(false)
        }
    }, [])

    React.useEffect(() => {
        let canceled = false
        void fetchArticles(() => canceled)

        return () => {
            canceled = true
        }
    }, [fetchArticles])

    React.useEffect(() => {
        if (selectedTagGroup || tagGroups.length === 0) {
            return
        }

        setSelectedTagId(tagGroups[0]?.id ?? "")
    }, [selectedTagGroup, tagGroups])

    let content: React.ReactNode

    if (loading) {
        content = <TagsPageLoadingSkeleton />
    } else if (error) {
        content = (
            <TagsPageStatus
                message={tagsPageCopy.loadFailed}
                detail={error}
                action={
                    <button
                        type="button"
                        className="retypeset-highlight-hover retypeset-c-primary retypeset-font-navbar py-1 text-sm font-semibold transition-colors"
                        onClick={() => void fetchArticles(undefined, { forceRefresh: true })}
                    >
                        {tagsPageCopy.retry}
                    </button>
                }
            />
        )
    } else if (!selectedTagGroup) {
        content = <TagsPageStatus message={tagsPageCopy.empty} />
    } else {
        content = (
            <>
                <div className="blog-home-fade-in blog-delay-300 flex flex-wrap gap-x-5 gap-y-2">
                    {tagGroups.map((group) => (
                        <TagPill
                            key={group.id}
                            group={group}
                            active={group.id === selectedTagGroup.id}
                            onSelect={setSelectedTagId}
                        />
                    ))}
                </div>

                <div className="blog-home-fade-in blog-delay-500">
                    <TagArticleList group={selectedTagGroup} />
                </div>
            </>
        )
    }

    return (
        <TagsPageChrome>
            <section className="relative z-20 mx-auto flex w-full max-w-[51.462rem] flex-1 flex-col px-[min(7.25vw,3.731rem)] py-12 lg:mx-[max(5.75rem,calc(50vw-34.25rem))] lg:max-w-[min(calc(75vw-16rem),44rem)] lg:px-0 lg:py-20">
                <div className="blog-home-fade-in retypeset-decorative-line" aria-hidden="true" />
                {content}
            </section>
        </TagsPageChrome>
    )
}
