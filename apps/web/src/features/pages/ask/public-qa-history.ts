import type { AssistantThreadSummary } from "@/lib/api"
import { useAgentRunsStore } from "@/features/agent-runs/store"
import { isAgentStreamEvent, type AgentStreamEvent } from "@/features/agent-runs/types"
import type { AssistantUIMessage } from "@/features/pages/assistant/assistant-message-utils"

/**
 * 前台问答的本地历史：只保存在访客自己的浏览器（localStorage），服务端不落库。
 *
 * 保存 AI SDK UIMessage（含 Agent 事件 data part）；恢复时按事件重放出执行面板、
 * 答案与来源，与后台从 Run 接口恢复得到的视图一致。
 */

export const PUBLIC_QA_HISTORY_KEY = "petrichor:public-qa:threads:v1"
const MAX_THREADS = 20
const MAX_MESSAGES_PER_THREAD = 40
/** 回答内容类工具随历史保存；检索、阅读等过程由 Agent 事件承载，不必保存原始输出。 */
const KEPT_TOOL_PART_TYPES = new Set(["tool-show_citations", "tool-show_data_table"])

export interface PublicQaThreadRecord {
  id: string
  title: string
  knowledgeBaseId: string | null
  createdAt: string
  updatedAt: string
  messages: AssistantUIMessage[]
}

function isThreadRecord(value: unknown): value is PublicQaThreadRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return typeof record.id === "string"
    && typeof record.title === "string"
    && typeof record.updatedAt === "string"
    && (record.knowledgeBaseId === null || typeof record.knowledgeBaseId === "string")
    && Array.isArray(record.messages)
}

function readAll(): PublicQaThreadRecord[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PUBLIC_QA_HISTORY_KEY) ?? "[]")
    return Array.isArray(raw) ? raw.filter(isThreadRecord) : []
  } catch {
    return []
  }
}

function writeAll(threads: PublicQaThreadRecord[]) {
  let list = [...threads]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_THREADS)
  // 空间不足时从最旧的对话开始丢弃，保证最近的对话能保存下来。
  while (list.length > 0) {
    try {
      localStorage.setItem(PUBLIC_QA_HISTORY_KEY, JSON.stringify(list))
      return
    } catch {
      list = list.slice(0, -1)
    }
  }
  try {
    localStorage.removeItem(PUBLIC_QA_HISTORY_KEY)
  } catch {
    // 存储不可用时历史只保留在当前页面。
  }
}

function messageText(message: AssistantUIMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}

function compactMessages(messages: AssistantUIMessage[]): AssistantUIMessage[] {
  return messages.slice(-MAX_MESSAGES_PER_THREAD).map((message) => ({
    ...message,
    parts: message.parts.filter((part) => !part.type.startsWith("tool-") || KEPT_TOOL_PART_TYPES.has(part.type)),
  }))
}

/** 与后台历史列表同构，便于复用同一套分组与条目组件。 */
export function listPublicQaThreads(): AssistantThreadSummary[] {
  return readAll().map((thread) => ({
    id: thread.id,
    title: thread.title,
    focus: thread.knowledgeBaseId ? { knowledgeBaseId: thread.knowledgeBaseId } : null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  }))
}

export function loadPublicQaThread(id: string): PublicQaThreadRecord | null {
  return readAll().find((thread) => thread.id === id) ?? null
}

export function savePublicQaThread(input: {
  id: string
  knowledgeBaseId: string | null
  messages: AssistantUIMessage[]
}): void {
  if (input.messages.length === 0) return
  const threads = readAll()
  const existing = threads.find((thread) => thread.id === input.id)
  const firstQuestion = input.messages.find((message) => message.role === "user")
  const now = new Date().toISOString()
  const record: PublicQaThreadRecord = {
    id: input.id,
    title: existing?.title || Array.from(firstQuestion ? messageText(firstQuestion) : "").slice(0, 40).join("") || "新对话",
    knowledgeBaseId: input.knowledgeBaseId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messages: compactMessages(input.messages),
  }
  writeAll([record, ...threads.filter((thread) => thread.id !== input.id)])
}

export function deletePublicQaThread(id: string): void {
  writeAll(readAll().filter((thread) => thread.id !== id))
}

/** 按 Agent 事件重放恢复执行面板；恢复态交给消息正文渲染答案，与后台刷新恢复一致。 */
export function restoreRunsFromMessages(messages: AssistantUIMessage[]): void {
  const eventsByRun = new Map<string, AgentStreamEvent[]>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-agent-event") continue
      const event: unknown = (part as { data?: unknown }).data
      if (!isAgentStreamEvent(event)) continue
      const events = eventsByRun.get(event.runId) ?? []
      events.push(event)
      eventsByRun.set(event.runId, events)
    }
  }
  const store = useAgentRunsStore.getState()
  for (const [runId, events] of eventsByRun) {
    store.replay(runId, events)
    const run = useAgentRunsStore.getState().runs[runId]
    if (run) store.hydrate({ ...run, hydrated: true })
  }
}
