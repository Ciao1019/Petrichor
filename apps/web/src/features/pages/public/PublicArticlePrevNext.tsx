"use client"

import * as React from "react"
import { Link } from "react-router-dom"

import { publicArticleShareApi, type PublicArticleListItem } from "@/lib/api"

type AdjacentArticles = {
    /** 列表中的上一项（发布更晚，即更新的一篇） */
    prev: PublicArticleListItem | null
    /** 列表中的下一项（发布更早，即更旧的一篇） */
    next: PublicArticleListItem | null
}

function resolveAdjacentArticles(
    items: readonly PublicArticleListItem[],
    shareCode: string,
): AdjacentArticles {
    const readable = items
        .filter((item) => !item.expired && item.href)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    const index = readable.findIndex((item) => item.shareCode === shareCode)
    if (index < 0) return { prev: null, next: null }
    return {
        prev: readable[index - 1] ?? null,
        next: readable[index + 1] ?? null,
    }
}

function formatNavDate(value: string) {
    const [datePart] = value.split("T")
    return datePart || value
}

function PrevNextLink({
    article,
    direction,
}: {
    article: PublicArticleListItem
    direction: "prev" | "next"
}) {
    const handlePrefetch = React.useCallback(() => {
        if (article.hasPassword || !article.shareCode) return
        void publicArticleShareApi.prefetchDetail(article.shareCode)
    }, [article.hasPassword, article.shareCode])

    return (
        <Link
            to={article.href}
            className={`post-nav-link ${direction === "next" ? "post-nav-link--next" : ""}`}
            onMouseEnter={handlePrefetch}
            onFocus={handlePrefetch}
        >
            <span className="post-nav-label">{direction === "prev" ? "← 上一篇" : "下一篇 →"}</span>
            <span className="post-nav-title">{article.title}</span>
            <span className="post-nav-date">
                <time dateTime={formatNavDate(article.updatedAt)}>{formatNavDate(article.updatedAt)}</time>
            </span>
        </Link>
    )
}

/** 文章底部的上一篇 / 下一篇导航。列表加载失败时静默隐藏，不阻塞正文。 */
export function PublicArticlePrevNext({ shareCode }: { shareCode: string | undefined }) {
    const [adjacent, setAdjacent] = React.useState<AdjacentArticles | null>(() => {
        if (!shareCode) return null
        const cached = publicArticleShareApi.getCachedList()
        return cached ? resolveAdjacentArticles(cached.items ?? [], shareCode) : null
    })

    React.useEffect(() => {
        if (!shareCode) {
            setAdjacent(null)
            return
        }
        let canceled = false
        publicArticleShareApi
            .list()
            .then((res) => {
                if (canceled) return
                setAdjacent(resolveAdjacentArticles(res.data.items ?? [], shareCode))
            })
            .catch(() => {
                if (canceled) return
                setAdjacent(null)
            })
        return () => {
            canceled = true
        }
    }, [shareCode])

    if (!adjacent || (!adjacent.prev && !adjacent.next)) return null

    return (
        <nav className="post-nav" aria-label="上一篇与下一篇文章">
            {adjacent.prev ? <PrevNextLink article={adjacent.prev} direction="prev" /> : <span aria-hidden="true" />}
            {adjacent.next ? <PrevNextLink article={adjacent.next} direction="next" /> : <span aria-hidden="true" />}
        </nav>
    )
}
