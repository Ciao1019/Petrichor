import type { PublicArticleListItem } from "@/lib/api"

export type PublicTagGroup = {
    id: string
    name: string
    articleCount: number
    latestUpdatedAt: string
    articles: PublicArticleListItem[]
}

function normalizeTagName(tag: string) {
    return tag.trim()
}

function compareArticlesByUpdatedAt(left: PublicArticleListItem, right: PublicArticleListItem) {
    return right.updatedAt.localeCompare(left.updatedAt)
}

function compareTagGroups(left: PublicTagGroup, right: PublicTagGroup) {
    if (left.articleCount !== right.articleCount) {
        return right.articleCount - left.articleCount
    }

    if (left.latestUpdatedAt !== right.latestUpdatedAt) {
        return right.latestUpdatedAt.localeCompare(left.latestUpdatedAt)
    }

    return left.name.localeCompare(right.name, "zh-Hans-CN")
}

export function buildPublicTagGroups(articles: readonly PublicArticleListItem[]): PublicTagGroup[] {
    const groups = new Map<string, PublicArticleListItem[]>()

    for (const article of articles) {
        const articleTags = new Set((article.tags ?? []).map(normalizeTagName).filter(Boolean))

        for (const tag of articleTags) {
            const groupedArticles = groups.get(tag) ?? []
            groupedArticles.push(article)
            groups.set(tag, groupedArticles)
        }
    }

    return [...groups.entries()]
        .map(([tag, groupedArticles]) => {
            const sortedArticles = [...groupedArticles].sort(compareArticlesByUpdatedAt)

            return {
                id: tag,
                name: tag,
                articleCount: sortedArticles.length,
                latestUpdatedAt: sortedArticles[0]?.updatedAt ?? "",
                articles: sortedArticles,
            }
        })
        .sort(compareTagGroups)
}

export function resolveSelectedPublicTagGroup(groups: readonly PublicTagGroup[], selectedTagId: string) {
    return groups.find((group) => group.id === selectedTagId) ?? groups[0] ?? null
}
