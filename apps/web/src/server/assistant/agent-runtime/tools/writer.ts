import { z } from "zod"
import { callChatCompletion } from "@/server/ai/generation"
import { defineTool } from "./adapter"
import type { AgentEvidence, AgentToolDefinition, ToolExecutionContext, ToolNormalizerResult } from "../types"

/**
 * 写作能力（§44）。
 *
 * 这些工具不是「把模型的话再说一遍」：它们把本轮已收集的 Evidence 作为事实基座，
 * 用独立的写作提示词生成产物，从而让长文写作不占用主循环上下文，
 * 也保证正文事实来自证据而不是主循环里的自由发挥。
 */

const composeSchema = z.object({
    topic: z.string().trim().min(1).max(300).describe("要写的主题"),
    outline: z.array(z.string().trim().min(1).max(200)).max(20).optional().describe("章节提纲，可留空让工具自行组织"),
    audience: z.string().trim().max(120).optional().describe("读者对象，例如「后端工程师」"),
    style: z.string().trim().max(120).optional().describe("风格要求，例如「技术方案，克制」"),
    lengthHint: z.enum(["short", "medium", "long"]).optional(),
})

const rewriteSchema = z.object({
    text: z.string().trim().min(1).max(20_000).describe("要改写的原文"),
    instruction: z.string().trim().min(1).max(500).describe("改写要求"),
})

const summarizeSchema = z.object({
    text: z.string().trim().max(30_000).optional().describe("要归纳的文本；留空则归纳本轮已获取的证据"),
    focus: z.string().trim().max(200).optional().describe("归纳的侧重点"),
    maxPoints: z.number().int().min(1).max(15).optional(),
})

const structureSchema = z.object({
    topic: z.string().trim().min(1).max(300),
    depth: z.number().int().min(1).max(3).optional().describe("提纲层级，默认 2"),
})

const LENGTH_HINT: Record<string, string> = {
    short: "控制在 400 字以内",
    medium: "控制在 800~1500 字",
    long: "可以写到 2000 字以上，但不要注水",
}

/** 把本轮证据渲染成写作用的事实基座，并带上引用编号 */
function renderEvidenceBase(evidence: AgentEvidence[], limit = 12): string {
    if (evidence.length === 0) return "（本轮没有收集到证据，只能写通用内容，必须显式说明缺少依据。）"
    return evidence
        .slice(0, limit)
        .map((item, index) => {
            const source = item.url ?? (item.metadata?.path as string[] | undefined)?.join(" / ") ?? item.source
            return `[${index + 1}] ${item.title ?? "未命名"}（${source}）\n${item.content.slice(0, 1_200)}`
        })
        .join("\n\n")
}

async function generate(
    ctx: ToolExecutionContext,
    systemPrompt: string,
    message: string,
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }> {
    const result = await callChatCompletion({
        userId: ctx.userId,
        systemPrompt,
        message,
        ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
    })
    return { text: result.answer, usage: result.usage }
}

const WRITER_SYSTEM = `
你是写作助手，只负责生成正文，不做检索、不调用工具、不解释你的过程。

硬性要求：
- 正文中的事实必须来自给定证据；引用某条证据时在句末标注 [n]。
- 证据没覆盖的内容不要编造，需要时直接写明「资料未覆盖」。
- 直接输出成品正文，不要写"好的""以下是"这类开场白。
- 使用 Markdown，标题层级从 ## 开始。
`.trim()

function writingNormalizer(kind: string) {
    return (output: unknown): ToolNormalizerResult => {
        const record = output as { text?: string; chars?: number }
        const text = record?.text ?? ""
        if (!text.trim()) {
            return { summary: `${kind}未产出内容`, suggestedActions: ["retry", "reduce_scope"] }
        }
        return {
            summary: `${kind}完成（${text.length} 字）`,
            // 正文完整回传给模型，它需要据此决定是否直接作为答案
            data: { text },
        }
    }
}

export const writerTools: AgentToolDefinition[] = [
    defineTool({
        id: "writer.compose",
        name: "writer_compose",
        namespace: "writer",
        riskLevel: "low",
        sideEffect: false,
        allowedInSubAgent: true,
        timeoutMs: 90_000,
        description:
            "基于本轮已收集的证据撰写长文（技术方案、调研报告、说明文档）。"
            + "何时用：资料已经查够、需要产出成篇内容时。"
            + "输入：topic，可选 outline/audience/style/lengthHint。"
            + "输出：Markdown 正文，事实带 [n] 引用。"
            + "何时不用：资料还没查够时先去检索；简短回答直接自己写，不要调用本工具。",
        inputSchema: composeSchema,
        execute: async (ctx, raw) => {
            const input = composeSchema.parse(raw)
            const evidence = ctx.state.evidence
            const constraints = [
                input.audience ? `读者：${input.audience}` : "",
                input.style ? `风格：${input.style}` : "",
                LENGTH_HINT[input.lengthHint ?? "medium"],
                input.outline?.length ? `按以下提纲组织：\n${input.outline.map((item, i) => `${i + 1}. ${item}`).join("\n")}` : "",
            ].filter(Boolean).join("\n")

            const { text } = await generate(
                ctx,
                WRITER_SYSTEM,
                `主题：${input.topic}\n\n${constraints}\n\n可用证据：\n${renderEvidenceBase(evidence)}`,
            )
            return { text, chars: text.length, evidenceUsed: Math.min(evidence.length, 12) }
        },
        normalize: writingNormalizer("撰写"),
    }),

    defineTool({
        id: "writer.rewrite",
        name: "writer_rewrite",
        namespace: "writer",
        riskLevel: "low",
        sideEffect: false,
        allowedInSubAgent: true,
        timeoutMs: 60_000,
        description:
            "按指定要求改写一段文本（换风格、压缩、扩写、调整结构）。"
            + "何时用：已有正文需要按明确要求调整时。"
            + "输入：text + instruction。输出：改写后的正文。"
            + "何时不用：需要新增事实时先检索；只是措辞微调不必调用本工具。",
        inputSchema: rewriteSchema,
        execute: async (ctx, raw) => {
            const input = rewriteSchema.parse(raw)
            const { text } = await generate(
                ctx,
                `${WRITER_SYSTEM}\n\n本次任务是改写：保留原文事实与既有 [n] 引用，只按要求调整表达与结构。`,
                `改写要求：${input.instruction}\n\n原文：\n${input.text}`,
            )
            return { text, chars: text.length }
        },
        normalize: writingNormalizer("改写"),
    }),

    defineTool({
        id: "writer.summarize",
        name: "writer_summarize",
        namespace: "writer",
        riskLevel: "low",
        sideEffect: false,
        allowedInSubAgent: true,
        timeoutMs: 60_000,
        description:
            "归纳要点。传 text 则归纳该文本，不传则归纳本轮已收集的全部证据。"
            + "何时用：材料多、需要先收敛成要点再往下推进时。"
            + "输入：可选 text/focus/maxPoints。输出：要点列表。"
            + "何时不用：材料很少时直接自己总结即可。",
        inputSchema: summarizeSchema,
        execute: async (ctx, raw) => {
            const input = summarizeSchema.parse(raw)
            const source = input.text?.trim()
                ? input.text
                : renderEvidenceBase(ctx.state.evidence, 20)
            const { text } = await generate(
                ctx,
                `${WRITER_SYSTEM}\n\n本次任务是归纳：输出 Markdown 无序列表，每条一个要点，最多 ${input.maxPoints ?? 8} 条。`,
                `${input.focus ? `侧重：${input.focus}\n\n` : ""}材料：\n${source}`,
            )
            return { text, chars: text.length, fromEvidence: !input.text?.trim() }
        },
        normalize: writingNormalizer("归纳"),
    }),

    defineTool({
        id: "writer.structure",
        name: "writer_structure",
        namespace: "writer",
        riskLevel: "low",
        sideEffect: false,
        allowedInSubAgent: true,
        timeoutMs: 45_000,
        description:
            "为一个主题梳理写作提纲。"
            + "何时用：长文动笔前先定结构，或需要和用户确认结构时。"
            + "输入：topic，可选 depth。输出：分层提纲。"
            + "何时不用：短文不需要提纲；已有提纲直接传给 writer_compose。",
        inputSchema: structureSchema,
        execute: async (ctx, raw) => {
            const input = structureSchema.parse(raw)
            const { text } = await generate(
                ctx,
                `${WRITER_SYSTEM}\n\n本次任务只输出提纲：${input.depth ?? 2} 级 Markdown 列表，不要写正文。`,
                `主题：${input.topic}\n\n已有证据（提纲要能被这些证据支撑）：\n${renderEvidenceBase(ctx.state.evidence, 10)}`,
            )
            return { text, chars: text.length }
        },
        normalize: (output): ToolNormalizerResult => {
            const text = (output as { text?: string })?.text ?? ""
            const items = text.split("\n").filter((line) => /^\s*[-*\d]/.test(line)).length
            return {
                summary: items > 0 ? `提纲已生成（${items} 个条目）` : "提纲未产出内容",
                data: { outline: text },
                ...(items > 0 ? { suggestedActions: ["writer.compose"] } : {}),
            }
        },
    }),
]
