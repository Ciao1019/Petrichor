import type { ToolCallMessagePartStatus } from "@assistant-ui/react"
import type { ThreadTokenUsage, UseChatRuntimeOptions } from "@assistant-ui/react-ai-sdk"
import type { AssistantFocus, AssistantThreadSummary } from "@/lib/api"

export type AssistantUIMessage = NonNullable<UseChatRuntimeOptions["messages"]>[number]

export type AssistantFocusSelection =
  | { kind: "none" }
  | { kind: "knowledge"; knowledgeBaseId: string }

export function focusToRequestBody(focus: AssistantFocusSelection): AssistantFocus | null {
  if (focus.kind === "knowledge") return { knowledgeBaseId: focus.knowledgeBaseId }
  return null
}

export function focusFromThread(focus: AssistantFocus | null): AssistantFocusSelection {
  if (focus?.knowledgeBaseId) return { kind: "knowledge", knowledgeBaseId: String(focus.knowledgeBaseId) }
  return { kind: "none" }
}

export function threadRecencyKey(thread: AssistantThreadSummary) {
  return thread.updatedAt || thread.createdAt
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function isPresent<T>(value: T | null | undefined): value is T {
  return value != null
}

export function asRows(value: unknown, nestedKey?: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(asRecord).filter(isPresent)
  if (nestedKey) {
    const nested = asRecord(value)?.[nestedKey]
    if (Array.isArray(nested)) return nested.map(asRecord).filter(isPresent)
  }
  return []
}

export function toInternalAppPath(href: string) {
  if (!href) return false
  if (href.startsWith("/") && !href.startsWith("//")) return href
  if (typeof window === "undefined") return false
  try {
    const url = new URL(href, window.location.origin)
    return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : false
  } catch {
    return false
  }
}

export function parseLegacyDocumentHref(href: string) {
  if (!href) return null
  try {
    const url = new URL(href, typeof window === "undefined" ? "http://localhost" : window.location.origin)
    const match = url.pathname.match(/^\/document\/(\d+)$/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

export function formatRelativeTime(value: string | null | undefined) {
  if (!value) return ""
  const target = new Date(value)
  if (Number.isNaN(target.getTime())) return ""
  const diff = Date.now() - target.getTime()
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return "刚刚"
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  return target.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })
}

export function toolStatusLabel(status?: ToolCallMessagePartStatus) {
  if (status?.type === "running") return "运行中"
  if (status?.type === "incomplete") return "未完成"
  if (status?.type === "requires-action") return "待操作"
  return "完成"
}

export function resolveApiErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error && "response" in error) {
    const response = (error as { response?: { data?: { msg?: unknown } } }).response
    const apiMsg = response?.data?.msg
    if (typeof apiMsg === "string" && apiMsg) {
      return apiMsg
    }
  }
  if (error instanceof Error && error.message) return error.message
  return fallback
}

export function groupThreadsByRecency(threads: AssistantThreadSummary[]) {
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const buckets: Array<{ key: string; label: string; threads: AssistantThreadSummary[] }> = [
    { key: "today", label: "今天", threads: [] },
    { key: "yesterday", label: "昨天", threads: [] },
    { key: "week", label: "7 天内", threads: [] },
    { key: "month", label: "30 天内", threads: [] },
    { key: "older", label: "更早", threads: [] },
  ]

  for (const thread of threads) {
    const reference = thread.updatedAt
    const ts = reference ? new Date(reference).getTime() : 0
    if (!ts || Number.isNaN(ts)) {
      buckets[4].threads.push(thread)
      continue
    }
    const diff = now - ts
    if (diff < day && isSameLocalDay(ts, now)) buckets[0].threads.push(thread)
    else if (diff < 2 * day && isSameLocalDay(ts, now - day)) buckets[1].threads.push(thread)
    else if (diff < 7 * day) buckets[2].threads.push(thread)
    else if (diff < 30 * day) buckets[3].threads.push(thread)
    else buckets[4].threads.push(thread)
  }

  const groups = buckets.filter((bucket) => bucket.threads.length > 0)
  const totalShown = groups.reduce((sum, group) => sum + group.threads.length, 0)
  return { groups, totalShown }
}

export function isSameLocalDay(aMs: number, bMs: number) {
  const a = new Date(aMs)
  const b = new Date(bMs)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export function toInitialMessages(messages: Array<{ id: string; role: string; content?: unknown }>): AssistantUIMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      const content = normalizeAssistantPersistedContent(message.content)
      const metadata = extractPersistedMessageMetadata(content)
      const savedParts = extractPersistedParts(content)
      const parts = savedParts ?? [{ type: "text", text: extractTextFromContent(content) }]
      return {
        id: `persisted-${message.id}`,
        role: message.role,
        parts,
        ...(metadata ? { metadata } : {}),
      }
    }) as AssistantUIMessage[]
}

export function normalizeAssistantPersistedContent(content: unknown) {
  // user 消息可能整条 UIMessage；assistant 多为 { parts }
  const record = asRecord(content)
  if (!record) return content
  if (Array.isArray(record.parts)) return record
  if (record.role && Array.isArray(asRecord(record)?.parts)) return record
  // 整条 UIMessage
  if (typeof record.role === "string" && Array.isArray(record.parts)) return record
  return content
}

export function extractTextFromContent(content: unknown) {
  const record = asRecord(content)
  if (!record) return typeof content === "string" ? content : ""
  if (typeof record.text === "string") return record.text
  const parts = Array.isArray(record.parts) ? record.parts : []
  const texts = parts
    .map((part) => asRecord(part))
    .filter(isPresent)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
  return texts.join("\n")
}

export function extractPersistedParts(content: unknown) {
  const record = asRecord(content)
  if (!record) return null
  const parts = record.parts
  if (!Array.isArray(parts) || parts.length === 0) return null
  // 仅保留 AI SDK 已知 part 类型；移除中间态（input-streaming 等）改成终态以便重渲染。
  const sanitized = parts
    .map((part) => sanitizeUIMessagePart(part))
    .filter((part): part is Record<string, unknown> => part != null)
  if (sanitized.length === 0) return null
  // 历史消息若残留多条 data-intent-route，只保留最后一条
  let lastIntentIndex = -1
  for (let index = 0; index < sanitized.length; index += 1) {
    if (sanitized[index]?.type === "data-intent-route") lastIntentIndex = index
  }
  if (lastIntentIndex < 0) return sanitized
  return sanitized.filter((part, index) => part.type !== "data-intent-route" || index === lastIntentIndex)
}

export function sanitizeUIMessagePart(part: unknown): Record<string, unknown> | null {
  const record = asRecord(part)
  if (!record) return null
  const type = typeof record.type === "string" ? record.type : ""
  if (!type) return null
  if (type === "text" || type === "reasoning") {
    if (typeof record.text !== "string") return null
    return { type, text: record.text }
  }
  if (type === "step-start") {
    return { type }
  }
  if (type.startsWith("tool-") || type === "dynamic-tool") {
    // 把流式中间态归一化为最终态，避免恢复时停在 input-streaming
    const next: Record<string, unknown> = { ...record }
    const state = typeof record.state === "string" ? record.state : ""
    if (state === "input-streaming" || state === "input-available") {
      next.state = "output-available"
    } else if (!state) {
      next.state = "output-available"
    }
    if (next.output === undefined && next.result !== undefined) {
      next.output = next.result
    }
    return next
  }
  if (type === "source-url" || type === "source-document" || type === "file") {
    return record
  }
  // 自定义 data-* part（如 data-context-compress / data-intent-route）：原样保留 type/id/data，供刷新后重放。
  // context-compress 落库前会剥离；intent-route 的 done 态保留以便常驻展示。
  if (type.startsWith("data-")) {
    return record
  }
  return null
}

export function extractPersistedMessageMetadata(content: unknown) {
  const record = asRecord(content)
  if (!record) return null
  const custom: Record<string, unknown> = {}
  if (record.usage !== undefined) custom.usage = record.usage
  if (typeof record.modelId === "string") custom.modelId = record.modelId
  if (typeof record.modelName === "string") custom.modelName = record.modelName
  if (typeof record.firstTokenTime === "number") custom.firstTokenTime = record.firstTokenTime
  if (typeof record.totalStreamTime === "number") custom.totalStreamTime = record.totalStreamTime
  if (typeof record.totalChunks === "number") custom.totalChunks = record.totalChunks
  if (typeof record.tokensPerSecond === "number") custom.tokensPerSecond = record.tokensPerSecond
  if (record.subAgentUsage !== undefined) custom.subAgentUsage = record.subAgentUsage
  return Object.keys(custom).length > 0 ? { custom } : null
}

export function formatContextWindow(tokens: number | null | undefined): string | null {
  if (tokens == null || !Number.isFinite(tokens) || tokens <= 0) return null
  if (tokens >= 1_000_000) {
    const v = tokens / 1_000_000
    return `${Number.isInteger(v) ? v : v.toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    const v = tokens / 1_000
    return `${Number.isInteger(v) ? v : Math.round(v)}K`
  }
  return String(tokens)
}

export function formatCompactTokens(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

export function formatStreamTime(ms: number | undefined) {
  if (ms === undefined) return null
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function formatStreamMs(ms: number | undefined) {
  if (ms === undefined) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function readPersistedTiming(metadata: unknown) {
  const root = asRecord(metadata)
  if (!root) return undefined
  const nestedTiming = asRecord(root.timing)
  const record = asRecord(root.custom) ?? root
  const totalStreamTime = typeof record.totalStreamTime === "number"
    ? record.totalStreamTime
    : typeof nestedTiming?.totalStreamTime === "number"
      ? nestedTiming.totalStreamTime
      : undefined
  if (!totalStreamTime) return undefined
  const firstTokenTime = typeof record.firstTokenTime === "number"
    ? record.firstTokenTime
    : typeof nestedTiming?.firstTokenTime === "number"
      ? nestedTiming.firstTokenTime
      : undefined
  const tokensPerSecond = typeof record.tokensPerSecond === "number"
    ? record.tokensPerSecond
    : typeof nestedTiming?.tokensPerSecond === "number"
      ? nestedTiming.tokensPerSecond
      : undefined
  const totalChunks = typeof record.totalChunks === "number"
    ? record.totalChunks
    : typeof nestedTiming?.totalChunks === "number"
      ? nestedTiming.totalChunks
      : 0
  return { firstTokenTime, totalStreamTime, tokensPerSecond, totalChunks }
}

export function readSubAgentUsage(metadata: unknown) {
  const root = asRecord(metadata)
  if (!root) return undefined
  const record = asRecord(root.custom) ?? root
  const usage = asRecord(record.subAgentUsage)
  if (!usage) return undefined
  const calls = typeof usage.calls === "number" ? usage.calls : 0
  if (calls <= 0) return undefined
  const inputTokens = typeof usage.inputTokens === "number" ? usage.inputTokens : 0
  const outputTokens = typeof usage.outputTokens === "number" ? usage.outputTokens : 0
  const totalTokens = typeof usage.totalTokens === "number" ? usage.totalTokens : inputTokens + outputTokens
  return { calls, totalTokens }
}

export function extractLatestAssistantUsage(messages: unknown): ThreadTokenUsage | undefined {
  const arr = Array.isArray(messages) ? messages : []
  for (let idx = arr.length - 1; idx >= 0; idx -= 1) {
    const message = arr[idx] as { role?: unknown; metadata?: unknown } | undefined
    if (!message || message.role !== "assistant") continue
    const metadata = asRecord(message.metadata)
    if (!metadata) continue
    const usage = normalizeUsageRecord(metadata.usage)
    if (usage) return usage
    const fromCustom = normalizeUsageRecord(asRecord(metadata.custom)?.usage)
    if (fromCustom) return fromCustom
    const fromContent = normalizeUsageRecord(asRecord(asRecord(metadata)?.content)?.usage)
    if (fromContent) return fromContent
  }
  return undefined
}

export function normalizeUsageRecord(value: unknown): ThreadTokenUsage | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const result: ThreadTokenUsage = {}
  let hasFields = false
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "reasoningTokens", "cachedInputTokens"] as const) {
    const raw = record[key]
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      result[key] = raw
      hasFields = true
    }
  }
  if (!hasFields) return undefined
  if (result.totalTokens === undefined && result.inputTokens !== undefined && result.outputTokens !== undefined) {
    result.totalTokens = result.inputTokens + result.outputTokens
  }
  return result
}

export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function firstTextOfParts(parts: readonly unknown[]): string {
  for (const raw of parts) {
    const part = asRecord(raw)
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
      return part.text.trim()
    }
  }
  return ""
}

/** 用户消息取问题原文；AI 回复优先取正文首个 Markdown 标题，否则取首行。 */
export function deriveQaTocText(role: string, raw: string): string {
  const fallback = role === "user" ? "（空消息）" : "AI 回答"
  if (!raw) return fallback
  if (role === "assistant") {
    const heading = raw.match(/^#{1,6}\s+(.+)$/m)?.[1]
    if (heading) return stripInlineMarkdown(heading) || fallback
    const line = raw
      .split("\n")
      .map((item) => item.trim())
      .find((item) => item.length > 0 && !item.startsWith("```"))
    return stripInlineMarkdown(line ?? "") || fallback
  }
  return stripInlineMarkdown(raw) || fallback
}
