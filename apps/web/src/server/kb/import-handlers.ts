import { and, asc, count, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm"
import { after, type NextRequest } from "next/server"
import { z } from "zod"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import {
    knowledgeBaseArticles,
    knowledgeBaseImportJobPages,
    knowledgeBaseImportJobs,
    knowledgeBaseNodes,
    knowledgeBases,
    type KnowledgeBaseImportJobPageRecord,
    type KnowledgeBaseImportJobRecord,
} from "@/server/db/schema"
import { badRequest, notFound, ok, readJson, tableData, toErrorResponse } from "@/server/http/response"
import { resolvePagination } from "@/server/http/pagination"
import { buildPublicArticleMetadata } from "@/server/kb/share-logic"
import {
    countProcessedPages,
    deriveJobStatus,
    mergePageMarkdown,
    type ImportPageStatus,
} from "@/server/kb/import-logic"
import { callVisionCompletion, resolveVisionConfig } from "@/server/ai/vision"
import { fetchS3ObjectBytes, toImageDataUrl } from "@/server/upload/s3-fetch"
import { extractPdfPages, PdfExtractError } from "@/server/kb/pdf-extract"

type Db = ReturnType<typeof getDb>
type User = Awaited<ReturnType<typeof requireCurrentUser>>

interface ImportJobPageStats {
    donePages: number
    failedPages: number
    pendingPages: number
}

interface ImportJobResponseExtra {
    knowledgeBaseName?: string | null
    parentFolderName?: string | null
    pageStats?: ImportJobPageStats
}

const DEFAULT_IMPORT_CONCURRENCY = 4
const MAX_IMPORT_CONCURRENCY = 8

const idSchema = z.union([z.string(), z.number()]).transform((value, ctx) => {
    const raw = String(value).trim()
    if (!/^\d+$/.test(raw)) {
        ctx.addIssue({ code: "custom", message: "ID 必须是正整数" })
        return z.NEVER
    }
    return Number(raw)
})

const optionalIdSchema = z.preprocess((value) => {
    if (value === undefined || value === null || String(value).trim() === "") {
        return null
    }
    return value
}, idSchema.nullable())

const createJobSchema = z.object({
    knowledgeBaseId: idSchema,
    parentId: optionalIdSchema.optional(),
    fileName: z.string().trim().min(1).max(500),
    title: z.string().trim().min(1).max(200),
    /** 原始 PDF 在对象存储中的 key，由前端预签名直传后回传 */
    sourceKey: z.string().trim().min(1),
    modelConfigId: optionalIdSchema.optional(),
    concurrency: z.coerce.number().int().positive().max(MAX_IMPORT_CONCURRENCY).optional(),
})

const attachOcrPagesSchema = z.object({
    jobId: idSchema,
    concurrency: z.coerce.number().int().positive().max(MAX_IMPORT_CONCURRENCY).optional(),
    pages: z.array(z.object({
        pageNo: z.coerce.number().int().positive(),
        imageKey: z.string().trim().min(1),
    })).min(1).max(2000),
})

const convertPageSchema = z.object({
    jobId: idSchema,
    pageNo: z.coerce.number().int().positive(),
})

const jobIdSchema = z.object({ jobId: idSchema })

const deleteJobsSchema = z.object({
    ids: z.array(idSchema).min(1).max(200),
})

const listJobsSchema = z.object({
    knowledgeBaseId: optionalIdSchema.optional(),
    pageNum: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().optional(),
})

async function withUser(request: NextRequest, handler: (user: User) => Promise<Response>) {
    try {
        const user = await requireCurrentUser(request)
        return await handler(user)
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

async function assertKnowledgeBaseOwner(db: Db, userId: number, knowledgeBaseId: number) {
    const [record] = await db
        .select()
        .from(knowledgeBases)
        .where(and(eq(knowledgeBases.id, knowledgeBaseId), eq(knowledgeBases.userId, userId)))
        .limit(1)
    if (!record) {
        throw notFound("知识库不存在")
    }
    return record
}

async function assertFolderParent(db: Db, userId: number, knowledgeBaseId: number, parentId: number | null | undefined) {
    if (parentId == null) {
        return null
    }
    const [parent] = await db
        .select()
        .from(knowledgeBaseNodes)
        .where(and(eq(knowledgeBaseNodes.id, parentId), eq(knowledgeBaseNodes.userId, userId)))
        .limit(1)
    if (!parent) {
        throw notFound("节点不存在")
    }
    if (parent.knowledgeBaseId !== knowledgeBaseId || parent.type !== "FOLDER") {
        throw badRequest("父节点必须是当前知识库下的文件夹")
    }
    return parent
}

async function nextSortOrder(db: Db, userId: number, knowledgeBaseId: number, parentId: number | null) {
    const siblings = await db
        .select({ sortOrder: knowledgeBaseNodes.sortOrder })
        .from(knowledgeBaseNodes)
        .where(and(
            eq(knowledgeBaseNodes.userId, userId),
            eq(knowledgeBaseNodes.knowledgeBaseId, knowledgeBaseId),
            parentId == null ? isNull(knowledgeBaseNodes.parentId) : eq(knowledgeBaseNodes.parentId, parentId),
        ))
    const last = siblings.reduce((max, item) => Math.max(max, item.sortOrder), 0)
    return last + 1
}

async function loadJobOwned(db: Db, userId: number, jobId: number) {
    const [job] = await db
        .select()
        .from(knowledgeBaseImportJobs)
        .where(and(eq(knowledgeBaseImportJobs.id, jobId), eq(knowledgeBaseImportJobs.userId, userId)))
        .limit(1)
    if (!job) {
        throw notFound("导入任务不存在")
    }
    return job
}

async function loadJobPages(db: Db, jobId: number) {
    return db
        .select()
        .from(knowledgeBaseImportJobPages)
        .where(eq(knowledgeBaseImportJobPages.jobId, jobId))
        .orderBy(asc(knowledgeBaseImportJobPages.pageNo))
}

function emptyPageStats(totalPages: number): ImportJobPageStats {
    return { donePages: 0, failedPages: 0, pendingPages: totalPages }
}

function buildPageStats(pages: Array<{ status: string }>): ImportJobPageStats {
    return pages.reduce<ImportJobPageStats>((stats, page) => {
        if (page.status === "done") {
            stats.donePages += 1
        } else if (page.status === "failed") {
            stats.failedPages += 1
        } else {
            stats.pendingPages += 1
        }
        return stats
    }, { donePages: 0, failedPages: 0, pendingPages: 0 })
}

function resolveImportConcurrency(value: number | undefined) {
    if (!value || Number.isNaN(value)) {
        return DEFAULT_IMPORT_CONCURRENCY
    }
    return Math.max(1, Math.min(MAX_IMPORT_CONCURRENCY, value))
}

/** 固定并发度的后台任务池，避免一次性把所有页面同时丢给多模态模型。 */
async function runImportPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
    let cursor = 0
    const size = Math.max(1, Math.min(limit, items.length))
    const runners = Array.from({ length: size }, async () => {
        while (cursor < items.length) {
            const current = items[cursor]
            cursor += 1
            await worker(current)
        }
    })
    await Promise.all(runners)
}

function toJobResponse(job: KnowledgeBaseImportJobRecord, extra: ImportJobResponseExtra = {}) {
    const pageStats = extra.pageStats ?? emptyPageStats(job.totalPages)
    return {
        id: String(job.id),
        knowledgeBaseId: String(job.knowledgeBaseId),
        knowledgeBaseName: extra.knowledgeBaseName ?? null,
        parentNodeId: job.parentNodeId == null ? null : String(job.parentNodeId),
        parentFolderName: extra.parentFolderName ?? null,
        sourceType: job.sourceType,
        fileName: job.fileName,
        title: job.title,
        totalPages: job.totalPages,
        processedPages: job.processedPages,
        donePages: pageStats.donePages,
        failedPages: pageStats.failedPages,
        pendingPages: pageStats.pendingPages,
        status: job.status,
        modelConfigId: job.modelConfigId == null ? null : String(job.modelConfigId),
        articleId: job.articleId == null ? null : String(job.articleId),
        error: job.error,
        createdAt: formatDate(job.createdAt),
        updatedAt: formatDate(job.updatedAt),
    }
}

function toPageResponse(page: KnowledgeBaseImportJobPageRecord) {
    return {
        pageNo: page.pageNo,
        imageKey: page.imageKey,
        extractedBy: page.extractedBy,
        status: page.status,
        markdown: page.markdown,
        error: page.error,
    }
}

function formatDate(value: Date | string) {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

async function refreshJobProgress(db: Db, jobId: number) {
    const pages = await loadJobPages(db, jobId)
    const statuses = pages.map((page) => page.status as ImportPageStatus)
    const processed = countProcessedPages(statuses)
    const status = deriveJobStatus(statuses)
    await db
        .update(knowledgeBaseImportJobs)
        .set({ processedPages: processed, status, updatedAt: new Date() })
        .where(eq(knowledgeBaseImportJobs.id, jobId))
    return { processed, status }
}

async function loadJobDecorations(db: Db, userId: number, jobs: KnowledgeBaseImportJobRecord[]) {
    if (jobs.length === 0) {
        return new Map<number, ImportJobResponseExtra>()
    }

    const jobIds = jobs.map((job) => job.id)
    const knowledgeBaseIds = [...new Set(jobs.map((job) => job.knowledgeBaseId))]
    const parentNodeIds = [...new Set(
        jobs
            .map((job) => job.parentNodeId)
            .filter((id): id is number => id != null),
    )]

    const [pages, kbRows, folderRows] = await Promise.all([
        db
            .select({
                jobId: knowledgeBaseImportJobPages.jobId,
                status: knowledgeBaseImportJobPages.status,
            })
            .from(knowledgeBaseImportJobPages)
            .where(inArray(knowledgeBaseImportJobPages.jobId, jobIds)),
        db
            .select({
                id: knowledgeBases.id,
                name: knowledgeBases.name,
            })
            .from(knowledgeBases)
            .where(and(eq(knowledgeBases.userId, userId), inArray(knowledgeBases.id, knowledgeBaseIds))),
        parentNodeIds.length > 0
            ? db
                .select({
                    id: knowledgeBaseNodes.id,
                    name: knowledgeBaseNodes.name,
                })
                .from(knowledgeBaseNodes)
                .where(and(eq(knowledgeBaseNodes.userId, userId), inArray(knowledgeBaseNodes.id, parentNodeIds)))
            : Promise.resolve([]),
    ])

    const statsByJob = new Map<number, ImportJobPageStats>()
    for (const page of pages) {
        const current = statsByJob.get(page.jobId) ?? { donePages: 0, failedPages: 0, pendingPages: 0 }
        if (page.status === "done") {
            current.donePages += 1
        } else if (page.status === "failed") {
            current.failedPages += 1
        } else {
            current.pendingPages += 1
        }
        statsByJob.set(page.jobId, current)
    }

    const knowledgeBaseNames = new Map(kbRows.map((row) => [row.id, row.name]))
    const folderNames = new Map(folderRows.map((row) => [row.id, row.name]))
    const result = new Map<number, ImportJobResponseExtra>()
    for (const job of jobs) {
        result.set(job.id, {
            knowledgeBaseName: knowledgeBaseNames.get(job.knowledgeBaseId) ?? null,
            parentFolderName: job.parentNodeId == null ? null : (folderNames.get(job.parentNodeId) ?? null),
            pageStats: statsByJob.get(job.id) ?? emptyPageStats(job.totalPages),
        })
    }
    return result
}

/**
 * 创建导入任务：服务端拉取原始 PDF，用 pdf-inspector 本地逐页抽取 Markdown。
 *
 * - 带文字层的页当场落库为 done，完全不调用多模态模型。
 * - 只有 needsOcr 的页（扫描件 / 纯图片页）留 pending，等前端把整页图传上来后走 vision 兜底。
 * - 全部页都是文字页时直接合并生成文章，一次请求就结束。
 */
export async function createImportJob(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = createJobSchema.parse(await readJson(request))
        const db = getDb()
        const knowledgeBase = await assertKnowledgeBaseOwner(db, user.id, input.knowledgeBaseId)
        const parentFolder = await assertFolderParent(db, user.id, input.knowledgeBaseId, input.parentId ?? null)

        let source: Awaited<ReturnType<typeof fetchS3ObjectBytes>>
        try {
            source = await fetchS3ObjectBytes(input.sourceKey)
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            throw badRequest(`读取上传的 PDF 失败：${detail}`)
        }

        let extracted: ReturnType<typeof extractPdfPages>
        try {
            extracted = extractPdfPages(source.data)
        } catch (error) {
            if (error instanceof PdfExtractError) {
                throw badRequest(error.message)
            }
            throw error
        }

        const ocrPageNos = extracted.ocrPageNos
        const [job] = await db
            .insert(knowledgeBaseImportJobs)
            .values({
                userId: user.id,
                knowledgeBaseId: input.knowledgeBaseId,
                parentNodeId: input.parentId ?? null,
                sourceType: "pdf",
                fileName: input.fileName,
                sourceKey: input.sourceKey,
                title: input.title,
                totalPages: extracted.pages.length,
                processedPages: extracted.pages.length - ocrPageNos.length,
                status: "processing",
                modelConfigId: input.modelConfigId ?? null,
            })
            .returning()

        await db.insert(knowledgeBaseImportJobPages).values(
            extracted.pages.map((page) => ({
                jobId: job.id,
                pageNo: page.pageNo,
                imageKey: null,
                extractedBy: page.needsOcr ? ("vision" as const) : ("pdf" as const),
                status: page.needsOcr ? ("pending" as const) : ("done" as const),
                markdown: page.needsOcr ? null : page.markdown,
            })),
        )

        // 没有扫描页：本地抽取已经全量完成，直接合并成文章，零模型调用。
        if (ocrPageNos.length === 0) {
            const finalized = await finalizeJobToArticle(db, user, job)
            const [completed] = await db
                .select()
                .from(knowledgeBaseImportJobs)
                .where(eq(knowledgeBaseImportJobs.id, job.id))
                .limit(1)
            return ok({
                job: toJobResponse(completed ?? job, {
                    knowledgeBaseName: knowledgeBase.name,
                    parentFolderName: parentFolder?.name ?? null,
                    pageStats: { donePages: extracted.pages.length, failedPages: 0, pendingPages: 0 },
                }),
                ocrPageNos: [],
                isComplex: extracted.isComplex,
                articleId: String(finalized.articleId),
            })
        }

        return ok({
            job: toJobResponse(job, {
                knowledgeBaseName: knowledgeBase.name,
                parentFolderName: parentFolder?.name ?? null,
                pageStats: {
                    donePages: extracted.pages.length - ocrPageNos.length,
                    failedPages: 0,
                    pendingPages: ocrPageNos.length,
                },
            }),
            ocrPageNos,
            isComplex: extracted.isComplex,
            articleId: null,
        })
    })
}

/**
 * 前端把 needsOcr 页栅格化上传后回传 imageKey，绑定到页记录并启动多模态识别。
 * 只接受本来就标记为 vision 的待处理页，避免覆盖本地抽取好的文字页。
 */
export async function attachImportOcrPages(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = attachOcrPagesSchema.parse(await readJson(request))
        const db = getDb()
        const job = await loadJobOwned(db, user.id, input.jobId)
        if (job.status === "canceled") {
            throw badRequest("任务已取消")
        }
        if (job.articleId != null) {
            throw badRequest("任务已完成，无法再补充页面图片")
        }

        const ocrPages = await db
            .select()
            .from(knowledgeBaseImportJobPages)
            .where(and(
                eq(knowledgeBaseImportJobPages.jobId, job.id),
                eq(knowledgeBaseImportJobPages.extractedBy, "vision"),
            ))
        const ocrPageNos = new Set(ocrPages.map((page) => page.pageNo))

        // 页码去重，并丢弃不属于本任务 OCR 页的页码
        const seen = new Set<number>()
        const accepted = input.pages.filter((page) => {
            if (seen.has(page.pageNo) || !ocrPageNos.has(page.pageNo)) return false
            seen.add(page.pageNo)
            return true
        })
        if (accepted.length === 0) {
            throw badRequest("没有匹配的待识别页面")
        }

        for (const page of accepted) {
            await db
                .update(knowledgeBaseImportJobPages)
                .set({ imageKey: page.imageKey, status: "pending", error: null, updatedAt: new Date() })
                .where(and(
                    eq(knowledgeBaseImportJobPages.jobId, job.id),
                    eq(knowledgeBaseImportJobPages.pageNo, page.pageNo),
                ))
        }

        scheduleImportJobProcessing(user, job.id, resolveImportConcurrency(input.concurrency))

        return ok({ attached: accepted.length, status: "processing" as const })
    })
}

/**
 * 手动重试时，改用用户「当前的默认多模态模型」重新识别，而不是任务创建时锁定的模型。
 * 解析到默认配置后写回 job.modelConfigId，使后续重试与后台任务池都使用新模型。
 */
async function switchJobToDefaultVisionModel(
    db: Db,
    user: User,
    job: KnowledgeBaseImportJobRecord,
): Promise<KnowledgeBaseImportJobRecord> {
    const defaultConfig = await resolveVisionConfig(user.id, null)
    if (job.modelConfigId === defaultConfig.id) {
        return job
    }
    await db
        .update(knowledgeBaseImportJobs)
        .set({ modelConfigId: defaultConfig.id, updatedAt: new Date() })
        .where(eq(knowledgeBaseImportJobs.id, job.id))
    return { ...job, modelConfigId: defaultConfig.id }
}

async function convertSinglePage(db: Db, user: User, job: KnowledgeBaseImportJobRecord, pageNo: number) {
    const [page] = await db
        .select()
        .from(knowledgeBaseImportJobPages)
        .where(and(eq(knowledgeBaseImportJobPages.jobId, job.id), eq(knowledgeBaseImportJobPages.pageNo, pageNo)))
        .limit(1)
    if (!page) {
        throw notFound("导入任务页不存在")
    }
    if (page.extractedBy !== "vision") {
        throw badRequest("该页由 PDF 本地抽取，无需模型识别")
    }
    if (!page.imageKey) {
        throw badRequest("该页尚未上传整页图片")
    }

    try {
        const pageImage = await fetchS3ObjectBytes(page.imageKey)
        const result = await callVisionCompletion({
            userId: user.id,
            configId: job.modelConfigId,
            imageDataUrl: toImageDataUrl(pageImage),
        })
        await db
            .update(knowledgeBaseImportJobPages)
            .set({ status: "done", markdown: result.markdown, error: null, updatedAt: new Date() })
            .where(eq(knowledgeBaseImportJobPages.id, page.id))
    } catch (error) {
        const message = error instanceof Error ? error.message : "页面识别失败"
        await db
            .update(knowledgeBaseImportJobPages)
            .set({ status: "failed", error: message.slice(0, 500), updatedAt: new Date() })
            .where(eq(knowledgeBaseImportJobPages.id, page.id))
    }

    const progress = await refreshJobProgress(db, job.id)
    const [updatedPage] = await db
        .select()
        .from(knowledgeBaseImportJobPages)
        .where(eq(knowledgeBaseImportJobPages.id, page.id))
        .limit(1)
    return { page: toPageResponse(updatedPage), progress }
}

async function finalizeJobToArticle(db: Db, user: User, job: KnowledgeBaseImportJobRecord) {
    if (job.status === "canceled") {
        throw badRequest("任务已取消")
    }
    if (job.articleId != null) {
        return { articleId: job.articleId, nodeId: null }
    }

    const pages = await loadJobPages(db, job.id)
    if (pages.length === 0) {
        throw badRequest("任务没有可合并的页面")
    }
    const pendingOrFailed = pages.filter((page) => page.status !== "done")
    if (pendingOrFailed.length > 0) {
        throw badRequest(`仍有 ${pendingOrFailed.length} 页未成功转换，请先重试失败页`)
    }

    await assertKnowledgeBaseOwner(db, user.id, job.knowledgeBaseId)
    await assertFolderParent(db, user.id, job.knowledgeBaseId, job.parentNodeId)

    const contentMd = mergePageMarkdown(pages.map((page) => ({ pageNo: page.pageNo, markdown: page.markdown })))
    const sortOrder = await nextSortOrder(db, user.id, job.knowledgeBaseId, job.parentNodeId)

    const [node] = await db
        .insert(knowledgeBaseNodes)
        .values({
            userId: user.id,
            knowledgeBaseId: job.knowledgeBaseId,
            parentId: job.parentNodeId ?? null,
            type: "ARTICLE",
            name: job.title,
            sortOrder,
        })
        .returning()

    const [article] = await db
        .insert(knowledgeBaseArticles)
        .values({
            userId: user.id,
            knowledgeBaseId: job.knowledgeBaseId,
            nodeId: node.id,
            title: job.title,
            contentMd,
            ...buildPublicArticleMetadata(contentMd),
        })
        .returning()

    await db
        .update(knowledgeBaseImportJobs)
        .set({ articleId: article.id, status: "completed", error: null, updatedAt: new Date() })
        .where(eq(knowledgeBaseImportJobs.id, job.id))

    return { articleId: article.id, nodeId: node.id }
}

async function processImportJobInBackground(user: User, jobId: number, concurrency: number) {
    const db = getDb()
    try {
        let job = await loadJobOwned(db, user.id, jobId)
        if (job.status === "canceled" || job.articleId != null) {
            return
        }

        await db
            .update(knowledgeBaseImportJobs)
            .set({ status: "processing", error: null, updatedAt: new Date() })
            .where(eq(knowledgeBaseImportJobs.id, job.id))

        // 只处理已经拿到整页图的待识别页；图片还没传上来的页留到 attach 之后再跑。
        const pages = await db
            .select()
            .from(knowledgeBaseImportJobPages)
            .where(and(
                eq(knowledgeBaseImportJobPages.jobId, job.id),
                eq(knowledgeBaseImportJobPages.status, "pending"),
                isNotNull(knowledgeBaseImportJobPages.imageKey),
            ))
            .orderBy(asc(knowledgeBaseImportJobPages.pageNo))

        await runImportPool(pages, concurrency, async (page) => {
            const latestJob = await loadJobOwned(db, user.id, jobId)
            if (latestJob.status === "canceled" || latestJob.articleId != null) {
                return
            }
            await convertSinglePage(db, user, latestJob, page.pageNo)
        })

        job = await loadJobOwned(db, user.id, jobId)
        if (job.status === "canceled" || job.articleId != null) {
            return
        }

        const latestPages = await loadJobPages(db, job.id)
        const pageStats = buildPageStats(latestPages)
        if (pageStats.failedPages > 0 || pageStats.pendingPages > 0) {
            const error =
                pageStats.failedPages > 0
                    ? `有 ${pageStats.failedPages} 页转 Markdown 失败，请在导入任务详情中重试。`
                    : null
            await db
                .update(knowledgeBaseImportJobs)
                .set({ status: pageStats.failedPages > 0 ? "failed" : "processing", error, updatedAt: new Date() })
                .where(eq(knowledgeBaseImportJobs.id, job.id))
            return
        }

        await finalizeJobToArticle(db, user, job)
    } catch (error) {
        const message = error instanceof Error ? error.message : "导入任务后台处理失败"
        await db
            .update(knowledgeBaseImportJobs)
            .set({ status: "failed", error: message.slice(0, 500), updatedAt: new Date() })
            .where(eq(knowledgeBaseImportJobs.id, jobId))
    }
}

function scheduleImportJobProcessing(user: User, jobId: number, concurrency: number) {
    const task = () => processImportJobInBackground(user, jobId, concurrency)
    try {
        after(task)
    } catch {
        setTimeout(() => {
            void task()
        }, 0)
    }
}

export async function convertImportPage(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = convertPageSchema.parse(await readJson(request))
        const db = getDb()
        const job = await loadJobOwned(db, user.id, input.jobId)
        if (job.status === "canceled") {
            throw badRequest("任务已取消")
        }
        const { page, progress } = await convertSinglePage(db, user, job, input.pageNo)
        return ok({ page, processedPages: progress.processed, status: progress.status })
    })
}

export async function retryImportPage(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = convertPageSchema.parse(await readJson(request))
        const db = getDb()
        let job = await loadJobOwned(db, user.id, input.jobId)
        if (job.status === "canceled") {
            throw badRequest("任务已取消")
        }
        // 本地抽取的文字页没有整页图，重试无意义；先拦下来避免把页状态改坏。
        const [target] = await db
            .select()
            .from(knowledgeBaseImportJobPages)
            .where(and(
                eq(knowledgeBaseImportJobPages.jobId, job.id),
                eq(knowledgeBaseImportJobPages.pageNo, input.pageNo),
            ))
            .limit(1)
        if (!target) {
            throw notFound("导入任务页不存在")
        }
        if (target.extractedBy !== "vision") {
            throw badRequest("该页由 PDF 本地抽取，无需重试")
        }
        if (!target.imageKey) {
            throw badRequest("该页尚未上传整页图片")
        }
        // 重试改用当前默认多模态模型
        job = await switchJobToDefaultVisionModel(db, user, job)
        await db
            .update(knowledgeBaseImportJobPages)
            .set({ status: "pending", error: null, updatedAt: new Date() })
            .where(and(eq(knowledgeBaseImportJobPages.jobId, job.id), eq(knowledgeBaseImportJobPages.pageNo, input.pageNo)))
        const { page, progress } = await convertSinglePage(db, user, job, input.pageNo)
        return ok({ page, processedPages: progress.processed, status: progress.status })
    })
}

export async function retryImportJobFailedPages(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = jobIdSchema.parse(await readJson(request))
        const db = getDb()
        const job = await loadJobOwned(db, user.id, input.jobId)
        if (job.status === "canceled") {
            throw badRequest("任务已取消")
        }
        const failedPages = await db
            .select({ id: knowledgeBaseImportJobPages.id })
            .from(knowledgeBaseImportJobPages)
            .where(and(eq(knowledgeBaseImportJobPages.jobId, job.id), eq(knowledgeBaseImportJobPages.status, "failed")))
        if (failedPages.length === 0) {
            throw badRequest("没有需要重试的失败页")
        }
        // 重试改用当前默认多模态模型（写回 job 后，后台任务池会用新模型识别）
        await switchJobToDefaultVisionModel(db, user, job)
        // 把失败页重置为待处理，交给后台任务池重新识别，全部成功后会自动合并生成文章。
        await db
            .update(knowledgeBaseImportJobPages)
            .set({ status: "pending", error: null, updatedAt: new Date() })
            .where(and(eq(knowledgeBaseImportJobPages.jobId, job.id), eq(knowledgeBaseImportJobPages.status, "failed")))
        await db
            .update(knowledgeBaseImportJobs)
            .set({ status: "processing", error: null, updatedAt: new Date() })
            .where(eq(knowledgeBaseImportJobs.id, job.id))
        scheduleImportJobProcessing(user, job.id, DEFAULT_IMPORT_CONCURRENCY)
        return ok({ retried: failedPages.length, status: "processing" as const })
    })
}

export async function finalizeImportJob(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = jobIdSchema.parse(await readJson(request))
        const db = getDb()
        const job = await loadJobOwned(db, user.id, input.jobId)
        const result = await finalizeJobToArticle(db, user, job)
        return ok({
            articleId: String(result.articleId),
            nodeId: result.nodeId == null ? null : String(result.nodeId),
        })
    })
}

export async function cancelImportJob(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = jobIdSchema.parse(await readJson(request))
        const db = getDb()
        const job = await loadJobOwned(db, user.id, input.jobId)
        if (job.status === "completed" || job.articleId != null) {
            throw badRequest("任务已完成，无法取消")
        }
        await db
            .update(knowledgeBaseImportJobs)
            .set({ status: "canceled", updatedAt: new Date() })
            .where(eq(knowledgeBaseImportJobs.id, job.id))
        return ok({ id: String(job.id), status: "canceled" })
    })
}

export async function deleteImportJobs(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = deleteJobsSchema.parse(await readJson(request))
        const db = getDb()
        const uniqueIds = [...new Set(input.ids)]
        const owned = await db
            .select({ id: knowledgeBaseImportJobs.id })
            .from(knowledgeBaseImportJobs)
            .where(and(eq(knowledgeBaseImportJobs.userId, user.id), inArray(knowledgeBaseImportJobs.id, uniqueIds)))
        const ownedIds = owned.map((row) => row.id)
        if (ownedIds.length === 0) {
            return ok({ deleted: [] })
        }
        // 先删页面再删任务，避免依赖数据库是否配置了级联删除。已生成的文章保持不变。
        await db.delete(knowledgeBaseImportJobPages).where(inArray(knowledgeBaseImportJobPages.jobId, ownedIds))
        await db.delete(knowledgeBaseImportJobs).where(inArray(knowledgeBaseImportJobs.id, ownedIds))
        return ok({ deleted: ownedIds.map((id) => String(id)) })
    })
}

export async function listImportJobs(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = listJobsSchema.parse(await readJson(request))
        const db = getDb()
        const filters = [eq(knowledgeBaseImportJobs.userId, user.id)]
        if (input.knowledgeBaseId != null) {
            filters.push(eq(knowledgeBaseImportJobs.knowledgeBaseId, input.knowledgeBaseId))
        }
        const where = and(...filters)
        const { limit, offset } = resolvePagination({ pageNum: input.pageNum, pageSize: input.pageSize })
        const [totalRow] = await db.select({ total: count() }).from(knowledgeBaseImportJobs).where(where)
        const rows = await db
            .select()
            .from(knowledgeBaseImportJobs)
            .where(where)
            .orderBy(desc(knowledgeBaseImportJobs.createdAt), desc(knowledgeBaseImportJobs.id))
            .limit(limit)
            .offset(offset)
        const extras = await loadJobDecorations(db, user.id, rows)
        return tableData(rows.map((row) => toJobResponse(row, extras.get(row.id))), totalRow?.total ?? 0)
    })
}

export async function detailImportJob(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = jobIdSchema.parse(await readJson(request))
        const db = getDb()
        const job = await loadJobOwned(db, user.id, input.jobId)
        const pages = await loadJobPages(db, job.id)
        const extras = await loadJobDecorations(db, user.id, [job])
        return ok({ job: toJobResponse(job, extras.get(job.id)), pages: pages.map(toPageResponse) })
    })
}
