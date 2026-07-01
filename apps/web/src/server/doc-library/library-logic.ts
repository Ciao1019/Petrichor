import { and, asc, desc, eq, ilike, like, or, sql } from "drizzle-orm"
import { z } from "zod"
import { getServerConfig } from "@/config/server"
import { CACHE_TTL_SECONDS, cacheDropByPrefix, cacheKey, cacheReadThrough } from "@/server/cache"
import { getDb, isSqliteDatabase } from "@/server/db/client"
import {
    docChunks,
    docDocuments,
    docFolders,
    docLibraries,
} from "@/server/db/schema"
import { badRequest, notFound } from "@/server/http/response"
import { docLibraryDocumentPath } from "@/lib/dashboard-routes"
import { deleteS3Objects, type S3DeleteFailure } from "@/server/upload/s3-delete"
import { stripS4KeyPrefix } from "@/server/upload/s3-presign"

export const idSchema = z.union([z.string(), z.number()]).transform((value, ctx) => {
    const raw = String(value).trim()
    if (!/^\d+$/.test(raw)) {
        ctx.addIssue({ code: "custom", message: "ID 必须是正整数" })
        return z.NEVER
    }
    return Number(raw)
})

export const optionalIdSchema = z.union([z.string(), z.number(), z.null()]).optional().transform((value) => {
    if (value == null) return null
    const raw = String(value).trim()
    if (!raw || !/^\d+$/.test(raw)) return null
    return Number(raw)
})

export const FILE_TYPES = ["pdf", "docx", "xlsx", "csv"] as const
export type DocFileType = (typeof FILE_TYPES)[number]

const MAX_CHUNKS = 4000
const MAX_CHUNK_CHARS = 4000

// ===== 文档库缓存键（按用户隔离） =====

const docLibraryListKey = (userId: number) => cacheKey("doclib", userId, "libraries")
const docFolderListKey = (userId: number, libraryId: number) => cacheKey("doclib", userId, "lib", libraryId, "folders")
const docDocumentListKey = (userId: number, libraryId: number) => cacheKey("doclib", userId, "lib", libraryId, "documents")
const docDocumentDetailKey = (userId: number, documentId: number) => cacheKey("doclib", userId, "doc", documentId)

/** 失效某用户文档库下的全部缓存（库/文件夹/文档列表与文档详情）。 */
function invalidateDocLibraryCache(userId: number) {
    return cacheDropByPrefix(`${cacheKey("doclib", userId)}:`)
}

export type DocumentStorageCleanupSummary = {
    deletedObjectKeys: string[]
    failedObjectKeys: S3DeleteFailure[]
}

export const librarySaveSchema = z.object({
    id: optionalIdSchema,
    name: z.string().trim().min(1, "名称不能为空").max(80),
    description: z.string().trim().max(500).optional().nullable(),
    color: z.string().trim().max(40).optional().nullable(),
    icon: z.string().trim().max(40).optional().nullable(),
})

export const folderSaveSchema = z.object({
    id: optionalIdSchema,
    libraryId: idSchema,
    parentId: optionalIdSchema,
    name: z.string().trim().min(1, "名称不能为空").max(120),
})

export const documentRegisterSchema = z.object({
    libraryId: idSchema,
    folderId: optionalIdSchema,
    fileName: z.string().trim().min(1).max(255),
    title: z.string().trim().max(255).optional().nullable(),
    fileType: z.enum(FILE_TYPES),
    contentType: z.string().trim().max(160).optional().nullable(),
    objectKey: z.string().trim().min(1).max(512),
    sizeBytes: z.number().int().nonnegative().optional().nullable(),
    pageCount: z.number().int().nonnegative().optional().nullable(),
    blocks: z.array(z.unknown()).optional(),
    chunks: z.array(z.object({
        text: z.string(),
        page: z.number().int().nonnegative().optional().nullable(),
        locator: z.string().max(80).optional().nullable(),
    })).max(MAX_CHUNKS).optional(),
    summary: z.string().max(2000).optional().nullable(),
})

// ===== 文档库 CRUD =====

export async function listLibraries(userId: number) {
    return cacheReadThrough(docLibraryListKey(userId), CACHE_TTL_SECONDS.docLibraryCollection, async () => {
        const db = getDb()
        const rows = await db
            .select()
            .from(docLibraries)
            .where(eq(docLibraries.userId, userId))
            .orderBy(desc(docLibraries.updatedAt), desc(docLibraries.id))
        return rows.map(toLibraryResponse)
    })
}

export async function saveLibrary(input: {
    userId: number
    id: number | null
    name: string
    description?: string | null
    color?: string | null
    icon?: string | null
}) {
    const db = getDb()
    const now = new Date()
    if (input.id != null) {
        await getLibraryOrThrow(input.userId, input.id)
        await db
            .update(docLibraries)
            .set({
                name: input.name,
                description: input.description ?? null,
                color: input.color ?? null,
                icon: input.icon ?? null,
                updatedAt: now,
            })
            .where(and(eq(docLibraries.id, input.id), eq(docLibraries.userId, input.userId)))
        await invalidateDocLibraryCache(input.userId)
        return { id: String(input.id) }
    }
    const [created] = await db
        .insert(docLibraries)
        .values({
            userId: input.userId,
            name: input.name,
            description: input.description ?? null,
            color: input.color ?? null,
            icon: input.icon ?? null,
            documentCount: 0,
            createdAt: now,
            updatedAt: now,
        })
        .returning({ id: docLibraries.id })
    await invalidateDocLibraryCache(input.userId)
    return { id: String(created!.id) }
}

export async function deleteLibrary(userId: number, libraryId: number) {
    const db = getDb()
    await getLibraryOrThrow(userId, libraryId)
    const docs = await db
        .select({ objectKey: docDocuments.objectKey })
        .from(docDocuments)
        .where(and(eq(docDocuments.libraryId, libraryId), eq(docDocuments.userId, userId)))
    await db.transaction(async (tx) => {
        await tx.delete(docChunks).where(eq(docChunks.libraryId, libraryId))
        await tx.delete(docDocuments).where(eq(docDocuments.libraryId, libraryId))
        await tx.delete(docFolders).where(eq(docFolders.libraryId, libraryId))
        await tx.delete(docLibraries).where(and(eq(docLibraries.id, libraryId), eq(docLibraries.userId, userId)))
    })
    const storageCleanup = await cleanupDocumentObjectKeys(userId, docs.map((doc) => doc.objectKey))
    await invalidateDocLibraryCache(userId)
    return { id: String(libraryId), storageCleanup }
}

export async function getLibraryOrThrow(userId: number, libraryId: number) {
    const [row] = await getDb()
        .select()
        .from(docLibraries)
        .where(and(eq(docLibraries.id, libraryId), eq(docLibraries.userId, userId)))
        .limit(1)
    if (!row) throw notFound("文档库不存在")
    return row
}

// ===== 文件夹 =====

export async function listFolders(userId: number, libraryId: number) {
    return cacheReadThrough(docFolderListKey(userId, libraryId), CACHE_TTL_SECONDS.docLibraryCollection, async () => {
        const rows = await getDb()
            .select()
            .from(docFolders)
            .where(and(eq(docFolders.userId, userId), eq(docFolders.libraryId, libraryId)))
            .orderBy(asc(docFolders.sortOrder), asc(docFolders.id))
        return rows.map((row) => ({
            id: String(row.id),
            libraryId: String(row.libraryId),
            parentId: row.parentId != null ? String(row.parentId) : null,
            name: row.name,
            sortOrder: row.sortOrder,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        }))
    })
}

export async function saveFolder(input: {
    userId: number
    id: number | null
    libraryId: number
    parentId: number | null
    name: string
}) {
    const db = getDb()
    await getLibraryOrThrow(input.userId, input.libraryId)
    const now = new Date()
    if (input.id != null) {
        await db
            .update(docFolders)
            .set({ name: input.name, parentId: input.parentId, updatedAt: now })
            .where(and(eq(docFolders.id, input.id), eq(docFolders.userId, input.userId)))
        await invalidateDocLibraryCache(input.userId)
        return { id: String(input.id) }
    }
    const [created] = await db
        .insert(docFolders)
        .values({
            userId: input.userId,
            libraryId: input.libraryId,
            parentId: input.parentId,
            name: input.name,
            sortOrder: 0,
            createdAt: now,
            updatedAt: now,
        })
        .returning({ id: docFolders.id })
    await invalidateDocLibraryCache(input.userId)
    return { id: String(created!.id) }
}

export async function deleteFolder(userId: number, folderId: number) {
    const db = getDb()
    // 文件夹内的文档归位到根目录，子文件夹级联（DB on delete cascade 已处理子文件夹）
    await db.update(docDocuments).set({ folderId: null }).where(and(eq(docDocuments.userId, userId), eq(docDocuments.folderId, folderId)))
    await db.delete(docFolders).where(and(eq(docFolders.id, folderId), eq(docFolders.userId, userId)))
    await invalidateDocLibraryCache(userId)
    return { id: String(folderId) }
}

// ===== 文档 =====

export async function registerDocument(input: {
    userId: number
    libraryId: number
    folderId: number | null
    fileName: string
    title: string | null
    fileType: DocFileType
    contentType: string | null
    objectKey: string
    sizeBytes: number | null
    pageCount: number | null
    blocks?: unknown[]
    chunks?: Array<{ text: string; page?: number | null; locator?: string | null }>
    summary?: string | null
}) {
    const db = getDb()
    await getLibraryOrThrow(input.userId, input.libraryId)

    const cleanChunks = (input.chunks ?? [])
        .map((chunk) => ({
            text: chunk.text.replace(/\s+/g, " ").trim().slice(0, MAX_CHUNK_CHARS),
            page: chunk.page ?? null,
            locator: chunk.locator ?? null,
        }))
        .filter((chunk) => chunk.text.length > 0)
        .slice(0, MAX_CHUNKS)
    const charCount = cleanChunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
    const hasBlocks = Array.isArray(input.blocks) && input.blocks.length > 0
    const now = new Date()

    const documentId = await db.transaction(async (tx) => {
        const [created] = await tx
            .insert(docDocuments)
            .values({
                userId: input.userId,
                libraryId: input.libraryId,
                folderId: input.folderId,
                fileName: input.fileName,
                title: (input.title?.trim() || input.fileName).slice(0, 255),
                fileType: input.fileType,
                contentType: input.contentType,
                objectKey: input.objectKey,
                sizeBytes: input.sizeBytes,
                pageCount: input.pageCount,
                charCount,
                status: "ready",
                blocksJson: hasBlocks ? JSON.stringify(input.blocks) : null,
                summary: input.summary ?? null,
                createdAt: now,
                updatedAt: now,
            })
            .returning({ id: docDocuments.id })
        const newId = created!.id
        if (cleanChunks.length > 0) {
            await tx.insert(docChunks).values(cleanChunks.map((chunk, index) => ({
                userId: input.userId,
                libraryId: input.libraryId,
                documentId: newId,
                chunkIndex: index,
                locator: chunk.locator,
                page: chunk.page,
                text: chunk.text,
                createdAt: now,
            })))
        }
        await tx
            .update(docLibraries)
            .set({ documentCount: sql`${docLibraries.documentCount} + 1`, updatedAt: now })
            .where(and(eq(docLibraries.id, input.libraryId), eq(docLibraries.userId, input.userId)))
        return newId
    })

    await invalidateDocLibraryCache(input.userId)
    return { id: String(documentId) }
}

export async function listDocuments(userId: number, libraryId: number) {
    return cacheReadThrough(docDocumentListKey(userId, libraryId), CACHE_TTL_SECONDS.docLibraryCollection, async () => {
        const rows = await getDb()
            .select({
                id: docDocuments.id,
                libraryId: docDocuments.libraryId,
                folderId: docDocuments.folderId,
                fileName: docDocuments.fileName,
                title: docDocuments.title,
                fileType: docDocuments.fileType,
                contentType: docDocuments.contentType,
                objectKey: docDocuments.objectKey,
                sizeBytes: docDocuments.sizeBytes,
                pageCount: docDocuments.pageCount,
                status: docDocuments.status,
                createdAt: docDocuments.createdAt,
                updatedAt: docDocuments.updatedAt,
            })
            .from(docDocuments)
            .where(and(eq(docDocuments.userId, userId), eq(docDocuments.libraryId, libraryId)))
            .orderBy(desc(docDocuments.createdAt), desc(docDocuments.id))
        return rows.map((row) => ({
            id: String(row.id),
            libraryId: String(row.libraryId),
            folderId: row.folderId != null ? String(row.folderId) : null,
            fileName: row.fileName,
            title: row.title,
            fileType: row.fileType,
            contentType: row.contentType,
            objectKey: row.objectKey,
            sizeBytes: row.sizeBytes,
            pageCount: row.pageCount,
            status: row.status,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        }))
    })
}

export async function getDocumentDetail(userId: number, documentId: number) {
    return cacheReadThrough(docDocumentDetailKey(userId, documentId), CACHE_TTL_SECONDS.docDocumentDetail, async () => {
        const doc = await getDocumentOrThrow(userId, documentId)
        const chunks = await getDb()
            .select({
                chunkIndex: docChunks.chunkIndex,
                page: docChunks.page,
                locator: docChunks.locator,
                text: docChunks.text,
            })
            .from(docChunks)
            .where(and(eq(docChunks.documentId, documentId), eq(docChunks.userId, userId)))
            .orderBy(asc(docChunks.chunkIndex))

        return {
            id: String(doc.id),
            libraryId: String(doc.libraryId),
            folderId: doc.folderId != null ? String(doc.folderId) : null,
            fileName: doc.fileName,
            title: doc.title,
            fileType: doc.fileType,
            contentType: doc.contentType,
            objectKey: doc.objectKey,
            sizeBytes: doc.sizeBytes,
            pageCount: doc.pageCount,
            charCount: doc.charCount,
            status: doc.status,
            blocks: parseJsonArray(doc.blocksJson),
            chunks: chunks.map((chunk) => ({
                chunkIndex: chunk.chunkIndex,
                page: chunk.page,
                locator: chunk.locator,
                text: chunk.text,
            })),
            summary: doc.summary,
            createdAt: doc.createdAt.toISOString(),
            updatedAt: doc.updatedAt.toISOString(),
        }
    })
}

export async function getDocumentOrThrow(userId: number, documentId: number) {
    const [doc] = await getDb()
        .select()
        .from(docDocuments)
        .where(and(eq(docDocuments.id, documentId), eq(docDocuments.userId, userId)))
        .limit(1)
    if (!doc) throw notFound("文档不存在")
    return doc
}

export async function deleteDocument(userId: number, documentId: number) {
    const db = getDb()
    const doc = await getDocumentOrThrow(userId, documentId)
    await db.transaction(async (tx) => {
        await tx.delete(docChunks).where(eq(docChunks.documentId, documentId))
        await tx.delete(docDocuments).where(and(eq(docDocuments.id, documentId), eq(docDocuments.userId, userId)))
        await tx
            .update(docLibraries)
            .set({ documentCount: decrementDocumentCountSql(), updatedAt: new Date() })
            .where(and(eq(docLibraries.id, doc.libraryId), eq(docLibraries.userId, userId)))
    })
    const storageCleanup = await cleanupDocumentObjectKeys(userId, [doc.objectKey])
    await invalidateDocLibraryCache(userId)
    return { id: String(documentId), objectKey: doc.objectKey, storageCleanup }
}

// ===== Agentic 检索：工具用 =====

export async function listDocumentsForQa(userId: number, libraryId: number | null) {
    const filters = [eq(docDocuments.userId, userId), eq(docDocuments.status, "ready")]
    if (libraryId != null) filters.push(eq(docDocuments.libraryId, libraryId))
    const rows = await getDb()
        .select({
            id: docDocuments.id,
            libraryId: docDocuments.libraryId,
            title: docDocuments.title,
            fileName: docDocuments.fileName,
            fileType: docDocuments.fileType,
            pageCount: docDocuments.pageCount,
        })
        .from(docDocuments)
        .where(and(...filters))
        .orderBy(desc(docDocuments.updatedAt))
        .limit(200)
    return rows.map((row) => ({
        documentId: String(row.id),
        libraryId: String(row.libraryId),
        href: docLibraryDocumentPath(String(row.libraryId), String(row.id)),
        title: row.title,
        fileName: row.fileName,
        fileType: row.fileType,
        pageCount: row.pageCount,
    }))
}

export async function searchChunks(input: {
    userId: number
    libraryId: number | null
    query: string
    documentId?: number | null
    limit?: number
}) {
    const keyword = input.query.trim()
    if (!keyword) return []
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 20)
    const terms = keyword.split(/\s+/).filter(Boolean).slice(0, 5)
    const filters = [eq(docChunks.userId, input.userId)]
    if (input.libraryId != null) filters.push(eq(docChunks.libraryId, input.libraryId))
    if (input.documentId != null) filters.push(eq(docChunks.documentId, input.documentId))

    if (isSqliteDatabase()) {
        // SQLite 分支：LIKE OR 召回 + JS 词频打分（中文效果一般，仅作 dev 兜底）
        const termConditions = terms.map((term) => {
            const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
            return like(docChunks.text, pattern)
        })
        if (termConditions.length > 0) {
            const combined = termConditions.length === 1 ? termConditions[0] : or(...termConditions)
            if (combined) filters.push(combined)
        }

        const rows = await getDb()
            .select({
                chunkId: docChunks.id,
                documentId: docChunks.documentId,
                libraryId: docChunks.libraryId,
                page: docChunks.page,
                locator: docChunks.locator,
                text: docChunks.text,
                title: docDocuments.title,
                fileName: docDocuments.fileName,
                fileType: docDocuments.fileType,
            })
            .from(docChunks)
            .innerJoin(docDocuments, eq(docDocuments.id, docChunks.documentId))
            .where(and(...filters))
            .limit(limit * 4)

        // 简单打分：命中词数 + 出现次数
        const lowerTerms = terms.map((t) => t.toLowerCase())
        const scored = rows.map((row) => {
            const lower = row.text.toLowerCase()
            let score = 0
            for (const term of lowerTerms) {
                const count = lower.split(term).length - 1
                if (count > 0) score += 1 + Math.min(count, 5) * 0.2
            }
            return { row, score }
        })
        scored.sort((a, b) => b.score - a.score)
        return scored.slice(0, limit).map(({ row }) => ({
            chunkId: String(row.chunkId),
            documentId: String(row.documentId),
            libraryId: String(row.libraryId),
            href: docLibraryDocumentPath(String(row.libraryId), String(row.documentId)),
            title: row.title,
            fileName: row.fileName,
            fileType: row.fileType,
            locator: row.locator ?? (row.page != null ? `p.${row.page}` : null),
            page: row.page,
            snippet: row.text.slice(0, 600),
        }))
    }

    // Postgres 分支：pg_trgm ILIKE 召回过滤 + word_similarity 打分排序（对中文更友好）
    const termConditions = terms.map((term) => {
        const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
        return ilike(docChunks.text, pattern)
    })
    if (termConditions.length > 0) {
        const combined = termConditions.length === 1 ? termConditions[0] : or(...termConditions)
        if (combined) filters.push(combined)
    }

    const rows = await getDb()
        .select({
            chunkId: docChunks.id,
            documentId: docChunks.documentId,
            libraryId: docChunks.libraryId,
            page: docChunks.page,
            locator: docChunks.locator,
            text: docChunks.text,
            title: docDocuments.title,
            fileName: docDocuments.fileName,
            fileType: docDocuments.fileType,
            score: sql<number>`word_similarity(${keyword}, ${docChunks.text})`.as("score"),
        })
        .from(docChunks)
        .innerJoin(docDocuments, eq(docDocuments.id, docChunks.documentId))
        .where(and(...filters))
        .orderBy(sql`score DESC`, asc(docChunks.chunkIndex))
        .limit(limit)

    return rows.map((row) => ({
        chunkId: String(row.chunkId),
        documentId: String(row.documentId),
        libraryId: String(row.libraryId),
        href: docLibraryDocumentPath(String(row.libraryId), String(row.documentId)),
        title: row.title,
        fileName: row.fileName,
        fileType: row.fileType,
        locator: row.locator ?? (row.page != null ? `p.${row.page}` : null),
        page: row.page,
        snippet: row.text.slice(0, 600),
    }))
}

export async function readDocumentChunks(input: {
    userId: number
    documentId: number
    fromIndex?: number
    limit?: number
}) {
    const doc = await getDocumentOrThrow(input.userId, input.documentId)
    const from = Math.max(input.fromIndex ?? 0, 0)
    const limit = Math.min(Math.max(input.limit ?? 12, 1), 40)
    const rows = await getDb()
        .select({
            chunkIndex: docChunks.chunkIndex,
            page: docChunks.page,
            locator: docChunks.locator,
            text: docChunks.text,
        })
        .from(docChunks)
        .where(eq(docChunks.documentId, input.documentId))
        .orderBy(asc(docChunks.chunkIndex))
        .limit(limit)
        .offset(from)
    return {
        documentId: String(doc.id),
        libraryId: String(doc.libraryId),
        href: docLibraryDocumentPath(String(doc.libraryId), String(doc.id)),
        title: doc.title,
        fileName: doc.fileName,
        fileType: doc.fileType,
        fromIndex: from,
        chunks: rows.map((row) => ({
            chunkIndex: row.chunkIndex,
            locator: row.locator ?? (row.page != null ? `p.${row.page}` : null),
            page: row.page,
            text: row.text,
        })),
    }
}

function toLibraryResponse(row: typeof docLibraries.$inferSelect) {
    return {
        id: String(row.id),
        name: row.name,
        description: row.description,
        color: row.color,
        icon: row.icon,
        documentCount: row.documentCount,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    }
}

function parseJsonArray(value: string | null | undefined): unknown[] {
    if (!value) return []
    try {
        const parsed = JSON.parse(value) as unknown
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

export function assertFileType(value: unknown): DocFileType {
    const v = String(value ?? "").toLowerCase()
    if ((FILE_TYPES as readonly string[]).includes(v)) return v as DocFileType
    throw badRequest("仅支持 PDF / docx / xlsx / csv")
}

function decrementDocumentCountSql() {
    return sql<number>`case when ${docLibraries.documentCount} > 0 then ${docLibraries.documentCount} - 1 else 0 end`
}

function normalizeOwnedDocumentObjectKey(
    objectKey: string,
    userId: number,
): { key: string } | { failure: S3DeleteFailure } {
    const key = stripS4KeyPrefix(objectKey).trim()
    if (!key) {
        return {
            failure: {
                errorMessage: "文档对象键为空",
                objectKey,
            },
        }
    }
    if (!key.startsWith(`uploads/${userId}/`)) {
        return {
            failure: {
                errorMessage: "文档对象键不属于当前用户，已跳过远程删除",
                objectKey: key,
            },
        }
    }
    return { key }
}

async function cleanupDocumentObjectKeys(
    userId: number,
    objectKeys: string[],
): Promise<DocumentStorageCleanupSummary> {
    const uniqueObjectKeys = [...new Set(objectKeys)]
    const normalizedKeys: string[] = []
    const failedObjectKeys: S3DeleteFailure[] = []

    for (const objectKey of uniqueObjectKeys) {
        const normalized = normalizeOwnedDocumentObjectKey(objectKey, userId)
        if ("failure" in normalized) {
            failedObjectKeys.push(normalized.failure)
        } else {
            normalizedKeys.push(normalized.key)
        }
    }

    if (normalizedKeys.length === 0) {
        return { deletedObjectKeys: [], failedObjectKeys }
    }

    try {
        const summary = await deleteS3Objects(getServerConfig().s3, normalizedKeys)
        return {
            deletedObjectKeys: summary.deletedObjectKeys,
            failedObjectKeys: [...failedObjectKeys, ...summary.failedObjectKeys],
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "未知错误"
        return {
            deletedObjectKeys: [],
            failedObjectKeys: [
                ...failedObjectKeys,
                ...normalizedKeys.map((objectKey) => ({ errorMessage, objectKey })),
            ],
        }
    }
}
