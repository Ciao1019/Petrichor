"use client"

import { LockKeyhole } from "@/components/iconimate"

/**
 * 文章列表上的状态徽标（转载 / 内部链接 / 已过期 / 需要密码）。
 *
 * 首页与标签页原本各存了一份完全相同的实现，这里合并为单一来源。
 *
 * 外观复刻自 Astryx Badge 的 pink 变体，但**不引入 Astryx 组件**：
 * 它的根 Theme 会把 data-astryx-theme 同步到 <html>，而 theme-neutral 里
 * 有一段 `@scope([data-astryx-theme=...])` 的排版 reset，会接管全站
 * h1~h6 的字体与颜色——前台的文章标题和右侧 dock 会被一起改掉。
 * 三个小徽标不值得付出这个代价，故改用 .retypeset-status-tag 纯 CSS 实现。
 */

export interface ArticleStatusBadgesCopy {
    repost: string
    internalLink: string
    expired: string
    passwordRequired: string
    expiredTitle: (date: string | null) => string
}

export interface ArticleStatusBadgesArticle {
    isRepost?: boolean
    isInternalLink?: boolean
    expired?: boolean
    hasPassword?: boolean
    expiresAt?: string | null
}

export function ArticleStatusBadges({
    article,
    copy,
    formatDate,
}: {
    article: ArticleStatusBadgesArticle
    copy: ArticleStatusBadgesCopy
    /** 过期时间的展示格式由调用方决定 */
    formatDate: (value: string) => string
}) {
    if (!article.isRepost && !article.isInternalLink && !article.expired && !article.hasPassword) {
        return null
    }

    return (
        <span className="ml-2 inline-flex translate-y-[-0.12em] items-center gap-1 align-middle">
            {article.isRepost ? (
                <span className="retypeset-status-tag" title={copy.repost}>
                    {copy.repost}
                </span>
            ) : null}
            {article.isInternalLink ? (
                <span className="retypeset-status-tag" title={copy.internalLink}>
                    {copy.internalLink}
                </span>
            ) : null}
            {article.expired ? (
                <span
                    className="retypeset-status-tag"
                    title={copy.expiredTitle(article.expiresAt ? formatDate(article.expiresAt) : null)}
                >
                    {copy.expired}
                </span>
            ) : null}
            {article.hasPassword ? (
                <span
                    className="retypeset-lock-tag"
                    aria-label={copy.passwordRequired}
                    title={copy.passwordRequired}
                >
                    <LockKeyhole className="size-3" aria-hidden="true" />
                    <span className="sr-only">{copy.passwordRequired}</span>
                </span>
            ) : null}
        </span>
    )
}
