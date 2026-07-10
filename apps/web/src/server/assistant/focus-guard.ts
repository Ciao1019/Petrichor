import { and, eq } from "drizzle-orm"
import { getDb } from "@/server/db/client"
import { docDocuments, docLibraries, knowledgeBaseArticles, knowledgeBases } from "@/server/db/schema"
import { badRequest, forbidden } from "@/server/http/response"
import type { AssistantFocus } from "./domain-types"

// 契约 4.1：focus 实体非当前用户所有 → 403。focus 只约束默认上下文，这里只做归属校验。

export async function assertAssistantFocusOwnership(userId: number, focus: AssistantFocus | null): Promise<void> {
    if (!focus) return
    const db = getDb()
    const checks: Array<{ label: string; value: string | null | undefined; verify: (id: number) => Promise<boolean> }> = [
        {
            label: "knowledgeBaseId",
            value: focus.knowledgeBaseId,
            verify: async (id) => {
                const [row] = await db.select({ id: knowledgeBases.id }).from(knowledgeBases)
                    .where(and(eq(knowledgeBases.id, id), eq(knowledgeBases.userId, userId))).limit(1)
                return Boolean(row)
            },
        },
        {
            label: "libraryId",
            value: focus.libraryId,
            verify: async (id) => {
                const [row] = await db.select({ id: docLibraries.id }).from(docLibraries)
                    .where(and(eq(docLibraries.id, id), eq(docLibraries.userId, userId))).limit(1)
                return Boolean(row)
            },
        },
        {
            label: "articleId",
            value: focus.articleId,
            verify: async (id) => {
                const [row] = await db.select({ id: knowledgeBaseArticles.id }).from(knowledgeBaseArticles)
                    .where(and(eq(knowledgeBaseArticles.id, id), eq(knowledgeBaseArticles.userId, userId))).limit(1)
                return Boolean(row)
            },
        },
        {
            label: "documentId",
            value: focus.documentId,
            verify: async (id) => {
                const [row] = await db.select({ id: docDocuments.id }).from(docDocuments)
                    .where(and(eq(docDocuments.id, id), eq(docDocuments.userId, userId))).limit(1)
                return Boolean(row)
            },
        },
    ]
    for (const check of checks) {
        if (check.value == null) continue
        const id = Number.parseInt(check.value, 10)
        if (!Number.isFinite(id) || id <= 0) {
            throw badRequest(`focus.${check.label} 不合法`)
        }
        if (!(await check.verify(id))) {
            throw forbidden(`无权访问 focus.${check.label} 指向的实体`)
        }
    }
}
