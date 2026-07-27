import { createHash } from "node:crypto"
import type { KnowledgeBaseArticleRecord, KnowledgeBaseArticleShareRecord, KnowledgeBaseWikiPageRecord } from "@/server/db/schema"
import { resolvePublicHomepageShareStatus } from "@/server/kb/share-logic"

/** 文章在知识库树中的公开分享状态 */
export type ArticleTreeShareStatus = "none" | "public" | "password" | "expired"

/** 文章在 LLM Wiki 中的编译状态：未收录 / 已同步 / 源文已变待更新 */
export type ArticleTreeWikiStatus = "none" | "ready" | "stale"

export type ArticleTreeStatus = {
    hasMindmap: boolean
    shareStatus: ArticleTreeShareStatus
    wikiStatus: ArticleTreeWikiStatus
}

export function buildArticleWikiSourcePageKey(articleId: number) {
    return `source-${articleId}`
}

export function stableContentHash(value: string) {
    return createHash("sha256").update(value).digest("hex")
}

export function buildArticleWikiSourceHash(article: Pick<KnowledgeBaseArticleRecord, "title" | "contentMd">) {
    return stableContentHash(`${article.title}\n${article.contentMd}`)
}

function readFrontmatterSourceHash(frontmatterJson: string | null | undefined) {
    if (!frontmatterJson?.trim()) {
        return null
    }
    try {
        const frontmatter = JSON.parse(frontmatterJson) as unknown
        if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
            return null
        }
        const value = (frontmatter as { sourceHash?: unknown }).sourceHash
        return typeof value === "string" ? value : null
    } catch {
        return null
    }
}

export function resolveArticleTreeShareStatus(
    share: Pick<KnowledgeBaseArticleShareRecord, "enabled" | "expiresAt" | "passwordHash" | "revokedAt"> | null | undefined,
    now = new Date(),
): ArticleTreeShareStatus {
    const status = resolvePublicHomepageShareStatus(share, now)
    if (!status.listed) {
        return "none"
    }
    if (status.expired) {
        return "expired"
    }
    if (status.hasPassword) {
        return "password"
    }
    return "public"
}

export function resolveArticleTreeWikiStatus(
    article: Pick<KnowledgeBaseArticleRecord, "title" | "contentMd">,
    wikiPage: Pick<KnowledgeBaseWikiPageRecord, "frontmatterJson" | "archivedAt"> | null | undefined,
): ArticleTreeWikiStatus {
    if (!wikiPage || wikiPage.archivedAt) {
        return "none"
    }
    const storedHash = readFrontmatterSourceHash(wikiPage.frontmatterJson)
    if (!storedHash) {
        return "ready"
    }
    return storedHash === buildArticleWikiSourceHash(article) ? "ready" : "stale"
}

export function resolveArticleHasMindmap(article: Pick<KnowledgeBaseArticleRecord, "mindmapJson" | "mindmapGeneratedAt">) {
    return Boolean(article.mindmapJson?.trim() || article.mindmapGeneratedAt)
}

export function resolveArticleTreeStatus(
    article: Pick<KnowledgeBaseArticleRecord, "title" | "contentMd" | "mindmapJson" | "mindmapGeneratedAt">,
    share: Pick<KnowledgeBaseArticleShareRecord, "enabled" | "expiresAt" | "passwordHash" | "revokedAt"> | null | undefined,
    wikiPage: Pick<KnowledgeBaseWikiPageRecord, "frontmatterJson" | "archivedAt"> | null | undefined,
    now = new Date(),
): ArticleTreeStatus {
    return {
        hasMindmap: resolveArticleHasMindmap(article),
        shareStatus: resolveArticleTreeShareStatus(share, now),
        wikiStatus: resolveArticleTreeWikiStatus(article, wikiPage),
    }
}
