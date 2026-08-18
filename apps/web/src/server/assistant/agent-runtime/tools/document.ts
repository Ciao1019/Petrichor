import { z } from "zod"
import { knowledgeBaseArticlePath } from "@/lib/dashboard-routes"
import { listUserKnowledgeBases, readSourceArticleForAgent } from "@/server/kb/wiki-agent-logic"
import { loadDocumentTreeOutline } from "@/server/kb/wiki-tree"
import { badRequest } from "@/server/http/response"
import { defineTool } from "./adapter"
import type { AgentToolDefinition, ToolNormalizerResult } from "../types"

/**
 * 文档导出（§45）。
 *
 * 只读能力：把知识库文章按 Markdown 或提纲形式组装成可交付内容，
 * 不产生任何写副作用，因此不需要确认卡。
 */

const idSchema = z.union([z.string(), z.number()]).transform((value, ctx) => {
    const raw = String(value).trim()
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
        ctx.addIssue({ code: "custom", message: "ID 必须是正整数" })
        return z.NEVER
    }
    return Number(raw)
})

const exportSchema = z.object({
    knowledgeBaseId: idSchema.optional().nullable(),
    articleId: idSchema.describe("要导出的文章 ID"),
    format: z.enum(["markdown", "outline"]).optional().describe("markdown=完整正文；outline=仅章节提纲"),
    includeFrontMatter: z.boolean().optional().describe("是否在开头附标题与更新时间"),
})

function focusKnowledgeBaseId(focus: unknown): number | null {
    const raw = (focus as { knowledgeBaseId?: string | null } | null)?.knowledgeBaseId
    if (raw == null) return null
    const parsed = Number(String(raw).trim())
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export const documentExportTools: AgentToolDefinition[] = [
    defineTool({
        id: "document.export",
        name: "export_document",
        namespace: "document",
        riskLevel: "low",
        sideEffect: false,
        allowedInSubAgent: false,
        description:
            "把一篇知识库文章导出成可交付的 Markdown 或章节提纲。"
            + "何时用：用户要一份完整文稿、需要把已有文章整篇交出来时。"
            + "输入：articleId，可选 knowledgeBaseId/format/includeFrontMatter。"
            + "输出：组装好的 Markdown 文本与建议文件名。"
            + "何时不用：只需要查其中某段内容时用 read_knowledge_node，不要整篇导出。",
        inputSchema: exportSchema,
        execute: async (ctx, raw) => {
            const input = exportSchema.parse(raw)
            const knowledgeBaseId = input.knowledgeBaseId ?? focusKnowledgeBaseId(ctx.focus)
            if (knowledgeBaseId == null) {
                throw badRequest(
                    "缺少 knowledgeBaseId：当前对话没有默认知识库，请从检索结果里取出该文章所属的库 ID 一并传入。",
                )
            }

            const article = await readSourceArticleForAgent(ctx.userId, knowledgeBaseId, input.articleId)
            const format = input.format ?? "markdown"

            if (format === "outline") {
                const outline = await loadDocumentTreeOutline(ctx.userId, knowledgeBaseId, input.articleId)
                return {
                    format,
                    title: article.title,
                    articleId: article.articleId,
                    knowledgeBaseId: article.knowledgeBaseId,
                    href: knowledgeBaseArticlePath(article.knowledgeBaseId, article.articleId),
                    content: typeof outline === "string" ? outline : JSON.stringify(outline, null, 2),
                    fileName: `${sanitizeFileName(article.title)}-outline.md`,
                }
            }

            const owned = await listUserKnowledgeBases(ctx.userId)
            const kbName = owned.find((item) => item.id === String(knowledgeBaseId))?.name ?? null
            const frontMatter = input.includeFrontMatter === false
                ? ""
                : [
                    `# ${article.title}`,
                    kbName ? `> 知识库：${kbName}` : "",
                    article.updatedAt ? `> 更新时间：${article.updatedAt}` : "",
                    "",
                ].filter(Boolean).join("\n")

            return {
                format,
                title: article.title,
                articleId: article.articleId,
                knowledgeBaseId: article.knowledgeBaseId,
                href: article.href,
                content: `${frontMatter}${article.contentMd}`.trim(),
                mediaCount: Array.isArray(article.media) ? article.media.length : 0,
                fileName: `${sanitizeFileName(article.title)}.md`,
            }
        },
        normalize: (output): ToolNormalizerResult => {
            const record = output as {
                title?: string
                content?: string
                fileName?: string
                format?: string
                articleId?: string
                knowledgeBaseId?: string
                href?: string
            }
            const content = record.content ?? ""
            if (!content.trim()) {
                return { summary: "导出内容为空", suggestedActions: ["knowledge.read"] }
            }
            return {
                summary: `已导出「${record.title ?? "文档"}」（${record.format}，${content.length} 字）`,
                // 正文完整回传：调用方通常要把它直接交给用户
                data: { fileName: record.fileName, content },
                evidence: [{
                    source: "knowledge",
                    title: record.title ?? "导出文档",
                    content: content.slice(0, 4_000),
                    ...(record.articleId ? { sourceId: record.articleId } : {}),
                    relevance: 0.7,
                    confidence: 0.9,
                    metadata: {
                        ...(record.articleId ? { articleId: record.articleId } : {}),
                        ...(record.knowledgeBaseId ? { knowledgeBaseId: record.knowledgeBaseId } : {}),
                        exported: true,
                    },
                }],
            }
        },
    }),
]

function sanitizeFileName(value: string): string {
    return value.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document"
}
