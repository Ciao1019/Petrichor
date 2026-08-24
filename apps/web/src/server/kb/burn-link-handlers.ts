import { randomBytes } from "node:crypto"
import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm"
import type { AppRequest } from "@/server/http/request"
import bcrypt from "bcryptjs"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import {
    knowledgeBaseArticleBurnLinks,
    knowledgeBaseArticleTags,
    knowledgeBaseArticles,
    type KnowledgeBaseArticleBurnLinkRecord,
    type KnowledgeBaseArticleRecord,
} from "@/server/db/schema"
import { HttpError, forbidden, notFound, ok, readJson, toErrorResponse } from "@/server/http/response"
import { getServerConfig } from "@/config/server"
import { normalizeS4ObjectKey } from "@/lib/s4-url"
import { buildLocalObjectUrlFromBase, getLocalStorageDirOrNull } from "@/server/upload/local-storage"
import { createS3PresignedUrl } from "@/server/upload/s3-presign"
import { getPublicBaseUrl } from "@/server/public-site/site-url"
import {
    buildPublicArticleContentHash,
    resolvePublicArticleToc,
} from "@/server/kb/share-logic"
import {
    resolveDisplayArticleAiSummary,
    resolveUsableArticleAiSummary,
} from "@/server/kb/article-summary-logic"
import {
    resolveBurnLinkPublicState,
    validateBurnLinkArticleInput,
    validateBurnLinkCode,
    validateBurnLinkCreateInput,
    validateBurnLinkIdInput,
    validatePublicBurnConsumeInput,
} from "@/server/kb/burn-link-logic"

type User = Awaited<ReturnType<typeof requireCurrentUser>>

/** 阅后即焚相关接口全程禁止任何层的缓存，否则"读"到不了服务端、焚毁也无法真正失效。 */
const burnNoStoreHeaders = { "Cache-Control": "no-store" } as const

async function withUser(request: AppRequest, handler: (user: User) => Promise<Response>) {
    try {
        const user = await requireCurrentUser(request)
        return await handler(user)
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

async function withPublic(request: AppRequest, handler: () => Promise<Response>) {
    try {
        return await handler()
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

async function requireArticleOwner(userId: number, articleId: number): Promise<KnowledgeBaseArticleRecord> {
    const [article] = await getDb()
        .select()
        .from(knowledgeBaseArticles)
        .where(eq(knowledgeBaseArticles.id, articleId))
        .limit(1)
    if (!article) {
        throw notFound("文章不存在")
    }
    if (article.userId !== userId) {
        throw forbidden("仅文档拥有者可执行该操作")
    }
    return article
}

export async function createBurnLink(request: AppRequest) {
    return withUser(request, async (user) => {
        const input = validateBurnLinkCreateInput(await readJson(request))
        await requireArticleOwner(user.id, input.articleId)

        const passwordHash = input.passwordEnabled && input.accessPassword
            ? bcrypt.hashSync(input.accessPassword, 10)
            : null
        const [link] = await getDb()
            .insert(knowledgeBaseArticleBurnLinks)
            .values({
                userId: user.id,
                articleId: input.articleId,
                linkCode: generateBurnLinkCode(),
                maxViews: input.maxViews,
                viewCount: 0,
                passwordHash,
                expiresAt: input.expiresAt,
                status: "ACTIVE",
            })
            .returning()

        return ok(buildBurnLinkResponse(link))
    })
}

export async function listBurnLinks(request: AppRequest) {
    return withUser(request, async (user) => {
        const { articleId } = validateBurnLinkArticleInput(await readJson(request))
        await requireArticleOwner(user.id, articleId)
        const rows = await getDb()
            .select()
            .from(knowledgeBaseArticleBurnLinks)
            .where(and(
                eq(knowledgeBaseArticleBurnLinks.userId, user.id),
                eq(knowledgeBaseArticleBurnLinks.articleId, articleId),
            ))
            .orderBy(desc(knowledgeBaseArticleBurnLinks.createdAt), desc(knowledgeBaseArticleBurnLinks.id))
        return ok({ items: rows.map(buildBurnLinkResponse) })
    })
}

export async function revokeBurnLink(request: AppRequest) {
    return withUser(request, async (user) => {
        const { id } = validateBurnLinkIdInput(await readJson(request))
        const db = getDb()
        const [link] = await db
            .select()
            .from(knowledgeBaseArticleBurnLinks)
            .where(and(
                eq(knowledgeBaseArticleBurnLinks.id, id),
                eq(knowledgeBaseArticleBurnLinks.userId, user.id),
            ))
            .limit(1)
        if (!link) {
            throw notFound("链接不存在")
        }
        if (link.status === "REVOKED") {
            return ok(buildBurnLinkResponse(link))
        }
        const now = new Date()
        const [updated] = await db
            .update(knowledgeBaseArticleBurnLinks)
            .set({ status: "REVOKED", revokedAt: now, updatedAt: now })
            .where(eq(knowledgeBaseArticleBurnLinks.id, link.id))
            .returning()
        return ok(buildBurnLinkResponse(updated))
    })
}

/**
 * 公开端预检：只暴露状态 / 是否需要密码 / 封面图（与文章分享卡片同款的首图逻辑），
 * 绝不返回正文，且全程 no-store。
 */
export async function publicBurnMeta(request: AppRequest) {
    return withPublic(request, async () => {
        const code = validateBurnLinkCode(request.urlObject.searchParams.get("code") ?? "")
        const [link] = await getDb()
            .select({
                status: knowledgeBaseArticleBurnLinks.status,
                expiresAt: knowledgeBaseArticleBurnLinks.expiresAt,
                passwordHash: knowledgeBaseArticleBurnLinks.passwordHash,
                maxViews: knowledgeBaseArticleBurnLinks.maxViews,
                viewCount: knowledgeBaseArticleBurnLinks.viewCount,
                contentMd: knowledgeBaseArticles.contentMd,
            })
            .from(knowledgeBaseArticleBurnLinks)
            .innerJoin(knowledgeBaseArticles, eq(knowledgeBaseArticles.id, knowledgeBaseArticleBurnLinks.articleId))
            .where(eq(knowledgeBaseArticleBurnLinks.linkCode, code))
            .limit(1)

        if (!link) {
            return ok({ state: "NOT_FOUND", requiresPassword: false, coverImageUrl: null }, { headers: burnNoStoreHeaders })
        }
        const state = resolveBurnLinkPublicState(link, new Date())
        return ok({
            state,
            requiresPassword: Boolean(link.passwordHash?.trim()),
            remainingViews: Math.max(0, link.maxViews - link.viewCount),
            // 仅 ACTIVE 时给出封面图作为确认页的预览图；失效状态不暴露任何内容线索。
            coverImageUrl: state === "ACTIVE" ? resolvePublicCoverImageUrl(extractFirstImageUrl(link.contentMd)) : null,
        }, { headers: burnNoStoreHeaders })
    })
}

/** 公开端消费：先只读校验，再原子自增 + 达上限焚毁，命中才返回正文。全程 no-store。 */
export async function publicBurnConsume(request: AppRequest) {
    return withPublic(request, async () => {
        const input = validatePublicBurnConsumeInput(await readJson(request))
        const db = getDb()

        const [link] = await db
            .select()
            .from(knowledgeBaseArticleBurnLinks)
            .where(eq(knowledgeBaseArticleBurnLinks.linkCode, input.code))
            .limit(1)
        if (!link) {
            throw notFound("链接不存在或已失效")
        }

        // 1) 只读校验（状态 / 过期 / 密码）—— 密码错误不消耗任何阅读次数。
        const state = resolveBurnLinkPublicState(link, new Date())
        if (state === "REVOKED") {
            throw new HttpError(410, "该链接已被撤销")
        }
        if (state === "BURNED") {
            throw new HttpError(410, "该链接为阅后即焚，已被销毁")
        }
        if (state === "EXPIRED") {
            throw new HttpError(410, "该链接已过期")
        }
        if (link.passwordHash?.trim()) {
            if (!input.accessPassword) {
                throw forbidden("该链接需要访问密码")
            }
            if (!bcrypt.compareSync(input.accessPassword, link.passwordHash)) {
                throw forbidden("访问密码错误")
            }
        }

        // 2) 原子消费：view_count < max_views 守卫 + 行锁，保证并发下不超额；达上限即焚。
        const now = new Date()
        const [consumed] = await db
            .update(knowledgeBaseArticleBurnLinks)
            .set({
                viewCount: sql`${knowledgeBaseArticleBurnLinks.viewCount} + 1`,
                status: sql`case when ${knowledgeBaseArticleBurnLinks.viewCount} + 1 >= ${knowledgeBaseArticleBurnLinks.maxViews} then 'BURNED' else ${knowledgeBaseArticleBurnLinks.status} end`,
                burnedAt: sql`case when ${knowledgeBaseArticleBurnLinks.viewCount} + 1 >= ${knowledgeBaseArticleBurnLinks.maxViews} then now() else ${knowledgeBaseArticleBurnLinks.burnedAt} end`,
                updatedAt: now,
            })
            .where(and(
                eq(knowledgeBaseArticleBurnLinks.linkCode, input.code),
                eq(knowledgeBaseArticleBurnLinks.status, "ACTIVE"),
                or(
                    isNull(knowledgeBaseArticleBurnLinks.expiresAt),
                    gt(knowledgeBaseArticleBurnLinks.expiresAt, now),
                ),
                sql`${knowledgeBaseArticleBurnLinks.viewCount} < ${knowledgeBaseArticleBurnLinks.maxViews}`,
            ))
            .returning({
                articleId: knowledgeBaseArticleBurnLinks.articleId,
                viewCount: knowledgeBaseArticleBurnLinks.viewCount,
                maxViews: knowledgeBaseArticleBurnLinks.maxViews,
                status: knowledgeBaseArticleBurnLinks.status,
            })
        if (!consumed) {
            // 并发竞态：名额已被其他请求抢光 / 刚好被焚毁。
            throw new HttpError(410, "该链接为阅后即焚，已被销毁")
        }

        // 3) 读取正文。
        const [article] = await db
            .select()
            .from(knowledgeBaseArticles)
            .where(eq(knowledgeBaseArticles.id, consumed.articleId))
            .limit(1)
        if (!article) {
            throw notFound("文章不存在")
        }
        const tags = await loadTags(article.id)
        return ok({
            ...buildPublicArticleDetail(article, tags),
            burn: {
                viewCount: consumed.viewCount,
                maxViews: consumed.maxViews,
                burned: consumed.status === "BURNED",
            },
        }, { headers: burnNoStoreHeaders })
    })
}

function buildPublicArticleDetail(article: KnowledgeBaseArticleRecord, tags: string[]) {
    const currentContentHash = buildPublicArticleContentHash(article.contentMd)
    const usableAiSummary = resolveUsableArticleAiSummary({
        summary: article.aiSummary,
        summaryContentHash: article.aiSummaryContentHash,
        currentContentHash,
    })
    const aiSummary = resolveDisplayArticleAiSummary({ summary: article.aiSummary })
    return {
        title: article.title,
        contentMd: article.contentMd,
        contentJson: article.contentJson,
        contentMetaJson: article.contentMetaJson,
        tocJson: resolvePublicArticleToc(article.contentMd, article.tocJson, article.publicContentHash),
        aiSummary,
        aiSummaryGeneratedAt: aiSummary ? formatDateOrNull(article.aiSummaryGeneratedAt) : null,
        aiSummaryStale: Boolean(aiSummary) && !usableAiSummary,
        tags,
        createdAt: formatDate(article.createdAt),
        updatedAt: formatDate(article.updatedAt),
        // 阅后即焚链接不承载转载署名。
        isRepost: false,
        originalUrl: null,
        originalAuthorName: null,
        mindmapData: parseJsonOrNull(article.mindmapJson),
        mindmapGeneratedAt: formatDateOrNull(article.mindmapGeneratedAt),
        knowledgeGraphData: parseJsonOrNull(article.mindmapKgJson),
        knowledgeGraphGeneratedAt: formatDateOrNull(article.mindmapKgGeneratedAt),
    }
}

function buildBurnLinkResponse(link: KnowledgeBaseArticleBurnLinkRecord) {
    return {
        id: String(link.id),
        articleId: String(link.articleId),
        linkCode: link.linkCode,
        maxViews: link.maxViews,
        viewCount: link.viewCount,
        hasPassword: Boolean(link.passwordHash?.trim()),
        expiresAt: formatDateOrNull(link.expiresAt),
        status: link.status,
        burnedAt: formatDateOrNull(link.burnedAt),
        revokedAt: formatDateOrNull(link.revokedAt),
        createdAt: formatDate(link.createdAt),
    }
}

async function loadTags(articleId: number) {
    const rows = await getDb()
        .select({ tag: knowledgeBaseArticleTags.tag })
        .from(knowledgeBaseArticleTags)
        .where(eq(knowledgeBaseArticleTags.articleId, articleId))
        .orderBy(asc(knowledgeBaseArticleTags.tag))
    return rows.map((row) => row.tag)
}

function generateBurnLinkCode() {
    return randomBytes(18).toString("base64url")
}

/** 提取正文首图 URL：与前台分享卡片 extractFirstImageUrl 同款规则（Markdown 图片 / 内联 <img>）。 */
function extractFirstImageUrl(contentMd: string | null | undefined): string | null {
    if (!contentMd) {
        return null
    }
    const mdMatch = contentMd.match(/!\[[^\]]*\]\(([^)\s"]+)/)
    if (mdMatch?.[1]) {
        return mdMatch[1]
    }
    const htmlMatch = contentMd.match(/<img[^>]+src=["']([^"']+)["']/)
    if (htmlMatch?.[1]) {
        return htmlMatch[1]
    }
    return null
}

/**
 * 把正文里的首图引用解析成浏览器可直接加载的 URL：
 * - 站内图片是 `s4key:uploads/...` 对象键引用 → 现签一个公开 GET 预签名 URL；
 * - 外部 http(s) 图片 → 原样返回；
 * - 其它 / 解析失败 → null（确认页不显示图片）。
 */
function resolvePublicCoverImageUrl(rawUrl: string | null): string | null {
    if (!rawUrl) {
        return null
    }
    const objectKey = normalizeS4ObjectKey(rawUrl)
    if (!objectKey) {
        return /^https?:\/\//i.test(rawUrl) ? rawUrl : null
    }
    if (getLocalStorageDirOrNull()) {
        return buildLocalObjectUrlFromBase(getPublicBaseUrl(), objectKey)
    }
    const config = getServerConfig().s3
    if (!config) {
        return null
    }
    try {
        return createS3PresignedUrl({
            ...config,
            expiresSeconds: config.downloadExpireSeconds,
            method: "GET",
            objectKey,
        })
    } catch {
        return null
    }
}

function parseJsonOrNull(value: string | null | undefined) {
    const text = value?.trim() ?? ""
    if (!text) {
        return null
    }
    try {
        return JSON.parse(text) as unknown
    } catch {
        return null
    }
}

function formatDate(value: Date | string) {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function formatDateOrNull(value: Date | string | null | undefined) {
    if (!value) {
        return null
    }
    return formatDate(value)
}
