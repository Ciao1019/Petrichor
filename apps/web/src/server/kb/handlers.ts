import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm"
import { after, type NextRequest } from "next/server"
import { z } from "zod"
import { getServerConfig } from "@/config/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import {
    knowledgeBaseArticles,
    knowledgeBaseArticleTags,
    knowledgeBaseNodes,
    knowledgeBases,
    type KnowledgeBaseArticleRecord,
    type KnowledgeBaseNodeRecord,
    type KnowledgeBaseRecord,
} from "@/server/db/schema"
import { badRequest, notFound, ok, readJson, tableData, toErrorResponse } from "@/server/http/response"
import { resolvePagination } from "@/server/http/pagination"
import { invalidatePublicArticleDetailCache, invalidatePublicArticleListCache } from "@/server/public-content-cache"
import { buildPublicArticleMetadata } from "@/server/kb/share-logic"
import { buildArticleAiSummaryContentHash, resolveUsableArticleAiSummary } from "@/server/kb/article-summary-logic"
import { isDescendantKnowledgeBaseNode, moveNodeIdIntoSiblingOrder } from "@/server/kb/node-move-logic"
import { deleteS3Objects, extractS4ObjectKeysFromArticleContent } from "@/server/upload/s3-delete"

type Db = ReturnType<typeof getDb>
type User = Awaited<ReturnType<typeof requireCurrentUser>>

type TreeNodeResponse = {
    id: string
    parentId: string | null
    type: "FOLDER" | "ARTICLE"
    name: string
    articleId?: string | null
    sortOrder: number
    hasChildren: boolean
    children: TreeNodeResponse[]
}

const idSchema = z.union([z.string(), z.number()]).transform((value, ctx) => {
    const raw = String(value).trim()
    if (!/^\d+$/.test(raw)) {
        ctx.addIssue({
            code: "custom",
            message: "ID 必须是正整数",
        })
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

const paginationSchema = {
    isAsc: z.string().optional(),
    pageNum: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().optional(),
}

const knowledgeBaseListSchema = z.object({
    ...paginationSchema,
    orderByColumn: z.string().optional(),
})

const knowledgeBaseCreateSchema = z.object({
    description: z.string().trim().max(500).optional().nullable(),
    name: z.string().trim().min(1).max(120),
})

const knowledgeBaseUpdateSchema = knowledgeBaseCreateSchema.extend({
    knowledgeBaseId: idSchema,
})

const knowledgeBaseIdSchema = z.object({
    knowledgeBaseId: idSchema,
})

const nodeTreeSchema = z.object({
    ...paginationSchema,
    articleCreatedDateFrom: z.string().optional().nullable(),
    articleCreatedDateTo: z.string().optional().nullable(),
    keyword: z.string().trim().max(200).optional().default(""),
    knowledgeBaseId: idSchema,
    orderByColumn: z.string().optional(),
})

const nodeChildrenSchema = z.object({
    knowledgeBaseId: idSchema,
    parentId: optionalIdSchema.optional(),
})

const nodeDetailSchema = z.object({
    knowledgeBaseId: idSchema,
    nodeId: idSchema,
})

const moveNodeSchema = z.object({
    knowledgeBaseId: idSchema,
    nodeId: idSchema,
    targetIndex: z.coerce.number().int().min(0).optional(),
    targetParentId: optionalIdSchema.optional(),
})

const createFolderSchema = z.object({
    knowledgeBaseId: idSchema,
    name: z.string().trim().min(1).max(200),
    parentId: optionalIdSchema.optional(),
})

const updateFolderSchema = z.object({
    name: z.string().trim().min(1).max(200),
    nodeId: idSchema,
})

const deleteFolderSchema = z.object({
    nodeId: idSchema,
})

const createArticleSchema = z.object({
    contentJson: z.string().optional().nullable(),
    contentMd: z.string(),
    contentMetaJson: z.string().optional().nullable(),
    knowledgeBaseId: idSchema,
    parentId: optionalIdSchema.optional(),
    tags: z.array(z.string()).optional().default([]),
    title: z.string().trim().min(1).max(200),
})

const updateArticleSchema = z.object({
    articleId: idSchema,
    contentJson: z.string().optional().nullable(),
    contentMd: z.string(),
    contentMetaJson: z.string().optional().nullable(),
    tags: z.array(z.string()).optional().default([]),
    title: z.string().trim().min(1).max(200),
})

const articleIdSchema = z.object({
    articleId: idSchema,
})

function formatDate(value: Date | string | null | undefined): string {
    if (!value) {
        return ""
    }
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toKnowledgeBaseResponse(record: KnowledgeBaseRecord) {
    return {
        id: String(record.id),
        name: record.name,
        description: record.description,
        createdAt: formatDate(record.createdAt),
        updatedAt: formatDate(record.updatedAt),
    }
}

function normalizeTags(tags: string[]) {
    return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 50)
}

function parentFilter(parentId: number | null | undefined) {
    return parentId == null ? isNull(knowledgeBaseNodes.parentId) : eq(knowledgeBaseNodes.parentId, parentId)
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

async function assertNodeOwner(db: Db, userId: number, nodeId: number) {
    const [record] = await db
        .select()
        .from(knowledgeBaseNodes)
        .where(and(eq(knowledgeBaseNodes.id, nodeId), eq(knowledgeBaseNodes.userId, userId)))
        .limit(1)

    if (!record) {
        throw notFound("节点不存在")
    }

    return record
}

async function assertFolderParent(db: Db, userId: number, knowledgeBaseId: number, parentId: number | null | undefined) {
    if (parentId == null) {
        return
    }

    const parent = await assertNodeOwner(db, userId, parentId)
    if (parent.knowledgeBaseId !== knowledgeBaseId || parent.type !== "FOLDER") {
        throw badRequest("父节点必须是当前知识库下的文件夹")
    }
}

async function nextSortOrder(db: Db, userId: number, knowledgeBaseId: number, parentId: number | null | undefined) {
    const [last] = await db
        .select({ sortOrder: knowledgeBaseNodes.sortOrder })
        .from(knowledgeBaseNodes)
        .where(and(
            eq(knowledgeBaseNodes.userId, userId),
            eq(knowledgeBaseNodes.knowledgeBaseId, knowledgeBaseId),
            parentFilter(parentId),
        ))
        .orderBy(desc(knowledgeBaseNodes.sortOrder))
        .limit(1)

    return (last?.sortOrder ?? 0) + 1
}

async function loadKnowledgeBaseGraph(db: Db, userId: number, knowledgeBaseId: number) {
    const nodes = await db
        .select()
        .from(knowledgeBaseNodes)
        .where(and(eq(knowledgeBaseNodes.userId, userId), eq(knowledgeBaseNodes.knowledgeBaseId, knowledgeBaseId)))
        .orderBy(asc(knowledgeBaseNodes.sortOrder), asc(knowledgeBaseNodes.id))

    const articleNodeIds = nodes.filter((node) => node.type === "ARTICLE").map((node) => node.id)
    const articles = articleNodeIds.length > 0
        ? await db
            .select()
            .from(knowledgeBaseArticles)
            .where(and(eq(knowledgeBaseArticles.userId, userId), inArray(knowledgeBaseArticles.nodeId, articleNodeIds)))
        : []

    return { nodes, articles }
}

function indexGraph(
    nodes: KnowledgeBaseNodeRecord[],
    articles: KnowledgeBaseArticleRecord[],
) {
    return {
        articleByNodeId: new Map(articles.map((article) => [article.nodeId, article])),
        nodeById: new Map(nodes.map((node) => [node.id, node])),
    }
}

function buildPath(nodeById: Map<number, KnowledgeBaseNodeRecord>, nodeId: number) {
    const names: string[] = []
    const visited = new Set<number>()
    let current = nodeById.get(nodeId)

    while (current && !visited.has(current.id)) {
        visited.add(current.id)
        names.unshift(current.name)
        current = current.parentId == null ? undefined : nodeById.get(current.parentId)
    }

    return names.join(" / ")
}

function buildTree(
    nodes: KnowledgeBaseNodeRecord[],
    articleByNodeId: Map<number, KnowledgeBaseArticleRecord>,
    parentId: number | null,
): TreeNodeResponse[] {
    return nodes
        .filter((node) => (node.parentId ?? null) === parentId)
        .map((node) => {
            const children = buildTree(nodes, articleByNodeId, node.id)
            const article = articleByNodeId.get(node.id)

            return {
                id: String(node.id),
                parentId: node.parentId == null ? null : String(node.parentId),
                type: node.type as "FOLDER" | "ARTICLE",
                name: node.name,
                articleId: article ? String(article.id) : null,
                sortOrder: node.sortOrder,
                hasChildren: children.length > 0,
                children,
            }
        })
}

function filterTreeByKeyword(nodes: TreeNodeResponse[], keyword: string): TreeNodeResponse[] {
    const needle = keyword.trim().toLowerCase()
    if (!needle) {
        return nodes
    }

    return nodes.flatMap((node) => {
        const children = filterTreeByKeyword(node.children, needle)
        const matched = node.name.toLowerCase().includes(needle)
        if (!matched && children.length === 0) {
            return []
        }
        return [{ ...node, children, hasChildren: children.length > 0 }]
    })
}

function flattenRootChildrenForChildrenEndpoint(
    nodes: KnowledgeBaseNodeRecord[],
    articleByNodeId: Map<number, KnowledgeBaseArticleRecord>,
    parentId: number | null,
) {
    return buildTree(nodes, articleByNodeId, parentId).map((node) => ({
        ...node,
        children: [],
    }))
}

async function replaceArticleTags(db: Db, articleId: number, tags: string[]) {
    await db.delete(knowledgeBaseArticleTags).where(eq(knowledgeBaseArticleTags.articleId, articleId))
    const normalized = normalizeTags(tags)
    if (normalized.length > 0) {
        await db.insert(knowledgeBaseArticleTags).values(normalized.map((tag) => ({ articleId, tag })))
    }
}

async function loadTags(db: Db, articleId: number) {
    const rows = await db
        .select({ tag: knowledgeBaseArticleTags.tag })
        .from(knowledgeBaseArticleTags)
        .where(eq(knowledgeBaseArticleTags.articleId, articleId))
        .orderBy(asc(knowledgeBaseArticleTags.tag))

    return rows.map((row) => row.tag)
}

function collectArticleS4ObjectKeys(
    articles: Array<Pick<KnowledgeBaseArticleRecord, "contentJson" | "contentMd">>,
    userId: number,
) {
    const keys = new Set<string>()
    for (const article of articles) {
        for (const key of extractS4ObjectKeysFromArticleContent(article, userId)) {
            keys.add(key)
        }
    }
    return [...keys]
}

async function loadReferencedS4ObjectKeys(db: Db, userId: number, candidateKeys: string[]) {
    const candidateSet = new Set(candidateKeys)
    const referenced = new Set<string>()
    if (candidateSet.size === 0) {
        return referenced
    }

    const rows = await db
        .select({
            contentJson: knowledgeBaseArticles.contentJson,
            contentMd: knowledgeBaseArticles.contentMd,
        })
        .from(knowledgeBaseArticles)
        .where(eq(knowledgeBaseArticles.userId, userId))

    for (const row of rows) {
        for (const key of extractS4ObjectKeysFromArticleContent(row, userId)) {
            if (candidateSet.has(key)) {
                referenced.add(key)
            }
        }
    }
    return referenced
}

function describeCleanupError(error: unknown) {
    if (error instanceof Error) {
        return {
            message: error.message,
            name: error.name,
        }
    }
    return error
}

async function cleanupUnreferencedS4Objects(
    userId: number,
    candidateKeys: string[],
    context: { action: string },
) {
    const uniqueCandidateKeys = [...new Set(candidateKeys)]
    if (uniqueCandidateKeys.length === 0) {
        return
    }

    try {
        const db = getDb()
        const referencedKeys = await loadReferencedS4ObjectKeys(db, userId, uniqueCandidateKeys)
        const deletableKeys = uniqueCandidateKeys.filter((key) => !referencedKeys.has(key))
        if (deletableKeys.length === 0) {
            return
        }

        const config = getServerConfig().s3
        if (!config) {
            console.warn("[S4 cleanup] 跳过文章图片清理：S3 存储未配置", {
                action: context.action,
                objectKeyCount: deletableKeys.length,
                userId,
            })
            return
        }

        const summary = await deleteS3Objects(config, deletableKeys)
        if (summary.deletedObjectKeys.length > 0) {
            console.info("[S4 cleanup] 已清理文章图片对象", {
                action: context.action,
                deletedObjectKeyCount: summary.deletedObjectKeys.length,
                userId,
            })
        }
        if (summary.failedObjectKeys.length > 0) {
            console.warn("[S4 cleanup] 部分文章图片对象清理失败", {
                action: context.action,
                failedObjectKeys: summary.failedObjectKeys,
                userId,
            })
        }
    } catch (error) {
        console.warn("[S4 cleanup] 文章图片清理流程失败，已保留文章保存/删除结果", {
            action: context.action,
            error: describeCleanupError(error),
            objectKeyCount: uniqueCandidateKeys.length,
            userId,
        })
    }
}

function scheduleUnreferencedS4Cleanup(
    userId: number,
    candidateKeys: string[],
    context: { action: string },
) {
    const uniqueCandidateKeys = [...new Set(candidateKeys)]
    if (uniqueCandidateKeys.length === 0) {
        return
    }

    const task = () => cleanupUnreferencedS4Objects(userId, uniqueCandidateKeys, context)

    try {
        after(task)
    } catch (error) {
        // 单元测试或非 Next 请求作用域没有 after 上下文，降级到事件循环后执行。
        console.warn("[S4 cleanup] Next after 不可用，降级为事件循环异步清理", {
            action: context.action,
            error: describeCleanupError(error),
            objectKeyCount: uniqueCandidateKeys.length,
            userId,
        })
        setTimeout(() => {
            void task()
        }, 0)
    }
}

async function withUser(request: NextRequest, handler: (user: User) => Promise<Response>) {
    try {
        const user = await requireCurrentUser(request)
        return await handler(user)
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function listKnowledgeBases(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = knowledgeBaseListSchema.parse(await readJson(request))
        const db = getDb()
        const { limit, offset, asc: isAsc } = resolvePagination(input)
        const orderBy = isAsc ? asc(knowledgeBases.updatedAt) : desc(knowledgeBases.updatedAt)

        const [totalRow] = await db
            .select({ total: count() })
            .from(knowledgeBases)
            .where(eq(knowledgeBases.userId, user.id))

        const rows = await db
            .select()
            .from(knowledgeBases)
            .where(eq(knowledgeBases.userId, user.id))
            .orderBy(orderBy)
            .limit(limit)
            .offset(offset)

        return tableData(rows.map(toKnowledgeBaseResponse), totalRow?.total ?? 0)
    })
}

export async function createKnowledgeBase(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = knowledgeBaseCreateSchema.parse(await readJson(request))
        const [record] = await getDb()
            .insert(knowledgeBases)
            .values({
                userId: user.id,
                name: input.name,
                description: input.description || null,
            })
            .returning()

        return ok(toKnowledgeBaseResponse(record))
    })
}

export async function detailKnowledgeBase(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = knowledgeBaseIdSchema.parse(await readJson(request))
        const record = await assertKnowledgeBaseOwner(getDb(), user.id, input.knowledgeBaseId)
        return ok(toKnowledgeBaseResponse(record))
    })
}

export async function updateKnowledgeBase(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = knowledgeBaseUpdateSchema.parse(await readJson(request))
        await assertKnowledgeBaseOwner(getDb(), user.id, input.knowledgeBaseId)
        const [record] = await getDb()
            .update(knowledgeBases)
            .set({
                name: input.name,
                description: input.description || null,
                updatedAt: new Date(),
            })
            .where(and(eq(knowledgeBases.id, input.knowledgeBaseId), eq(knowledgeBases.userId, user.id)))
            .returning()

        return ok(toKnowledgeBaseResponse(record))
    })
}

export async function deleteKnowledgeBase(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = knowledgeBaseIdSchema.parse(await readJson(request))
        const db = getDb()
        await assertKnowledgeBaseOwner(db, user.id, input.knowledgeBaseId)
        const articles = await db
            .select()
            .from(knowledgeBaseArticles)
            .where(and(eq(knowledgeBaseArticles.userId, user.id), eq(knowledgeBaseArticles.knowledgeBaseId, input.knowledgeBaseId)))
        const imageObjectKeys = collectArticleS4ObjectKeys(articles, user.id)

        await db
            .delete(knowledgeBases)
            .where(and(eq(knowledgeBases.id, input.knowledgeBaseId), eq(knowledgeBases.userId, user.id)))

        scheduleUnreferencedS4Cleanup(user.id, imageObjectKeys, { action: "deleteKnowledgeBase" })

        invalidatePublicArticleListCache()
        invalidatePublicArticleDetailCache()
        return ok({ knowledgeBaseId: String(input.knowledgeBaseId) })
    })
}

export async function treeNodes(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = nodeTreeSchema.parse(await readJson(request))
        await assertKnowledgeBaseOwner(getDb(), user.id, input.knowledgeBaseId)
        const graph = await loadKnowledgeBaseGraph(getDb(), user.id, input.knowledgeBaseId)
        const indexed = indexGraph(graph.nodes, graph.articles)
        const roots = filterTreeByKeyword(buildTree(graph.nodes, indexed.articleByNodeId, null), input.keyword)

        return ok({
            knowledgeBaseId: String(input.knowledgeBaseId),
            pageNum: input.pageNum ?? 1,
            pageSize: input.pageSize ?? 20,
            totalFolders: roots.filter((node) => node.type === "FOLDER").length,
            roots,
        })
    })
}

export async function rootNodes(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = nodeTreeSchema.parse(await readJson(request))
        await assertKnowledgeBaseOwner(getDb(), user.id, input.knowledgeBaseId)
        const graph = await loadKnowledgeBaseGraph(getDb(), user.id, input.knowledgeBaseId)
        const indexed = indexGraph(graph.nodes, graph.articles)
        const roots = filterTreeByKeyword(buildTree(graph.nodes, indexed.articleByNodeId, null), input.keyword)
            .map((node) => ({ ...node, children: [] }))
        const { limit, offset } = resolvePagination(input)

        return ok({
            knowledgeBaseId: String(input.knowledgeBaseId),
            pageNum: input.pageNum ?? 1,
            pageSize: input.pageSize ?? 20,
            totalFolders: roots.filter((node) => node.type === "FOLDER").length,
            roots: roots.slice(offset, offset + limit),
        })
    })
}

export async function childNodes(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = nodeChildrenSchema.parse(await readJson(request))
        await assertKnowledgeBaseOwner(getDb(), user.id, input.knowledgeBaseId)
        if (input.parentId != null) {
            await assertFolderParent(getDb(), user.id, input.knowledgeBaseId, input.parentId)
        }
        const graph = await loadKnowledgeBaseGraph(getDb(), user.id, input.knowledgeBaseId)
        const indexed = indexGraph(graph.nodes, graph.articles)

        return ok({
            knowledgeBaseId: String(input.knowledgeBaseId),
            parentId: input.parentId == null ? null : String(input.parentId),
            nodes: flattenRootChildrenForChildrenEndpoint(
                graph.nodes,
                indexed.articleByNodeId,
                input.parentId ?? null,
            ),
        })
    })
}

export async function detailNode(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = nodeDetailSchema.parse(await readJson(request))
        await assertKnowledgeBaseOwner(getDb(), user.id, input.knowledgeBaseId)
        const node = await assertNodeOwner(getDb(), user.id, input.nodeId)
        if (node.knowledgeBaseId !== input.knowledgeBaseId) {
            throw notFound("节点不存在")
        }
        const graph = await loadKnowledgeBaseGraph(getDb(), user.id, input.knowledgeBaseId)
        const indexed = indexGraph(graph.nodes, graph.articles)
        const article = indexed.articleByNodeId.get(node.id)

        return ok({
            knowledgeBaseId: String(input.knowledgeBaseId),
            nodeId: String(node.id),
            parentId: node.parentId == null ? null : String(node.parentId),
            type: node.type,
            name: node.name,
            path: buildPath(indexed.nodeById, node.id),
            articleId: article ? String(article.id) : null,
        })
    })
}

export async function moveNode(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = moveNodeSchema.parse(await readJson(request))
        const db = getDb()
        await assertKnowledgeBaseOwner(db, user.id, input.knowledgeBaseId)

        const node = await assertNodeOwner(db, user.id, input.nodeId)
        if (node.knowledgeBaseId !== input.knowledgeBaseId) {
            throw notFound("节点不存在")
        }

        const targetParentId = input.targetParentId ?? null
        await assertFolderParent(db, user.id, input.knowledgeBaseId, targetParentId)

        const allNodes = await db
            .select()
            .from(knowledgeBaseNodes)
            .where(and(
                eq(knowledgeBaseNodes.userId, user.id),
                eq(knowledgeBaseNodes.knowledgeBaseId, input.knowledgeBaseId),
            ))

        if (targetParentId === node.id || isDescendantKnowledgeBaseNode(allNodes, node.id, targetParentId)) {
            throw badRequest("不能把文件夹移动到自身或子文件夹中")
        }

        const sourceParentId = node.parentId ?? null
        const sourceSiblings = allNodes
            .filter((item) => (item.parentId ?? null) === sourceParentId)
            .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
        const targetSiblings = allNodes
            .filter((item) => (item.parentId ?? null) === targetParentId)
            .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)

        const targetOrder = moveNodeIdIntoSiblingOrder(
            targetSiblings.map((item) => item.id),
            node.id,
            input.targetIndex,
        )
        const sourceOrder = sourceParentId === targetParentId
            ? targetOrder
            : sourceSiblings.map((item) => item.id).filter((id) => id !== node.id)

        const updatedAt = new Date()
        if (sourceParentId !== targetParentId) {
            for (const [index, id] of sourceOrder.entries()) {
                await db
                    .update(knowledgeBaseNodes)
                    .set({ sortOrder: index + 1, updatedAt })
                    .where(and(eq(knowledgeBaseNodes.id, id), eq(knowledgeBaseNodes.userId, user.id)))
            }
        }

        for (const [index, id] of targetOrder.entries()) {
            const values = id === node.id
                ? { parentId: targetParentId, sortOrder: index + 1, updatedAt }
                : { sortOrder: index + 1, updatedAt }

            await db
                .update(knowledgeBaseNodes)
                .set(values)
                .where(and(eq(knowledgeBaseNodes.id, id), eq(knowledgeBaseNodes.userId, user.id)))
        }

        if (sourceParentId !== targetParentId) {
            invalidatePublicArticleListCache()
            invalidatePublicArticleDetailCache()
        }

        return ok({
            knowledgeBaseId: String(input.knowledgeBaseId),
            nodeId: String(node.id),
            parentId: targetParentId == null ? null : String(targetParentId),
            orderedNodeIds: targetOrder.map(String),
        })
    })
}

export async function createFolder(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = createFolderSchema.parse(await readJson(request))
        const db = getDb()
        await assertKnowledgeBaseOwner(db, user.id, input.knowledgeBaseId)
        await assertFolderParent(db, user.id, input.knowledgeBaseId, input.parentId)
        const sortOrder = await nextSortOrder(db, user.id, input.knowledgeBaseId, input.parentId)
        const [node] = await db
            .insert(knowledgeBaseNodes)
            .values({
                userId: user.id,
                knowledgeBaseId: input.knowledgeBaseId,
                parentId: input.parentId ?? null,
                type: "FOLDER",
                name: input.name,
                sortOrder,
            })
            .returning()

        return ok({ nodeId: String(node.id) })
    })
}

export async function updateFolder(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = updateFolderSchema.parse(await readJson(request))
        const node = await assertNodeOwner(getDb(), user.id, input.nodeId)
        if (node.type !== "FOLDER") {
            throw badRequest("只能重命名文件夹")
        }

        await getDb()
            .update(knowledgeBaseNodes)
            .set({ name: input.name, updatedAt: new Date() })
            .where(and(eq(knowledgeBaseNodes.id, input.nodeId), eq(knowledgeBaseNodes.userId, user.id)))

        return ok({ nodeId: String(input.nodeId) })
    })
}

export async function deleteFolder(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = deleteFolderSchema.parse(await readJson(request))
        const db = getDb()
        const node = await assertNodeOwner(db, user.id, input.nodeId)
        if (node.type !== "FOLDER") {
            throw badRequest("只能删除文件夹")
        }
        const allNodes = await db
            .select()
            .from(knowledgeBaseNodes)
            .where(and(eq(knowledgeBaseNodes.userId, user.id), eq(knowledgeBaseNodes.knowledgeBaseId, node.knowledgeBaseId)))

        const ids = new Set<number>([node.id])
        let changed = true
        while (changed) {
            changed = false
            for (const item of allNodes) {
                if (item.parentId != null && ids.has(item.parentId) && !ids.has(item.id)) {
                    ids.add(item.id)
                    changed = true
                }
            }
        }

        const nodeIds = [...ids]
        const articleRows = await db
            .select()
            .from(knowledgeBaseArticles)
            .where(and(eq(knowledgeBaseArticles.userId, user.id), inArray(knowledgeBaseArticles.nodeId, nodeIds)))
        const articleIds = articleRows.map((article) => article.id)
        const imageObjectKeys = collectArticleS4ObjectKeys(articleRows, user.id)

        if (articleIds.length > 0) {
            await db.delete(knowledgeBaseArticleTags).where(inArray(knowledgeBaseArticleTags.articleId, articleIds))
        }
        await db.delete(knowledgeBaseArticles).where(and(eq(knowledgeBaseArticles.userId, user.id), inArray(knowledgeBaseArticles.nodeId, nodeIds)))
        await db.delete(knowledgeBaseNodes).where(and(eq(knowledgeBaseNodes.userId, user.id), inArray(knowledgeBaseNodes.id, nodeIds)))
        scheduleUnreferencedS4Cleanup(user.id, imageObjectKeys, { action: "deleteFolder" })

        if (articleIds.length > 0) {
            invalidatePublicArticleListCache()
            invalidatePublicArticleDetailCache()
        }
        return ok({ nodeId: String(input.nodeId) })
    })
}

export async function createArticle(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = createArticleSchema.parse(await readJson(request))
        const db = getDb()
        await assertKnowledgeBaseOwner(db, user.id, input.knowledgeBaseId)
        await assertFolderParent(db, user.id, input.knowledgeBaseId, input.parentId)
        const sortOrder = await nextSortOrder(db, user.id, input.knowledgeBaseId, input.parentId)

        const [node] = await db
            .insert(knowledgeBaseNodes)
            .values({
                userId: user.id,
                knowledgeBaseId: input.knowledgeBaseId,
                parentId: input.parentId ?? null,
                type: "ARTICLE",
                name: input.title,
                sortOrder,
            })
            .returning()

        const [article] = await db
            .insert(knowledgeBaseArticles)
            .values({
                userId: user.id,
                knowledgeBaseId: input.knowledgeBaseId,
                nodeId: node.id,
                title: input.title,
                contentMd: input.contentMd,
                contentJson: input.contentJson || null,
                contentMetaJson: input.contentMetaJson || null,
                ...buildPublicArticleMetadata(input.contentMd),
            })
            .returning()

        await replaceArticleTags(db, article.id, input.tags)

        return ok({
            articleId: String(article.id),
            nodeId: String(node.id),
        })
    })
}

export async function detailArticle(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = articleIdSchema.parse(await readJson(request))
        const db = getDb()
        const [article] = await db
            .select()
            .from(knowledgeBaseArticles)
            .where(and(eq(knowledgeBaseArticles.id, input.articleId), eq(knowledgeBaseArticles.userId, user.id)))
            .limit(1)
        if (!article) {
            throw notFound("文章不存在")
        }

        const node = await assertNodeOwner(db, user.id, article.nodeId)
        const graph = await loadKnowledgeBaseGraph(db, user.id, article.knowledgeBaseId)
        const indexed = indexGraph(graph.nodes, graph.articles)
        const tags = await loadTags(db, article.id)
        const currentSummaryHash = buildArticleAiSummaryContentHash(article.contentMd)
        const usableAiSummary = resolveUsableArticleAiSummary({
            summary: article.aiSummary,
            summaryContentHash: article.aiSummaryContentHash,
            currentContentHash: currentSummaryHash,
        })

        return ok({
            articleId: String(article.id),
            nodeId: String(article.nodeId),
            knowledgeBaseId: String(article.knowledgeBaseId),
            parentId: node.parentId == null ? null : String(node.parentId),
            title: article.title,
            contentMd: article.contentMd,
            contentJson: article.contentJson,
            contentMetaJson: article.contentMetaJson,
            aiSummary: article.aiSummary?.trim() || null,
            aiSummaryGeneratedAt: formatDateOrNull(article.aiSummaryGeneratedAt),
            aiSummaryStale: Boolean(article.aiSummary?.trim()) && !usableAiSummary,
            tags,
            path: buildPath(indexed.nodeById, node.id),
            permission: "OWNER",
            readOnly: false,
            createdAt: formatDate(article.createdAt),
            updatedAt: formatDate(article.updatedAt),
        })
    })
}

function formatDateOrNull(value: Date | string | null | undefined): string | null {
    if (!value) {
        return null
    }
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export async function updateArticle(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = updateArticleSchema.parse(await readJson(request))
        const db = getDb()
        const [article] = await db
            .select()
            .from(knowledgeBaseArticles)
            .where(and(eq(knowledgeBaseArticles.id, input.articleId), eq(knowledgeBaseArticles.userId, user.id)))
            .limit(1)
        if (!article) {
            throw notFound("文章不存在")
        }
        const previousImageObjectKeys = new Set(extractS4ObjectKeysFromArticleContent(article, user.id))
        const nextImageObjectKeys = new Set(extractS4ObjectKeysFromArticleContent({
            contentJson: input.contentJson,
            contentMd: input.contentMd,
        }, user.id))
        const removedImageObjectKeys = [...previousImageObjectKeys].filter((key) => !nextImageObjectKeys.has(key))

        await db
            .update(knowledgeBaseArticles)
            .set({
                title: input.title,
                contentMd: input.contentMd,
                contentJson: input.contentJson || null,
                contentMetaJson: input.contentMetaJson || null,
                ...buildPublicArticleMetadata(input.contentMd),
                updatedAt: new Date(),
            })
            .where(and(eq(knowledgeBaseArticles.id, input.articleId), eq(knowledgeBaseArticles.userId, user.id)))

        await db
            .update(knowledgeBaseNodes)
            .set({ name: input.title, updatedAt: new Date() })
            .where(and(eq(knowledgeBaseNodes.id, article.nodeId), eq(knowledgeBaseNodes.userId, user.id)))

        await replaceArticleTags(db, article.id, input.tags)
        scheduleUnreferencedS4Cleanup(user.id, removedImageObjectKeys, { action: "updateArticle" })

        invalidatePublicArticleListCache()
        invalidatePublicArticleDetailCache()
        return ok({
            articleId: String(article.id),
            nodeId: String(article.nodeId),
        })
    })
}

export async function refreshArticlePublicCache(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = articleIdSchema.parse(await readJson(request))
        const [article] = await getDb()
            .select({ id: knowledgeBaseArticles.id })
            .from(knowledgeBaseArticles)
            .where(and(eq(knowledgeBaseArticles.id, input.articleId), eq(knowledgeBaseArticles.userId, user.id)))
            .limit(1)
        if (!article) {
            throw notFound("文章不存在")
        }

        invalidatePublicArticleListCache()
        invalidatePublicArticleDetailCache()

        return ok({
            articleId: String(article.id),
            refreshedAt: new Date().toISOString(),
        })
    })
}

export async function deleteArticle(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = articleIdSchema.parse(await readJson(request))
        const db = getDb()
        const [article] = await db
            .select()
            .from(knowledgeBaseArticles)
            .where(and(eq(knowledgeBaseArticles.id, input.articleId), eq(knowledgeBaseArticles.userId, user.id)))
            .limit(1)
        if (!article) {
            throw notFound("文章不存在")
        }
        const imageObjectKeys = extractS4ObjectKeysFromArticleContent(article, user.id)

        await db.delete(knowledgeBaseArticleTags).where(eq(knowledgeBaseArticleTags.articleId, article.id))
        await db.delete(knowledgeBaseArticles).where(and(eq(knowledgeBaseArticles.id, article.id), eq(knowledgeBaseArticles.userId, user.id)))
        await db.delete(knowledgeBaseNodes).where(and(eq(knowledgeBaseNodes.id, article.nodeId), eq(knowledgeBaseNodes.userId, user.id)))
        scheduleUnreferencedS4Cleanup(user.id, imageObjectKeys, { action: "deleteArticle" })

        invalidatePublicArticleListCache()
        invalidatePublicArticleDetailCache()
        return ok({
            articleId: String(article.id),
            nodeId: String(article.nodeId),
        })
    })
}
