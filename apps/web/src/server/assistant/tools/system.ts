import { and, count, eq, isNull } from "drizzle-orm"
import { z } from "zod"
import { SerializableCitationSchema } from "@/components/tool-ui/citation/schema"
import { SerializableDataTableSchema } from "@/components/tool-ui/data-table/schema"
import { SerializablePlanSchema } from "@/components/tool-ui/plan/schema"
import { SerializableProgressTrackerSchema } from "@/components/tool-ui/progress-tracker/schema"
import { getDb } from "@/server/db/client"
import {
    assistantArtifacts,
    assistantThreads,
    docDocuments,
    docLibraries,
    knowledgeBaseArticles,
    knowledgeBases,
} from "@/server/db/schema"
import { hasUsableBinding } from "@/server/ai/resolution"
import type { AssistantToolContext, AssistantToolRegistration } from "../domain-types"
import { upsertAssistantPlan } from "../plan-store"

const citationListSchema = z.object({
    id: z.string().min(1),
    citations: z.array(SerializableCitationSchema).min(1),
    variant: z.enum(["default", "inline", "stacked"]).optional(),
})

const dataTableSchema = SerializableDataTableSchema.extend({
    title: z.string().optional(),
})

const artifactSchema = z.object({
    artifactType: z.enum(["answer", "table", "timeline", "report", "notes"]).default("answer"),
    title: z.string().min(1).max(200),
    contentMd: z.string().optional(),
    payload: z.unknown().optional(),
})

export async function listSystemOverview(userId: number) {
    const db = getDb()
    const [knowledgeBaseRow] = await db
        .select({ total: count() })
        .from(knowledgeBases)
        .where(eq(knowledgeBases.userId, userId))
    const [articleRow] = await db
        .select({ total: count() })
        .from(knowledgeBaseArticles)
        .where(eq(knowledgeBaseArticles.userId, userId))
    const [docLibraryRow] = await db
        .select({ total: count() })
        .from(docLibraries)
        .where(eq(docLibraries.userId, userId))
    const [documentRow] = await db
        .select({ total: count() })
        .from(docDocuments)
        .where(eq(docDocuments.userId, userId))
    const [assistantThreadRow] = await db
        .select({ total: count() })
        .from(assistantThreads)
        .where(and(eq(assistantThreads.userId, userId), isNull(assistantThreads.deletedAt)))
    // 用途绑定 + 模型/供应商都启用才算就绪
    const [chatModelReady, embeddingModelReady] = await Promise.all([
        hasUsableBinding(userId, "CHAT"),
        hasUsableBinding(userId, "EMBEDDING"),
    ])

    return {
        knowledgeBases: Number(knowledgeBaseRow?.total ?? 0),
        articles: Number(articleRow?.total ?? 0),
        docLibraries: Number(docLibraryRow?.total ?? 0),
        documents: Number(documentRow?.total ?? 0),
        assistantThreads: Number(assistantThreadRow?.total ?? 0),
        chatModelReady,
        embeddingModelReady,
    }
}

export async function saveAnswerArtifact(
    ctx: AssistantToolContext,
    input: z.infer<typeof artifactSchema>,
) {
    const [created] = await getDb()
        .insert(assistantArtifacts)
        .values({
            threadId: ctx.threadId,
            runId: ctx.runId,
            kind: input.artifactType,
            title: input.title,
            contentJson: JSON.stringify({
                contentMd: input.contentMd ?? null,
                payload: input.payload ?? null,
            }),
        })
        .returning({ id: assistantArtifacts.id })

    return {
        id: String(created!.id),
        artifactType: input.artifactType,
        title: input.title,
    }
}

export const systemAssistantTools: AssistantToolRegistration[] = [
    {
        name: "list_system_overview",
        domain: "system",
        risk: "read",
        description: "读取当前用户的知识库、文章、文档库、文档、Assistant 对话计数，以及默认对话/向量模型是否就绪。",
        inputSchema: z.object({}),
        execute: async (ctx, input) => {
            z.object({}).parse(input)
            return await listSystemOverview(ctx.userId)
        },
    },
    {
        name: "show_progress",
        domain: "system",
        risk: "read",
        description: "按 ProgressTracker 形状回显多步任务的真实执行进度，不产生业务副作用。",
        inputSchema: SerializableProgressTrackerSchema,
        execute: async (_ctx, input) => SerializableProgressTrackerSchema.parse(input),
    },
    {
        name: "show_citations",
        domain: "system",
        risk: "read",
        description: "回显最终答案实际使用的引用；href 必须来自检索/读取工具结果，禁止编造链接或原文片段。",
        inputSchema: citationListSchema,
        execute: async (_ctx, input) => citationListSchema.parse(input),
    },
    {
        name: "show_data_table",
        domain: "system",
        risk: "read",
        description: "按 DataTable 形状回显结构化对比、清单或矩阵，不产生业务副作用。",
        inputSchema: dataTableSchema,
        execute: async (_ctx, input) => dataTableSchema.parse(input),
    },
    {
        name: "save_answer_artifact",
        domain: "system",
        risk: "write",
        description: "把本轮可复用的回答、表格、时间线、报告或笔记保存为 Assistant 产物。",
        inputSchema: artifactSchema,
        execute: async (ctx, input) => await saveAnswerArtifact(ctx, artifactSchema.parse(input)),
    },
    {
        name: "upsert_plan",
        domain: "system",
        risk: "read",
        description: "按 Plan 形状回显并持久化当前任务计划；重复使用同一 id 表示更新，侧栏可跨轮回放。",
        inputSchema: SerializablePlanSchema,
        execute: async (ctx, input) => {
            const plan = SerializablePlanSchema.parse(input)
            try {
                await upsertAssistantPlan({
                    userId: ctx.userId,
                    threadId: ctx.threadId,
                    plan,
                })
            } catch (error) {
                console.error("[assistant] upsert_plan 落库失败（fail-open）", error)
            }
            return plan
        },
    },
]
