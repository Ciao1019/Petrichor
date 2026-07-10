import { z } from "zod"
import {
    idSchema,
    listLibraries,
    readDocumentChunks,
    searchChunks,
} from "@/server/doc-library/library-logic"
import { badRequest } from "@/server/http/response"
import type { AssistantToolContext, AssistantToolRegistration } from "../domain-types"

const searchDocumentsSchema = z.object({
    query: z.string().trim().min(1),
    libraryId: idSchema.optional().nullable(),
    documentId: idSchema.optional().nullable(),
    limit: z.number().int().min(1).max(20).optional(),
})

const readDocumentSchema = z.object({
    documentId: idSchema.optional().nullable(),
    fromIndex: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(40).optional(),
})

function focusId(value: string | null | undefined): number | null {
    return value == null ? null : idSchema.parse(value)
}

export async function searchDocuments(
    ctx: AssistantToolContext,
    input: z.infer<typeof searchDocumentsSchema>,
) {
    const hasExplicitScope = input.libraryId != null || input.documentId != null
    const libraryId = input.libraryId
        ?? (hasExplicitScope ? null : focusId(ctx.focus?.libraryId))
    const documentId = input.documentId
        ?? (hasExplicitScope ? null : focusId(ctx.focus?.documentId))

    return await searchChunks({
        userId: ctx.userId,
        libraryId,
        documentId,
        query: input.query,
        limit: input.limit,
    })
}

export async function readDocument(
    ctx: AssistantToolContext,
    input: z.infer<typeof readDocumentSchema>,
) {
    const documentId = input.documentId ?? focusId(ctx.focus?.documentId)
    if (documentId == null) {
        throw badRequest("缺少 documentId，且当前对话未提供 focus.documentId")
    }
    return await readDocumentChunks({
        userId: ctx.userId,
        documentId,
        fromIndex: input.fromIndex,
        limit: input.limit,
    })
}

export const docLibraryAssistantTools: AssistantToolRegistration[] = [
    {
        name: "list_doc_libraries",
        domain: "doc_library",
        risk: "read",
        description: "列出当前登录用户拥有的文档库，用于选择原始文件检索范围。",
        inputSchema: z.object({}),
        execute: async (ctx, input) => {
            z.object({}).parse(input)
            return await listLibraries(ctx.userId)
        },
    },
    {
        name: "search_documents",
        domain: "doc_library",
        risk: "read",
        description: "按关键词检索文档文本片段；可用 libraryId/documentId 显式限定，未指定时使用 focus 默认范围。",
        inputSchema: searchDocumentsSchema,
        execute: async (ctx, input) => await searchDocuments(ctx, searchDocumentsSchema.parse(input)),
    },
    {
        name: "read_document",
        domain: "doc_library",
        risk: "read",
        description: "顺序读取文档文本片段；可用 fromIndex 和 limit 翻页，documentId 可省略并使用 focus 默认文档。",
        inputSchema: readDocumentSchema,
        execute: async (ctx, input) => await readDocument(ctx, readDocumentSchema.parse(input)),
    },
]
