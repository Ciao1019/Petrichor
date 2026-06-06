import { and, count, desc, eq, inArray, isNull } from "drizzle-orm"
import { after, type NextRequest } from "next/server"
import { z } from "zod"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import {
    knowledgeBaseArticles,
    knowledgeBaseImportJobs,
    knowledgeBaseNodes,
    knowledgeBases,
    type KnowledgeBaseImportJobRecord,
} from "@/server/db/schema"
import { badRequest, notFound, ok, readJson, tableData, toErrorResponse } from "@/server/http/response"
import { resolvePagination } from "@/server/http/pagination"
import { buildPublicArticleMetadata } from "@/server/kb/share-logic"
import { parseImportSourceType, rewriteImageRefs } from "@/server/kb/import-logic"
import {
    fetchMineruResult,
    queryMineruTask,
    resolveMineruConfig,
    submitMineruTask,
} from "@/server/ai/mineru"
import { presignS3DownloadUrl, putS3Object } from "@/server/upload/s3-object"
import { buildS3ObjectKey } from "@/server/upload/s3-presign"

type Db = ReturnType<typeof getDb>
type User = Awaited<ReturnType<typeof requireCurrentUser>>

interface ImportJobResponseExtra {
    knowledgeBaseName?: string | null
    parentFolderName?: string | null
}

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
    sourceType: z.string(),
    fileName: z.string().trim().min(1).max(500),
    title: z.string().trim().min(1).max(200),
    fileKey: z.string().trim().min(1),
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

function imageMimeFromExt(ext: string): string {
    switch (ext.toLowerCase()) {
        case ".png":
            return "image/png"
        case ".jpg":
        case ".jpeg":
            return "image/jpeg"
        case ".gif":
            return "image/gif"
        case ".webp":
            return "image/webp"
        case ".bmp":
            return "image/bmp"
        case ".svg":
            return "image/svg+xml"
        default:
            return "application/octet-stream"
    }
}

function toJobResponse(job: KnowledgeBaseImportJobRecord, extra: ImportJobResponseExtra = {}) {
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
        // finalizing 是内部中间态，对前端统一呈现为 processing
        status: job.status === "finalizing" ? "processing" : job.status,
        articleId: job.articleId == null ? null : String(job.articleId),
        error: job.error,
        createdAt: formatDate(job.createdAt),
        updatedAt: formatDate(job.updatedAt),
    }
}

function formatDate(value: Date | string) {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

async function loadJobDecorations(db: Db, userId: number, jobs: KnowledgeBaseImportJobRecord[]) {
    if (jobs.length === 0) {
        return new Map<number, ImportJobResponseExtra>()
    }

    const knowledgeBaseIds = [...new Set(jobs.map((job) => job.knowledgeBaseId))]
    const parentNodeIds = [...new Set(
        jobs
            .map((job) => job.parentNodeId)
            .filter((id): id is number => id != null),
    )]

    const [kbRows, folderRows] = await Promise.all([
        db
            .select({ id: knowledgeBases.id, name: knowledgeBases.name })
            .from(knowledgeBases)
            .where(and(eq(knowledgeBases.userId, userId), inArray(knowledgeBases.id, knowledgeBaseIds))),
        parentNodeIds.length > 0
            ? db
                .select({ id: knowledgeBaseNodes.id, name: knowledgeBaseNodes.name })
                .from(knowledgeBaseNodes)
                .where(and(eq(knowledgeBaseNodes.userId, userId), inArray(knowledgeBaseNodes.id, parentNodeIds)))
            : Promise.resolve([]),
    ])

    const knowledgeBaseNames = new Map(kbRows.map((row) => [row.id, row.name]))
    const folderNames = new Map(folderRows.map((row) => [row.id, row.name]))
    const result = new Map<number, ImportJobResponseExtra>()
    for (const job of jobs) {
        result.set(job.id, {
            knowledgeBaseName: knowledgeBaseNames.get(job.knowledgeBaseId) ?? null,
            parentFolderName: job.parentNodeId == null ? null : (folderNames.get(job.parentNodeId) ?? null),
        })
    }
    return result
}

export async function createImportJob(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = createJobSchema.parse(await readJson(request))
        const sourceType = parseImportSourceType(input.sourceType)
        if (!sourceType) {
            throw badRequest("不支持的文档类型，仅支持 pdf / docx")
        }
        const db = getDb()
        const knowledgeBase = await assertKnowledgeBaseOwner(db, user.id, input.knowledgeBaseId)
        const parentFolder = await assertFolderParent(db, user.id, input.knowledgeBaseId, input.parentId ?? null)
        // 提前校验文档解析配置，避免建任务后才发现没有 Token
        await resolveMineruConfig(user.id)

        const [job] = await db
            .insert(knowledgeBaseImportJobs)
            .values({
                userId: user.id,
                knowledgeBaseId: input.knowledgeBaseId,
                parentNodeId: input.parentId ?? null,
                sourceType,
                fileName: input.fileName,
                title: input.title,
                sourceFileKey: input.fileKey,
                status: "pending",
            })
            .returning()

        scheduleImportJobProcessing(user, job.id)

        return ok({
            job: toJobResponse(job, {
                knowledgeBaseName: knowledgeBase.name,
                parentFolderName: parentFolder?.name ?? null,
            }),
        })
    })
}

/**
 * 解析任务状态机：可被后台任务和前端轮询（detail）共同驱动。
 * - 未提交：提交 MinerU 任务并记录 task_id。
 * - 已提交：查询进度；done 则生成文章，failed 则置失败。
 * 内部捕获异常并写入失败状态，调用方无需再处理。
 */
async function advanceImportJob(user: User, jobId: number): Promise<void> {
    const db = getDb()
    let job: KnowledgeBaseImportJobRecord
    try {
        job = await loadJobOwned(db, user.id, jobId)
    } catch {
        return
    }
    if (job.articleId != null) {
        return
    }
    if (job.status !== "pending" && job.status !== "processing") {
        return
    }

    try {
        const config = await resolveMineruConfig(user.id)

        // 尚未提交解析任务
        if (!job.mineruTaskId) {
            const fileUrl = presignS3DownloadUrl(job.sourceFileKey)
            const taskId = await submitMineruTask(config, fileUrl, { isOcr: job.sourceType === "pdf" })
            await db
                .update(knowledgeBaseImportJobs)
                .set({ mineruTaskId: taskId, status: "processing", error: null, updatedAt: new Date() })
                .where(eq(knowledgeBaseImportJobs.id, job.id))
            return
        }

        const result = await queryMineruTask(config, job.mineruTaskId)

        // 同步进度
        if (result.totalPages != null || result.extractedPages != null) {
            await db
                .update(knowledgeBaseImportJobs)
                .set({
                    totalPages: result.totalPages ?? job.totalPages,
                    processedPages: result.extractedPages ?? job.processedPages,
                    updatedAt: new Date(),
                })
                .where(eq(knowledgeBaseImportJobs.id, job.id))
        }

        if (result.state === "failed") {
            await db
                .update(knowledgeBaseImportJobs)
                .set({ status: "failed", error: result.errMsg ?? "MinerU 解析失败", updatedAt: new Date() })
                .where(eq(knowledgeBaseImportJobs.id, job.id))
            return
        }

        if (result.state === "done" && result.fullZipUrl) {
            // 单飞抢占：仅当状态仍为当前值且未生成文章时，标记 finalizing 并由本次调用收尾
            const [claimed] = await db
                .update(knowledgeBaseImportJobs)
                .set({ status: "finalizing", updatedAt: new Date() })
                .where(and(
                    eq(knowledgeBaseImportJobs.id, job.id),
                    eq(knowledgeBaseImportJobs.status, job.status),
                    isNull(knowledgeBaseImportJobs.articleId),
                ))
                .returning()
            if (!claimed) {
                return
            }
            try {
                await finalizeMineruJob(db, user, claimed, result.fullZipUrl)
            } catch (error) {
                const message = error instanceof Error ? error.message : "生成文章失败"
                await db
                    .update(knowledgeBaseImportJobs)
                    .set({ status: "failed", error: message.slice(0, 500), updatedAt: new Date() })
                    .where(eq(knowledgeBaseImportJobs.id, job.id))
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : "文档解析失败"
        await db
            .update(knowledgeBaseImportJobs)
            .set({ status: "failed", error: message.slice(0, 500), updatedAt: new Date() })
            .where(eq(knowledgeBaseImportJobs.id, job.id))
    }
}

/** 下载 MinerU 结果、转存图片、改写链接并生成文章。 */
async function finalizeMineruJob(
    db: Db,
    user: User,
    job: KnowledgeBaseImportJobRecord,
    fullZipUrl: string,
) {
    await assertKnowledgeBaseOwner(db, user.id, job.knowledgeBaseId)
    await assertFolderParent(db, user.id, job.knowledgeBaseId, job.parentNodeId)

    const parsed = await fetchMineruResult(fullZipUrl)

    // 把结果中的图片转存到本系统对象存储，并改写 Markdown 中的相对引用
    const mapping: Array<{ ref: string; url: string }> = []
    for (const image of parsed.images) {
        const objectKey = buildS3ObjectKey({ filename: `mineru${image.ext}`, userId: user.id })
        await putS3Object(objectKey, image.bytes, imageMimeFromExt(image.ext))
        mapping.push({ ref: image.ref, url: `s4key:${objectKey}` })
    }
    const contentMd = rewriteImageRefs(parsed.markdown, mapping).trim()

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
        .set({
            articleId: article.id,
            status: "completed",
            // 完成时把已解析页数补齐为总页数，避免出现「2/3 页 已完成」的不一致
            processedPages: job.totalPages,
            error: null,
            updatedAt: new Date(),
        })
        .where(eq(knowledgeBaseImportJobs.id, job.id))
}

const BACKGROUND_POLL_INTERVAL_MS = 4000
const BACKGROUND_MAX_DURATION_MS = 5 * 60 * 1000

function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/**
 * 后台跟进解析任务直至结束：先提交任务，再按固定间隔轮询，
 * 直到生成文章或失败/取消，或超过最长跟进时长。
 * 即使该后台任务被环境提前回收，前端打开任务详情时也会继续推进（detail 内置兜底）。
 */
async function runImportJobToCompletion(user: User, jobId: number) {
    const start = Date.now()
    await advanceImportJob(user, jobId)
    while (Date.now() - start < BACKGROUND_MAX_DURATION_MS) {
        let job: KnowledgeBaseImportJobRecord
        try {
            job = await loadJobOwned(getDb(), user.id, jobId)
        } catch {
            return
        }
        if (job.articleId != null || (job.status !== "pending" && job.status !== "processing")) {
            return
        }
        await sleep(BACKGROUND_POLL_INTERVAL_MS)
        await advanceImportJob(user, jobId)
    }
}

function scheduleImportJobProcessing(user: User, jobId: number) {
    const task = () => runImportJobToCompletion(user, jobId)
    try {
        after(task)
    } catch {
        setTimeout(() => {
            void task()
        }, 0)
    }
}

export async function retryImportJob(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = jobIdSchema.parse(await readJson(request))
        const db = getDb()
        const job = await loadJobOwned(db, user.id, input.jobId)
        if (job.articleId != null) {
            throw badRequest("任务已生成文章，无需重试")
        }
        // 重置为待处理并清掉旧的 MinerU 任务，重新提交解析
        await db
            .update(knowledgeBaseImportJobs)
            .set({ status: "pending", mineruTaskId: null, error: null, processedPages: 0, updatedAt: new Date() })
            .where(eq(knowledgeBaseImportJobs.id, job.id))
        scheduleImportJobProcessing(user, job.id)
        return ok({ status: "processing" as const })
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
        // 已生成的文章保持不变，仅删除导入任务记录。
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
        let job = await loadJobOwned(db, user.id, input.jobId)
        // 进行中的任务：每次查看时顺带推进一步 MinerU 状态，避免依赖后台任务存活
        if (job.status === "pending" || job.status === "processing") {
            await advanceImportJob(user, job.id)
            job = await loadJobOwned(db, user.id, input.jobId)
        }
        const extras = await loadJobDecorations(db, user.id, [job])
        return ok({ job: toJobResponse(job, extras.get(job.id)) })
    })
}
