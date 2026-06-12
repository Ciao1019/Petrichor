import { badRequest } from "@/server/http/response"
import { parseRequiredId, parseShareExpiresAt, validateSharePassword } from "@/server/kb/share-logic"

/** 单个阅后即焚链接允许的最大访问次数上限。1 = 严格阅后即焚。 */
export const BURN_MAX_VIEWS_LIMIT = 100

const BURN_LINK_CODE_PATTERN = /^[A-Za-z0-9_-]{10,64}$/

export interface BurnLinkCreateInput {
    articleId: number
    maxViews: number
    passwordEnabled: boolean
    accessPassword: string
    expiresAt: Date | null
}

export interface BurnLinkIdInput {
    id: number
}

export interface BurnLinkArticleInput {
    articleId: number
}

export interface PublicBurnConsumeInput {
    code: string
    accessPassword: string
}

/** 解析访问次数上限：空 → 1（阅后即焚）；否则必须是 1..BURN_MAX_VIEWS_LIMIT 的整数。 */
export function parseBurnMaxViews(raw: unknown): number {
    if (raw === undefined || raw === null || raw === "") {
        return 1
    }
    const text = String(raw).trim()
    if (!/^\d+$/.test(text)) {
        throw badRequest("访问次数必须是正整数")
    }
    const value = Number(text)
    if (!Number.isInteger(value) || value < 1 || value > BURN_MAX_VIEWS_LIMIT) {
        throw badRequest(`访问次数必须在 1 到 ${BURN_MAX_VIEWS_LIMIT} 之间`)
    }
    return value
}

export function validateBurnLinkCreateInput(raw: unknown): BurnLinkCreateInput {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    const articleId = parseRequiredId(value.articleId, "文章ID非法")
    const maxViews = parseBurnMaxViews(value.maxViews)
    const passwordEnabled = Boolean(value.passwordEnabled)
    const accessPassword = String(value.accessPassword ?? "").trim()
    validateSharePassword(accessPassword)
    if (passwordEnabled && !accessPassword) {
        throw badRequest("请填写 6 位访问密码")
    }
    const expiresAt = parseShareExpiresAt(value.expiresAt)
    return {
        articleId,
        maxViews,
        passwordEnabled,
        accessPassword: passwordEnabled ? accessPassword : "",
        expiresAt,
    }
}

export function validateBurnLinkIdInput(raw: unknown): BurnLinkIdInput {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    const id = String(value.id ?? "").trim()
    if (!/^\d+$/.test(id)) {
        throw badRequest("链接ID非法")
    }
    return { id: Number(id) }
}

export function validateBurnLinkArticleInput(raw: unknown): BurnLinkArticleInput {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    return { articleId: parseRequiredId(value.articleId, "文章ID非法") }
}

/** 校验公开访问的链接码（meta GET 与 consume POST 共用）。 */
export function validateBurnLinkCode(raw: unknown): string {
    const code = String(raw ?? "").trim()
    if (!code) {
        throw badRequest("链接码不能为空")
    }
    if (!BURN_LINK_CODE_PATTERN.test(code)) {
        throw badRequest("链接码非法")
    }
    return code
}

export function validatePublicBurnConsumeInput(raw: unknown): PublicBurnConsumeInput {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    const code = validateBurnLinkCode(value.code ?? value.linkCode)
    const accessPassword = String(value.accessPassword ?? "").trim()
    validateSharePassword(accessPassword)
    return { code, accessPassword }
}

export type BurnLinkPublicState = "ACTIVE" | "BURNED" | "REVOKED" | "EXPIRED"

export interface BurnLinkStateLike {
    status: string
    expiresAt?: Date | string | null
}

/** 把存储状态 + 过期时间归一为面向公开端的可达状态。 */
export function resolveBurnLinkPublicState(record: BurnLinkStateLike, now = new Date()): BurnLinkPublicState {
    if (record.status === "REVOKED") {
        return "REVOKED"
    }
    if (record.status === "BURNED") {
        return "BURNED"
    }
    if (record.expiresAt) {
        const expiresAt = record.expiresAt instanceof Date ? record.expiresAt : new Date(record.expiresAt)
        if (expiresAt <= now) {
            return "EXPIRED"
        }
    }
    return "ACTIVE"
}
