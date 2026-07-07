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
// 反思器（Reflector，OM 设计的第二个后台环节）：当活跃观察数超过该阈值时，
// 触发一次全量「重构 + 压缩」——合并重叠、删除过时、抽象共性，让记忆更稠密。
export const REFLECT_TRIGGER_ACTIVE_COUNT = 24
export const MAX_REFLECTED = MAX_ACTIVE_MEMORIES
const MEMORY_CONTENT_MAX_CHARS = 140
const MESSAGE_SAMPLE_MAX_CHARS = 240

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

// ===== Observer：观察最近对话，产出稠密、时间感知的长期观察 =====
// 对标 Mastra Observational Memory 的 Observer。区别于旧「蒸馏器」：观察对象是完整对话
// （提问 + 回答），产出的是稠密自包含、带相对时间语境的观察，而非三桶式偏好提炼。
export function buildObserverSystemPrompt() {
    return [
        "你是知识库问答 Agent 的观察器（Observer）。输入是该用户与 Agent 最近的一段对话（含用户提问与 Agent 回答）。请像人一样从中提炼对后续对话长期有用的观察，形成稠密、自包含、可跨对话复用的记忆条目。",
        "硬性规则：",
        "- 只输出一个 JSON 数组，不要输出任何其他文字或代码块标记。",
        '- 数组元素格式：{"kind":"PREFERENCE|TOPIC|FACT","content":"..."}。',
        "- PREFERENCE：用户明确表达的回答偏好（语言、详略、格式、是否要引用、示例风格等）。",
        "- TOPIC：用户反复关注或正在深入的主题、领域、项目。",
        "- FACT：关于用户的稳定事实，或用户正在推进的目标 / 已做出的决定 / 采用的技术栈。",
        "- 每条 content 用中文、以「用户」开头、不超过 60 字、自包含（脱离上下文也能读懂）。",
        "- 观察要稠密具体：写清「是什么 / 为何长期有用」；需要时用相对时间语境（如「最近」「一直」），但不要编造具体日期。",
        "- 只保留有长期、跨对话复用价值的信息；一次性的具体问题、临时事实不要记。",
        `- 最多输出 ${MAX_DISTILLED_PER_RUN} 条；没有值得记的就输出 []。`,
        "- 不要虚构对话中没有依据的内容。",
    ].join("\n")
}

export function buildObserverUserMessage(turns: ConversationTurn[]) {
    const lines: string[] = []
    lines.push(`以下是该用户与 Agent 最近的 ${turns.length} 条对话消息（按时间升序，User=用户，Agent=助手）：`)
    lines.push("")
    turns.forEach((turn) => {
        const speaker = turn.role === "assistant" ? "Agent" : "User"
        lines.push(`${speaker}: ${truncate(turn.text, MESSAGE_SAMPLE_MAX_CHARS)}`)
    })
    lines.push("")
    lines.push("请输出长期观察条目（JSON 数组）。")
    return lines.join("\n")
}

// ===== Reflector：对全量观察日志做重构 + 压缩 =====
// 对标 Mastra Observational Memory 的 Reflector：合并相关项、删除过时项、抽象共性、整体压缩。
export function buildReflectorSystemPrompt() {
    return [
        "你是知识库问答 Agent 的反思器（Reflector）。输入是该用户当前的全部长期观察条目。请像人整理笔记一样重构它们：合并语义重复或高度相关的条目、删除已过时或被更具体条目取代的内容、在有共性时抽象出更概括的观察，让整体更稠密、更少冗余。",
        "硬性规则：",
        "- 只输出一个 JSON 数组，格式与输入相同：{\"kind\":\"PREFERENCE|TOPIC|FACT\",\"content\":\"...\"}。",
        "- 保留所有仍然有效的独立信息，不要丢失任何不重叠的事实 / 偏好；只在确有重叠时才合并。",
        "- 每条 content 用中文、以「用户」开头、不超过 60 字、自包含。",
        `- 输出条目数应少于输入（确实完成了压缩），且不超过 ${MAX_REFLECTED} 条。`,
        "- 不要虚构输入中没有依据的内容。",
    ].join("\n")
}

export function buildReflectorUserMessage(existing: Array<{ kind: string; content: string }>) {
    const lines: string[] = []
    lines.push(`以下是该用户当前的 ${existing.length} 条长期观察（可能存在重复、重叠或过时）：`)
    lines.push("")
    existing.forEach((item, index) => {
        const label = isAgentMemoryKind(item.kind) ? KIND_LABELS[item.kind] : item.kind
        lines.push(`${index + 1}. [${label}] ${truncate(item.content, MEMORY_CONTENT_MAX_CHARS)}`)
    })
    lines.push("")
    lines.push("请输出重构 / 压缩后的观察条目（JSON 数组）。")
    return lines.join("\n")
}

export interface ConversationTurn {
    role: "user" | "assistant"
    text: string
}

export interface DistilledMemory {
    kind: AgentMemoryKind
    content: string
}

// Observer 与 Reflector 输出的是同一种 {kind, content} 形状，共用此解析器。
// max 默认按单轮观察上限；Reflector 传 MAX_REFLECTED 允许输出更多条。
export function parseDistilledMemories(raw: string, max: number = MAX_DISTILLED_PER_RUN): DistilledMemory[] {
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
        if (items.length >= max) break
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
        "用户长期观察记忆（由观察器 Observer 从该用户历史对话中自动维护、经反思器 Reflector 定期压缩，仅作背景参考）：",
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
