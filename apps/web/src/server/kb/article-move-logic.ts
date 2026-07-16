import { and, eq } from "drizzle-orm"
import { knowledgeBaseArticlePath } from "@/lib/dashboard-routes"
import { getDb } from "@/server/db/client"
import {
    knowledgeBaseArticles,
    knowledgeBaseNodes,
    knowledgeBaseWikiLinks,
    knowledgeBaseWikiPages,
    knowledgeBaseWikiTreeNodes,
} from "@/server/db/schema"
import { badRequest, notFound } from "@/server/http/response"
import { invalidatePublicArticleDetailCache, invalidatePublicArticleListCache } from "@/server/public-content-cache"
import { isDescendantKnowledgeBaseNode, moveNodeIdIntoSiblingOrder } from "@/server/kb/node-move-logic"
import { assertKnowledgeBaseOwner } from "@/server/kb/wiki-agent-logic"

export type MoveArticleInput = {
    userId: number
    articleId: number
    targetKnowledgeBaseId: number
    parentId?: number | null
    targetIndex?: number
}

export type MoveArticleResult = {
    articleId: string
    nodeId: string
    fromKnowledgeBaseId: string
    knowledgeBaseId: string
    parentId: string | null
    crossKnowledgeBase: boolean
    href: string
}

async function assertFolderParentInKb(
    userId: number,
    knowledgeBaseId: number,
    parentId: number | null,
) {
    if (parentId == null) return
    const [parent] = await getDb()
        .select({
            id: knowledgeBaseNodes.id,
            type: knowledgeBaseNodes.type,
            knowledgeBaseId: knowledgeBaseNodes.knowledgeBaseId,
        })
        .from(knowledgeBaseNodes)
        .where(and(eq(knowledgeBaseNodes.id, parentId), eq(knowledgeBaseNodes.userId, userId)))
        .limit(1)
    if (!parent || parent.knowledgeBaseId !== knowledgeBaseId || parent.type !== "FOLDER") {
        throw badRequest("父节点必须是目标知识库下的文件夹")
    }
}

async function rewriteSiblingSortOrders(
    userId: number,
    orderedIds: number[],
    updatedAt: Date,
    movingNodeId: number,
    valuesForMoving: { parentId: number | null; knowledgeBaseId?: number },
) {
    const db = getDb()
    for (const [index, id] of orderedIds.entries()) {
        const sortOrder = index + 1
        if (id === movingNodeId) {
            await db
                .update(knowledgeBaseNodes)
                .set({
                    parentId: valuesForMoving.parentId,
                    sortOrder,
                    updatedAt,
                    ...(valuesForMoving.knowledgeBaseId != null
                        ? { knowledgeBaseId: valuesForMoving.knowledgeBaseId }
                        : {}),
                })
                .where(and(eq(knowledgeBaseNodes.id, id), eq(knowledgeBaseNodes.userId, userId)))
            continue
        }
        await db
            .update(knowledgeBaseNodes)
            .set({ sortOrder, updatedAt })
            .where(and(eq(knowledgeBaseNodes.id, id), eq(knowledgeBaseNodes.userId, userId)))
    }
}

/** 将文章移到目标知识库（可同库改父节点/排序，也可跨库迁移）。 */
export async function moveArticle(input: MoveArticleInput): Promise<MoveArticleResult> {
    const db = getDb()
    const [article] = await db
        .select()
        .from(knowledgeBaseArticles)
        .where(and(
            eq(knowledgeBaseArticles.id, input.articleId),
            eq(knowledgeBaseArticles.userId, input.userId),
        ))
        .limit(1)
    if (!article) throw notFound("文章不存在")

    await assertKnowledgeBaseOwner(db, input.userId, input.targetKnowledgeBaseId)
    const targetParentId = input.parentId ?? null
    await assertFolderParentInKb(input.userId, input.targetKnowledgeBaseId, targetParentId)

    const [node] = await db
        .select()
        .from(knowledgeBaseNodes)
        .where(and(
            eq(knowledgeBaseNodes.id, article.nodeId),
            eq(knowledgeBaseNodes.userId, input.userId),
        ))
        .limit(1)
    if (!node) throw notFound("文章节点不存在")

    const crossKnowledgeBase = article.knowledgeBaseId !== input.targetKnowledgeBaseId
    const sourceParentId = node.parentId ?? null
    const updatedAt = new Date()

    if (!crossKnowledgeBase) {
        const allNodes = await db
            .select()
            .from(knowledgeBaseNodes)
            .where(and(
                eq(knowledgeBaseNodes.userId, input.userId),
                eq(knowledgeBaseNodes.knowledgeBaseId, article.knowledgeBaseId),
            ))

        if (targetParentId === node.id || isDescendantKnowledgeBaseNode(allNodes, node.id, targetParentId)) {
            throw badRequest("不能把节点移动到自身或子文件夹中")
        }

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

        if (sourceParentId !== targetParentId) {
            await rewriteSiblingSortOrders(input.userId, sourceOrder, updatedAt, node.id, {
                parentId: targetParentId,
            })
        }
        await rewriteSiblingSortOrders(input.userId, targetOrder, updatedAt, node.id, {
            parentId: targetParentId,
        })

        if (sourceParentId !== targetParentId) {
            invalidatePublicArticleListCache()
            invalidatePublicArticleDetailCache()
        }

        return {
            articleId: String(article.id),
            nodeId: String(node.id),
            fromKnowledgeBaseId: String(article.knowledgeBaseId),
            knowledgeBaseId: String(article.knowledgeBaseId),
            parentId: targetParentId == null ? null : String(targetParentId),
            crossKnowledgeBase: false,
            href: knowledgeBaseArticlePath(String(article.knowledgeBaseId), String(article.id)),
        }
    }

    // 跨知识库：更新 node + article 归属，并迁移该文的 wiki 衍生数据
    const sourceNodes = await db
        .select()
        .from(knowledgeBaseNodes)
        .where(and(
            eq(knowledgeBaseNodes.userId, input.userId),
            eq(knowledgeBaseNodes.knowledgeBaseId, article.knowledgeBaseId),
        ))
    const targetNodes = await db
        .select()
        .from(knowledgeBaseNodes)
        .where(and(
            eq(knowledgeBaseNodes.userId, input.userId),
            eq(knowledgeBaseNodes.knowledgeBaseId, input.targetKnowledgeBaseId),
        ))

    const sourceOrder = sourceNodes
        .filter((item) => (item.parentId ?? null) === sourceParentId)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
        .map((item) => item.id)
        .filter((id) => id !== node.id)

    const targetSiblingIds = targetNodes
        .filter((item) => (item.parentId ?? null) === targetParentId)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
        .map((item) => item.id)
    const targetOrder = moveNodeIdIntoSiblingOrder(targetSiblingIds, node.id, input.targetIndex)

    await db.transaction(async (tx) => {
        for (const [index, id] of sourceOrder.entries()) {
            await tx
                .update(knowledgeBaseNodes)
                .set({ sortOrder: index + 1, updatedAt })
                .where(and(eq(knowledgeBaseNodes.id, id), eq(knowledgeBaseNodes.userId, input.userId)))
        }

        for (const [index, id] of targetOrder.entries()) {
            if (id === node.id) {
                await tx
                    .update(knowledgeBaseNodes)
                    .set({
                        knowledgeBaseId: input.targetKnowledgeBaseId,
                        parentId: targetParentId,
                        sortOrder: index + 1,
                        updatedAt,
                    })
                    .where(and(eq(knowledgeBaseNodes.id, id), eq(knowledgeBaseNodes.userId, input.userId)))
                continue
            }
            await tx
                .update(knowledgeBaseNodes)
                .set({ sortOrder: index + 1, updatedAt })
                .where(and(eq(knowledgeBaseNodes.id, id), eq(knowledgeBaseNodes.userId, input.userId)))
        }

        await tx
            .update(knowledgeBaseArticles)
            .set({
                knowledgeBaseId: input.targetKnowledgeBaseId,
                updatedAt,
            })
            .where(and(
                eq(knowledgeBaseArticles.id, article.id),
                eq(knowledgeBaseArticles.userId, input.userId),
            ))

        await tx
            .update(knowledgeBaseWikiTreeNodes)
            .set({
                knowledgeBaseId: input.targetKnowledgeBaseId,
                updatedAt,
            })
            .where(and(
                eq(knowledgeBaseWikiTreeNodes.articleId, article.id),
                eq(knowledgeBaseWikiTreeNodes.userId, input.userId),
            ))

        const sourcePageKey = `source-${article.id}`
        const [sourcePage] = await tx
            .select({ id: knowledgeBaseWikiPages.id })
            .from(knowledgeBaseWikiPages)
            .where(and(
                eq(knowledgeBaseWikiPages.userId, input.userId),
                eq(knowledgeBaseWikiPages.knowledgeBaseId, article.knowledgeBaseId),
                eq(knowledgeBaseWikiPages.pageKey, sourcePageKey),
            ))
            .limit(1)

        if (sourcePage) {
            await tx
                .update(knowledgeBaseWikiPages)
                .set({
                    knowledgeBaseId: input.targetKnowledgeBaseId,
                    updatedAt,
                })
                .where(eq(knowledgeBaseWikiPages.id, sourcePage.id))

            await tx
                .update(knowledgeBaseWikiLinks)
                .set({ knowledgeBaseId: input.targetKnowledgeBaseId })
                .where(eq(knowledgeBaseWikiLinks.fromPageId, sourcePage.id))
        }
    })

    invalidatePublicArticleListCache()
    invalidatePublicArticleDetailCache()

    return {
        articleId: String(article.id),
        nodeId: String(node.id),
        fromKnowledgeBaseId: String(article.knowledgeBaseId),
        knowledgeBaseId: String(input.targetKnowledgeBaseId),
        parentId: targetParentId == null ? null : String(targetParentId),
        crossKnowledgeBase: true,
        href: knowledgeBaseArticlePath(String(input.targetKnowledgeBaseId), String(article.id)),
    }
}
