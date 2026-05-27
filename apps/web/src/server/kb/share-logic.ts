import { createHash } from "node:crypto"
import { buildToc, type TocItem } from "@/lib/markdown-toc"
import { badRequest } from "@/server/http/response"

export interface ArticleSearchInput {
    knowledgeBaseId: number
    keyword: string
    tags: string[]
}

export interface ShareArticleIdInput {
    articleId: number
}

export interface ArticleSharePinInput {
    articleId: number
    pinOrder: number | null
}

const maxPinOrder = 1_000_000

export function validateArticleSharePinInput(raw: unknown): ArticleSharePinInput {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    const { articleId } = validateShareArticleIdInput(value)
    if (value.pinOrder === undefined || value.pinOrder === null || value.pinOrder === "") {
        return { articleId, pinOrder: null }
    }
    const text = String(value.pinOrder).trim()
    if (!/^-?\d+$/.test(text)) {
        throw badRequest("置顶排序值非法")
    }
    const pinOrder = Number(text)
    if (!Number.isFinite(pinOrder)) {
        throw badRequest("置顶排序值非法")
    }
    if (pinOrder < 0 || pinOrder > maxPinOrder) {
        throw badRequest(`置顶排序值必须在 0 到 ${maxPinOrder} 之间`)
    }
    return { articleId, pinOrder }
}

export interface PublicShareDetailInput {
    shareCode: string
    accessPassword: string
}

export interface PublicShareRepostAttribution {
    isRepost: boolean
    originalUrl: string | null
    originalAuthorName: string | null
}

export interface PublicShareRepostAttributionState {
    isRepost?: boolean | null
    originalUrl?: string | null
    originalAuthorName?: string | null
}

export interface PublicHomepageShareState {
    enabled: boolean
    expiresAt?: Date | string | null
    passwordHash?: string | null
    revokedAt?: Date | string | null
}

export interface PublicHomepageShareStatus {
    listed: boolean
    expired: boolean
    hasPassword: boolean
}

export interface PathNode {
    id: number
    parentId: number | null
    name: string
}

export interface PublicArticleMetadata {
    publicExcerpt: string
    readingMinutes: number
    tocJson: string
    publicContentHash: string
}

const maxTagCount = 20
const maxTagLength = 80
const maxOriginalUrlLength = 2048
const maxOriginalAuthorNameLength = 120

export function validateArticleSearchInput(raw: unknown): ArticleSearchInput {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    return {
        knowledgeBaseId: parseRequiredId(value.knowledgeBaseId, "知识库ID非法"),
        keyword: String(value.keyword ?? "").trim(),
        tags: normalizeTags(Array.isArray(value.tags) ? value.tags : []),
    }
}

export interface PublicArticleSearchInput {
    keyword: string
    limit: number
    offset: number
}

const publicSearchMaxKeywordLength = 100
const publicSearchDefaultLimit = 20
const publicSearchMaxLimit = 50

export function validatePublicArticleSearchInput(raw: unknown): PublicArticleSearchInput {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    const rawKeyword = String(value.keyword ?? value.q ?? "").trim()
    if (!rawKeyword) {
        throw badRequest("请输入搜索关键字")
    }
    if (rawKeyword.length > publicSearchMaxKeywordLength) {
        throw badRequest(`关键字长度不能超过 ${publicSearchMaxKeywordLength}`)
    }
    const limit = parseBoundedNumber(value.limit, publicSearchDefaultLimit, 1, publicSearchMaxLimit)
    const offset = Math.max(0, parseBoundedNumber(value.offset, 0, 0, Number.MAX_SAFE_INTEGER))
    return { keyword: rawKeyword, limit, offset }
}

function parseBoundedNumber(raw: unknown, defaultValue: number, min: number, max: number) {
    if (raw == null || raw === "") {
        return defaultValue
    }
    const text = String(raw).trim()
    if (!/^-?\d+$/.test(text)) {
        return defaultValue
    }
    const value = Number(text)
    if (!Number.isFinite(value)) {
        return defaultValue
    }
    if (value < min) return min
    if (value > max) return max
    return value
}

export function validateShareArticleIdInput(raw: unknown): ShareArticleIdInput {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    const articleId = String(value.articleId ?? "").trim()
    if (!articleId) {
        throw badRequest("文章ID不能为空")
    }
    if (!/^\d+$/.test(articleId)) {
        throw badRequest("文章ID非法")
    }
    return { articleId: Number(articleId) }
}

export function validatePublicShareDetailInput(raw: unknown): PublicShareDetailInput {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    const shareCode = String(value.shareCode ?? "").trim()
    const accessPassword = String(value.accessPassword ?? "").trim()

    if (!shareCode) {
        throw badRequest("分享码不能为空")
    }
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(shareCode)) {
        throw badRequest("分享码非法")
    }
    validateSharePassword(accessPassword)

    return { shareCode, accessPassword }
}

export function validateSharePassword(accessPassword: string) {
    const password = accessPassword.trim()
    if (password && !/^\d{6}$/.test(password)) {
        throw badRequest("访问密码格式非法")
    }
}

export function validatePublicShareRepostAttributionInput(raw: unknown): PublicShareRepostAttribution {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    const isRepost = value.isRepost === true
    if (!isRepost) {
        return {
            isRepost: false,
            originalUrl: null,
            originalAuthorName: null,
        }
    }

    const originalUrl = String(value.originalUrl ?? "").trim()
    const originalAuthorName = String(value.originalAuthorName ?? "").trim()
    if (!originalUrl) {
        throw badRequest("请填写原文链接")
    }
    if (originalUrl.length > maxOriginalUrlLength) {
        throw badRequest(`原文链接长度不能超过 ${maxOriginalUrlLength}`)
    }
    if (!isHttpUrl(originalUrl)) {
        throw badRequest("原文链接必须是有效的 http:// 或 https:// 地址")
    }
    if (!originalAuthorName) {
        throw badRequest("请填写原作者名称")
    }
    if (originalAuthorName.length > maxOriginalAuthorNameLength) {
        throw badRequest(`原作者名称长度不能超过 ${maxOriginalAuthorNameLength}`)
    }

    return {
        isRepost: true,
        originalUrl,
        originalAuthorName,
    }
}

export function buildPublicShareRepostAttribution(share: PublicShareRepostAttributionState | null | undefined): PublicShareRepostAttribution {
    const originalUrl = share?.originalUrl?.trim() || null
    const originalAuthorName = share?.originalAuthorName?.trim() || null
    if (!share?.isRepost || !originalUrl || !originalAuthorName) {
        return {
            isRepost: false,
            originalUrl: null,
            originalAuthorName: null,
        }
    }

    return {
        isRepost: true,
        originalUrl,
        originalAuthorName,
    }
}

export function parseShareExpiresAt(raw: unknown, now = new Date()) {
    const value = raw == null ? "" : String(raw).trim()
    if (!value) {
        return null
    }
    if (!/^\d{4}-\d{2}-\d{2}(T| )\d{2}:\d{2}:\d{2}$/.test(value)) {
        throw badRequest("到期时间格式非法")
    }

    const normalized = value.replace(" ", "T")
    const parsed = new Date(normalized)
    if (Number.isNaN(parsed.getTime())) {
        throw badRequest("到期时间格式非法")
    }
    if (parsed <= now) {
        throw badRequest("到期时间必须晚于当前时间")
    }
    return parsed
}

export function normalizeTags(raw: unknown[]) {
    const tags = raw
        .map((tag) => String(tag ?? "").trim())
        .filter(Boolean)

    if (tags.length > maxTagCount) {
        throw badRequest(`标签数量不能超过 ${maxTagCount}`)
    }
    for (const tag of tags) {
        if (tag.length > maxTagLength) {
            throw badRequest(`标签长度不能超过 ${maxTagLength}`)
        }
    }
    return [...new Set(tags)]
}

export function buildArticlePath(nodeMap: Map<number, PathNode>, nodeId: number) {
    if (nodeId <= 0) {
        return "/"
    }

    const names: string[] = []
    const visited = new Set<number>()
    let current = nodeMap.get(nodeId)
    let depth = 0

    while (current) {
        if (depth > 100) {
            throw badRequest("节点路径过深，疑似存在循环引用")
        }
        if (visited.has(current.id)) {
            throw badRequest("节点存在循环引用，无法生成路径")
        }
        visited.add(current.id)
        names.unshift(current.name)
        current = current.parentId == null ? undefined : nodeMap.get(current.parentId)
        depth += 1
    }

    return names.length > 0 ? `/${names.join("/")}` : "/"
}

export function resolvePublicHomepageShareStatus(share: PublicHomepageShareState | null | undefined, now = new Date()): PublicHomepageShareStatus {
    return {
        listed: Boolean(share?.enabled && !share.revokedAt),
        expired: isPublicShareExpired(share, now),
        hasPassword: Boolean(share?.passwordHash?.trim()),
    }
}

export function isPublicShareExpired(share: PublicHomepageShareState | null | undefined, now = new Date()) {
    if (!share?.expiresAt) {
        return false
    }
    return toDate(share.expiresAt) <= now
}

export function buildHomepageArticleExcerpt(contentMd: string, maxLength = 120) {
    const text = markdownToPlainText(contentMd)
    if (!text) {
        return "暂无摘要"
    }
    if (text.length <= maxLength) {
        return text
    }
    return `${text.slice(0, maxLength).trimEnd()}...`
}

export function estimateReadingMinutes(contentMd: string) {
    const text = markdownToPlainText(contentMd)
    if (!text) {
        return 1
    }

    const cjkCount = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0
    const latinWordCount = text
        .replace(/[\u4e00-\u9fff]/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .length
    return Math.max(1, Math.ceil((cjkCount + latinWordCount) / 420))
}

export function buildPublicArticleContentHash(contentMd: string) {
    return createHash("md5").update(contentMd).digest("hex")
}

export function buildPublicArticleMetadata(contentMd: string): PublicArticleMetadata {
    return {
        publicExcerpt: buildHomepageArticleExcerpt(contentMd),
        readingMinutes: estimateReadingMinutes(contentMd),
        tocJson: JSON.stringify(buildToc(contentMd)),
        publicContentHash: buildPublicArticleContentHash(contentMd),
    }
}

export function parsePublicArticleTocJson(value: string | null | undefined): TocItem[] | null {
    const text = value?.trim() ?? ""
    if (!text) {
        return null
    }

    try {
        const raw = JSON.parse(text) as unknown
        if (!Array.isArray(raw)) {
            return null
        }
        const toc = raw.flatMap((item) => {
            if (!item || typeof item !== "object") {
                return []
            }
            const value = item as Record<string, unknown>
            const id = typeof value.id === "string" ? value.id.trim() : ""
            const text = typeof value.text === "string" ? value.text.trim() : ""
            const level = typeof value.level === "number" && Number.isInteger(value.level) ? value.level : 0
            if (!id || !text || level < 1 || level > 6) {
                return []
            }
            return [{ id, level, text }]
        })
        return toc
    } catch {
        return null
    }
}

export function resolvePublicArticleToc(contentMd: string, tocJson: string | null | undefined, publicContentHash: string | null | undefined) {
    const currentHash = buildPublicArticleContentHash(contentMd)
    if (publicContentHash === currentHash) {
        const storedToc = parsePublicArticleTocJson(tocJson)
        if (storedToc) {
            return storedToc
        }
    }

    return buildToc(contentMd)
}

export function parseRequiredId(raw: unknown, message: string) {
    const value = String(raw ?? "").trim()
    if (!/^\d+$/.test(value)) {
        throw badRequest(message)
    }
    return Number(value)
}

function markdownToPlainText(contentMd: string) {
    return contentMd
        // 代码块、链接、图片和 Markdown 结构符号统一归一化，保证摘要由正文稳定派生。
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
        .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^>\s?/gm, "")
        .replace(/[*_~#>-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
}

function toDate(value: Date | string) {
    return value instanceof Date ? value : new Date(value)
}

function isHttpUrl(value: string) {
    try {
        const url = new URL(value)
        return url.protocol === "http:" || url.protocol === "https:"
    } catch {
        return false
    }
}
