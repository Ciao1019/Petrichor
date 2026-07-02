// Agent 长期记忆的纯逻辑：蒸馏限频判断、prompt 构建、模型输出解析、prompt 注入段落
import { z } from "zod"

export const AGENT_MEMORY_KINDS = ["PREFERENCE", "TOPIC", "FACT"] as const
export type AgentMemoryKind = typeof AGENT_MEMORY_KINDS[number]

export const MAX_ACTIVE_MEMORIES = 30
export const MAX_PROMPT_MEMORIES = 10
export const MAX_DISTILLED_PER_RUN = 8
export const DISTILL_MIN_NEW_MESSAGES = 5
export const DISTILL_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000
export const DISTILL_MESSAGE_SAMPLE_LIMIT = 40
// 语义去重：cosine 距离低于该阈值的新旧记忆视为同一条
export const MEMORY_MERGE_MAX_DISTANCE = 0.2
const MEMORY_CONTENT_MAX_CHARS = 120
const MESSAGE_SAMPLE_MAX_CHARS = 200

const KIND_LABELS: Record<AgentMemoryKind, string> = {
    PREFERENCE: "偏好",
    TOPIC: "常关注",
    FACT: "背景",
}

export const agentMemoryDeleteInputSchema = z.object({
    memoryId: z.union([z.string(), z.number()]).transform((value, ctx) => {
        const raw = String(value).trim()
        if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
            ctx.addIssue({ code: "custom", message: "ID 必须是正整数" })
            return z.NEVER
        }
        return Number(raw)
    }),
})

export function isAgentMemoryKind(value: unknown): value is AgentMemoryKind {
    return typeof value === "string" && (AGENT_MEMORY_KINDS as readonly string[]).includes(value)
}

// 蒸馏限频：距上次蒸馏满 12 小时且累计了足够多的新用户消息才触发
export function shouldDistillAgentMemory(input: {
    lastDistilledAt: Date | null
    newUserMessageCount: number
    now: Date
}): boolean {
    if (input.newUserMessageCount < DISTILL_MIN_NEW_MESSAGES) {
        return false
    }
    if (input.lastDistilledAt == null) {
        return true
    }
    return input.now.getTime() - input.lastDistilledAt.getTime() >= DISTILL_MIN_INTERVAL_MS
}

export function buildMemoryDistillSystemPrompt() {
    return [
        "你是知识库问答 Agent 的记忆蒸馏器。输入是用户最近在问答对话中提出的问题清单，你要从中提炼对后续回答长期有用的记忆条目。",
        "硬性规则：",
        "- 只输出一个 JSON 数组，不要输出任何其他文字或代码块标记。",
        '- 数组元素格式：{"kind":"PREFERENCE|TOPIC|FACT","content":"..."}。',
        "- PREFERENCE：用户明确表达的回答偏好（语言、详略、格式、是否要引用等）。",
        "- TOPIC：用户反复关注的主题或领域，仅当在清单中出现两次以上才提炼。",
        "- FACT：用户透露的关于自己的稳定背景事实（职业、在做的项目、技术栈等）。",
        `- 每条 content 不超过 50 字，用中文、以「用户」开头、自包含（不依赖上下文即可理解）。`,
        "- 只提炼有跨对话复用价值的信息；一次性的具体问题不要提炼成记忆。",
        `- 最多输出 ${MAX_DISTILLED_PER_RUN} 条；没有值得记的就输出 []。`,
        "- 不要虚构清单中没有依据的内容。",
    ].join("\n")
}

export function buildMemoryDistillUserMessage(questions: string[]) {
    const lines: string[] = []
    lines.push(`以下是用户最近的 ${questions.length} 条提问（按时间升序）：`)
    lines.push("")
    questions.forEach((question, index) => {
        lines.push(`${index + 1}. ${truncate(question, MESSAGE_SAMPLE_MAX_CHARS)}`)
    })
    lines.push("")
    lines.push("请蒸馏长期记忆条目。")
    return lines.join("\n")
}

export interface DistilledMemory {
    kind: AgentMemoryKind
    content: string
}

export function parseDistilledMemories(raw: string): DistilledMemory[] {
    const jsonText = extractJsonArrayText(raw)
    let parsed: unknown
    try {
        parsed = JSON.parse(jsonText)
    } catch {
        return []
    }
    if (!Array.isArray(parsed)) {
        return []
    }

    const items: DistilledMemory[] = []
    const seen = new Set<string>()
    for (const entry of parsed) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
        const record = entry as Record<string, unknown>
        const kindRaw = typeof record.kind === "string" ? record.kind.trim().toUpperCase() : ""
        const content = typeof record.content === "string" ? record.content.trim() : ""
        if (!isAgentMemoryKind(kindRaw) || !content) continue
        const key = normalizeMemoryContent(content)
        if (!key || seen.has(key)) continue
        seen.add(key)
        items.push({ kind: kindRaw, content: truncate(content, MEMORY_CONTENT_MAX_CHARS) })
        if (items.length >= MAX_DISTILLED_PER_RUN) break
    }
    return items
}

// 精确去重用的归一化 key：忽略空白、标点差异
export function normalizeMemoryContent(content: string) {
    return content
        .toLowerCase()
        .replace(/[\s，。、；;,.！!？?：:'"「」『』()（）]/g, "")
}

// 注入 system prompt 的记忆段落；无记忆时返回 null
export function buildMemoryPromptSection(memories: Array<{ kind: string; content: string }>): string | null {
    const usable = memories
        .filter((memory) => isAgentMemoryKind(memory.kind) && memory.content.trim())
        .slice(0, MAX_PROMPT_MEMORIES)
    if (usable.length === 0) {
        return null
    }
    const lines = [
        "用户长期记忆（从该用户的历史对话中自动蒸馏，仅作背景参考）：",
        ...usable.map((memory) => `- [${KIND_LABELS[memory.kind as AgentMemoryKind]}] ${memory.content.trim()}`),
        "使用规则：回答仍以本次问题与检索到的文档为准；记忆只用于调整表达方式与补充默认语境，与本次问题冲突时忽略记忆，也不要主动向用户复述这些记忆。",
    ]
    return lines.join("\n")
}

function extractJsonArrayText(raw: string) {
    const stripped = raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim()
    const start = stripped.indexOf("[")
    const end = stripped.lastIndexOf("]")
    if (start >= 0 && end > start) {
        return stripped.slice(start, end + 1)
    }
    return stripped
}

function truncate(value: string, max: number) {
    const normalized = value.replace(/\s+/g, " ").trim()
    return normalized.length > max ? `${normalized.slice(0, max - 1).trimEnd()}…` : normalized
}
