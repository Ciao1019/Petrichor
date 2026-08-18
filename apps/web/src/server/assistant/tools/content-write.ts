import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { knowledgeBaseArticlePath } from "@/lib/dashboard-routes"
import { getDb } from "@/server/db/client"
import {
    knowledgeBaseArticleShares,
    knowledgeBaseArticleTags,
    knowledgeBaseArticles,
    knowledgeBaseNodes,
} from "@/server/db/schema"
import { deleteDocument } from "@/server/doc-library/library-logic"
import { badRequest, notFound } from "@/server/http/response"
import { moveArticle } from "@/server/kb/article-move-logic"
import { buildPublicArticleMetadata } from "@/server/kb/share-logic"
import { assertKnowledgeBaseOwner, deleteArticleWikiPages } from "@/server/kb/wiki-agent-logic"
import type { AssistantToolContext, AssistantToolRegistration } from "../domain-types"
import { buildRequestUserConfirmationTool } from "../confirmation"

const idSchema = z.union([z.string(), z.number()]).transform((value, ctx) => {
    const raw = String(value).trim()
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
        ctx.addIssue({ code: "custom", message: "ID 必须是正整数" })
        return z.NEVER
    }
    return Number(raw)
})

const createArticleSchema = z.object({
    knowledgeBaseId: idSchema,
    title: z.string().trim().min(1).max(200),
    contentMd: z.string().default(""),
    parentId: idSchema.optional().nullable(),
})

const updateArticleSchema = z.object({
    articleId: idSchema,
    title: z.string().trim().min(1).max(200).optional(),
    contentMd: z.string().optional(),
}).superRefine((value, ctx) => {
    if (value.title == null && value.contentMd == null) {
        ctx.addIssue({ code: "custom", message: "至少提供 title 或 contentMd" })
    }
})

const articleIdSchema = z.object({ articleId: idSchema })
const documentIdSchema = z.object({ documentId: idSchema })

const moveArticleSchema = z.object({
    articleId: idSchema,
    targetKnowledgeBaseId: idSchema,
    parentId: idSchema.optional().nullable(),
    targetIndex: z.number().int().min(0).optional(),
})

function generateShareCode() {
    return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

async function nextSortOrder(userId: number, knowledgeBaseId: number, parentId: number | null) {
    const rows = await getDb()
        .select({ sortOrder: knowledgeBaseNodes.sortOrder, parentId: knowledgeBaseNodes.parentId })
        .from(knowledgeBaseNodes)
        .where(and(
            eq(knowledgeBaseNodes.userId, userId),
            eq(knowledgeBaseNodes.knowledgeBaseId, knowledgeBaseId),
        ))
    const siblings = rows.filter((row) => (row.parentId ?? null) === parentId)
    const max = siblings.reduce((acc, row) => Math.max(acc, row.sortOrder ?? 0), 0)
    return max + 1
}

async function requireArticleOwner(userId: number, articleId: number) {
    const [article] = await getDb()
        .select()
        .from(knowledgeBaseArticles)
        .where(and(eq(knowledgeBaseArticles.id, articleId), eq(knowledgeBaseArticles.userId, userId)))
        .limit(1)
    if (!article) throw notFound("文章不存在")
    return article
}

export async function createArticleForAssistant(ctx: AssistantToolContext, raw: unknown) {
    const input = createArticleSchema.parse(raw)
    const db = getDb()
    await assertKnowledgeBaseOwner(db, ctx.userId, input.knowledgeBaseId)
    if (input.parentId != null) {
        const [parent] = await db
            .select({ id: knowledgeBaseNodes.id })
            .from(knowledgeBaseNodes)
            .where(and(
                eq(knowledgeBaseNodes.id, input.parentId),
                eq(knowledgeBaseNodes.userId, ctx.userId),
                eq(knowledgeBaseNodes.knowledgeBaseId, input.knowledgeBaseId),
            ))
            .limit(1)
        if (!parent) throw badRequest("父节点不存在或不属于该知识库")
    }

    const sortOrder = await nextSortOrder(ctx.userId, input.knowledgeBaseId, input.parentId ?? null)
    const [node] = await db
        .insert(knowledgeBaseNodes)
        .values({
            userId: ctx.userId,
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
            userId: ctx.userId,
            knowledgeBaseId: input.knowledgeBaseId,
            nodeId: node.id,
            title: input.title,
            contentMd: input.contentMd,
            ...buildPublicArticleMetadata(input.contentMd),
        })
        .returning()

    return {
        articleId: String(article.id),
        nodeId: String(node.id),
        title: article.title,
        href: knowledgeBaseArticlePath(String(input.knowledgeBaseId), String(article.id)),
    }
}

export async function updateArticleForAssistant(ctx: AssistantToolContext, raw: unknown) {
    const input = updateArticleSchema.parse(raw)
    const article = await requireArticleOwner(ctx.userId, input.articleId)
    const title = input.title ?? article.title
    const contentMd = input.contentMd ?? article.contentMd
    const db = getDb()

    await db
        .update(knowledgeBaseArticles)
        .set({
            title,
            contentMd,
            ...buildPublicArticleMetadata(contentMd),
            updatedAt: new Date(),
        })
        .where(and(eq(knowledgeBaseArticles.id, article.id), eq(knowledgeBaseArticles.userId, ctx.userId)))

    if (input.title != null) {
        await db
            .update(knowledgeBaseNodes)
            .set({ name: title, updatedAt: new Date() })
            .where(and(eq(knowledgeBaseNodes.id, article.nodeId), eq(knowledgeBaseNodes.userId, ctx.userId)))
    }

    return {
        articleId: String(article.id),
        title,
        href: knowledgeBaseArticlePath(String(article.knowledgeBaseId), String(article.id)),
    }
}

/** 简单行级 unified diff（足够给模型/用户预览；非完整 Myers） */
export function buildUnifiedDiff(before: string, after: string, label = "content"): string {
    const a = before.replace(/\r\n/g, "\n").split("\n")
    const b = after.replace(/\r\n/g, "\n").split("\n")
    const lines: string[] = [`--- a/${label}`, `+++ b/${label}`]
    const max = Math.max(a.length, b.length)
    let hunkOpen = false
    for (let i = 0; i < max; i += 1) {
        const left = a[i]
        const right = b[i]
        if (left === right) {
            if (hunkOpen && left !== undefined) lines.push(` ${left}`)
            continue
        }
        if (!hunkOpen) {
            lines.push(`@@ line ${i + 1} @@`)
            hunkOpen = true
        }
        if (left !== undefined) lines.push(`-${left}`)
        if (right !== undefined) lines.push(`+${right}`)
    }
    if (lines.length <= 2) return `${lines[0]}\n${lines[1]}\n@@ unchanged @@\n`
    return lines.join("\n")
}

export async function previewArticleUpdateForAssistant(ctx: AssistantToolContext, raw: unknown) {
    const input = updateArticleSchema.parse(raw)
    const article = await requireArticleOwner(ctx.userId, input.articleId)
    const nextTitle = input.title ?? article.title
    const nextContent = input.contentMd ?? article.contentMd
    const titleChanged = input.title != null && input.title !== article.title
    const contentChanged = input.contentMd != null && input.contentMd !== article.contentMd
    if (!titleChanged && !contentChanged) {
        return {
            ok: true,
            dryRun: true,
            articleId: String(article.id),
            changed: false,
            message: "与当前内容相同，无需更新",
        }
    }
    return {
        ok: true,
        dryRun: true,
        articleId: String(article.id),
        changed: true,
        title: {
            before: article.title,
            after: nextTitle,
            changed: titleChanged,
        },
        contentDiff: contentChanged
            ? buildUnifiedDiff(article.contentMd ?? "", nextContent, "content.md")
            : null,
        contentStats: {
            beforeChars: (article.contentMd ?? "").length,
            afterChars: nextContent.length,
        },
        href: knowledgeBaseArticlePath(String(article.knowledgeBaseId), String(article.id)),
        message: "预览未落库；确认后请调用 update_article",
    }
}

export async function createArticleShareForAssistant(ctx: AssistantToolContext, raw: unknown) {
    const input = articleIdSchema.parse(raw)
    const article = await requireArticleOwner(ctx.userId, input.articleId)
    const db = getDb()
    const [existing] = await db
        .select()
        .from(knowledgeBaseArticleShares)
        .where(eq(knowledgeBaseArticleShares.articleId, article.id))
        .limit(1)

    const shareCode = existing && existing.enabled && existing.shareCode.trim()
        ? existing.shareCode
        : generateShareCode()
    const values = {
        userId: ctx.userId,
        articleId: article.id,
        shareCode,
        enabled: true,
        revokedAt: null,
        updatedAt: new Date(),
    }
    const [share] = existing
        ? await db.update(knowledgeBaseArticleShares).set(values).where(eq(knowledgeBaseArticleShares.id, existing.id)).returning()
        : await db.insert(knowledgeBaseArticleShares).values(values).returning()

    return {
        articleId: String(article.id),
        shareCode: share.shareCode,
        shareUrl: `/p/${share.shareCode}`,
        enabled: true,
    }
}

export async function deleteArticleForAssistant(ctx: AssistantToolContext, raw: unknown) {
    const input = articleIdSchema.parse(raw)
    const article = await requireArticleOwner(ctx.userId, input.articleId)
    const db = getDb()
    await db.transaction(async (tx) => {
        await deleteArticleWikiPages(tx, { userId: ctx.userId, articles: [article] })
        await tx.delete(knowledgeBaseArticleTags).where(eq(knowledgeBaseArticleTags.articleId, article.id))
        await tx.delete(knowledgeBaseArticleShares).where(eq(knowledgeBaseArticleShares.articleId, article.id))
        await tx.delete(knowledgeBaseArticles).where(and(
            eq(knowledgeBaseArticles.id, article.id),
            eq(knowledgeBaseArticles.userId, ctx.userId),
        ))
        await tx.delete(knowledgeBaseNodes).where(and(
            eq(knowledgeBaseNodes.id, article.nodeId),
            eq(knowledgeBaseNodes.userId, ctx.userId),
        ))
    })
    return { articleId: String(article.id), deleted: true }
}

export async function revokeArticleShareForAssistant(ctx: AssistantToolContext, raw: unknown) {
    const input = articleIdSchema.parse(raw)
    await requireArticleOwner(ctx.userId, input.articleId)
    const db = getDb()
    const [share] = await db
        .select()
        .from(knowledgeBaseArticleShares)
        .where(eq(knowledgeBaseArticleShares.articleId, input.articleId))
        .limit(1)
    if (!share || !share.enabled) {
        return { articleId: String(input.articleId), enabled: false, revoked: false }
    }
    const revokedAt = new Date()
    await db
        .update(knowledgeBaseArticleShares)
        .set({ enabled: false, revokedAt, updatedAt: revokedAt })
        .where(eq(knowledgeBaseArticleShares.id, share.id))
    return { articleId: String(input.articleId), enabled: false, revoked: true }
}

export async function deleteDocumentForAssistant(ctx: AssistantToolContext, raw: unknown) {
    const input = documentIdSchema.parse(raw)
    return await deleteDocument(ctx.userId, input.documentId)
}

export async function moveArticleForAssistant(ctx: AssistantToolContext, raw: unknown) {
    const input = moveArticleSchema.parse(raw)
    return await moveArticle({
        userId: ctx.userId,
        articleId: input.articleId,
        targetKnowledgeBaseId: input.targetKnowledgeBaseId,
        parentId: input.parentId,
        targetIndex: input.targetIndex,
    })
}

const directDangerousGuard = async () => {
    throw badRequest("危险操作必须先通过 request_user_confirmation，不能直接调用")
}

export const contentWriteAssistantTools: AssistantToolRegistration[] = [
    buildRequestUserConfirmationTool(),
    {
        name: "create_article",
        domain: "content_write",
        risk: "write",
        description: "在指定知识库创建一篇新文章。",
        inputSchema: createArticleSchema,
        execute: createArticleForAssistant,
    },
    {
        name: "update_article",
        domain: "content_write",
        risk: "write",
        description: "更新文章标题和/或 Markdown 正文（会落库）。大段改写前请先 preview_article_update。",
        inputSchema: updateArticleSchema,
        execute: updateArticleForAssistant,
    },
    {
        name: "preview_article_update",
        domain: "content_write",
        risk: "read",
        description: "预览 update_article 的标题变更与正文 unified diff，不落库。大段改写必须先调用本工具。",
        inputSchema: updateArticleSchema,
        execute: previewArticleUpdateForAssistant,
    },
    {
        name: "create_article_share",
        domain: "content_write",
        risk: "write",
        description: "开启文章公开分享链接。",
        inputSchema: articleIdSchema,
        execute: createArticleShareForAssistant,
    },
    {
        name: "move_article",
        domain: "content_write",
        risk: "write",
        description:
            "移动文章到目标知识库（可跨库）。targetKnowledgeBaseId 为目的库；parentId 不传则放到该库根目录；同库移动也可使用本工具。",
        inputSchema: moveArticleSchema,
        execute: moveArticleForAssistant,
    },
    {
        name: "delete_article",
        domain: "content_write",
        risk: "dangerous",
        description: "删除文章（危险：须经 request_user_confirmation）。",
        inputSchema: articleIdSchema,
        execute: async (ctx, input) => {
            // 注册表内可被 Runtime 确认后调用；模型侧不会装载本工具
            if ((ctx as AssistantToolContext & { __confirmExec?: boolean }).__confirmExec) {
                return await deleteArticleForAssistant(ctx, input)
            }
            return await directDangerousGuard()
        },
    },
    {
        name: "revoke_article_share",
        domain: "content_write",
        risk: "dangerous",
        description: "撤销文章公开分享（危险：须经确认）。",
        inputSchema: articleIdSchema,
        execute: async (ctx, input) => {
            if ((ctx as AssistantToolContext & { __confirmExec?: boolean }).__confirmExec) {
                return await revokeArticleShareForAssistant(ctx, input)
            }
            return await directDangerousGuard()
        },
    },
    {
        name: "delete_document",
        domain: "content_write",
        risk: "dangerous",
        description: "删除文档库文档（危险：须经确认）。",
        inputSchema: documentIdSchema,
        execute: async (ctx, input) => {
            if ((ctx as AssistantToolContext & { __confirmExec?: boolean }).__confirmExec) {
                return await deleteDocumentForAssistant(ctx, input)
            }
            return await directDangerousGuard()
        },
    },
]
