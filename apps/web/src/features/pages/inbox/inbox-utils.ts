import type { InboxNote } from "@/lib/api"

export const INBOX_MAX_LENGTH = 20_000
export const INBOX_PAGE_SIZE = 20

function richNodeText(node: unknown): string {
  if (!node || typeof node !== "object") return ""
  if ("text" in node && typeof node.text === "string") return node.text
  if ("children" in node && Array.isArray(node.children)) return node.children.map(richNodeText).join("")
  return ""
}

export function suggestInboxTitle(content: string, contentJson?: string | null) {
  if (contentJson) {
    try {
      const parsed: unknown = JSON.parse(contentJson)
      const nodes: unknown[] = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && "value" in parsed && Array.isArray(parsed.value) ? parsed.value : []
      const text = nodes.map(richNodeText).map((line) => line.trim()).find(Boolean)
      if (text) return Array.from(text).slice(0, 80).join("")
    } catch { /* 旧记录或损坏的结构继续从 Markdown 提取标题。 */ }
  }
  const line = content.split("\n").map((value) => value.trim()).find((value) => value && !value.startsWith("![")) ?? "随笔整理"
  return Array.from(line.replace(/<[^>]*>/g, "").replace(/^#{1,6}\s+/, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`]/g, "")).slice(0, 80).join("") || "随笔整理"
}

export function formatInboxTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  const now = new Date()
  const isSameYear = date.getFullYear() === now.getFullYear()
  const isToday = isSameYear && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = isSameYear && date.getMonth() === yesterday.getMonth() && date.getDate() === yesterday.getDate()

  const timeStr = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
  if (isToday) return `今天 ${timeStr}`
  if (isYesterday) return `昨天 ${timeStr}`
  if (isSameYear) return `${date.getMonth() + 1}月${date.getDate()}日 ${timeStr}`
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${timeStr}`
}

// 保存快捷键提示随平台显示，实际监听同时支持 ⌘ 与 Ctrl。
export function saveShortcutLabel() {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent
  return /Mac|iPhone|iPad/i.test(platform) ? "⌘↵" : "Ctrl↵"
}

export function inboxDraftKey(userId: string) { return `petrichor:inbox-draft:${userId}` }

export interface InboxDraft { captureIds?: string[]; contentMd: string; contentJson?: string | null; contentMetaJson?: string | null; tags: string[]; clientId: string }
export function readInboxDraft(userId: string, note?: InboxNote): InboxDraft {
  const fallback = { contentMd: note?.contentMd ?? "", contentJson: note?.contentJson ?? null, contentMetaJson: note?.contentMetaJson ?? null, tags: note?.tags ?? [], clientId: crypto.randomUUID() }
  if (note) return fallback
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(inboxDraftKey(userId)) ?? "null")
    if (raw && typeof raw === "object" && "contentMd" in raw && typeof raw.contentMd === "string" &&
      "tags" in raw && Array.isArray(raw.tags) && raw.tags.every((tag): tag is string => typeof tag === "string") &&
      "clientId" in raw && typeof raw.clientId === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(raw.clientId)) {
      return {
        contentMd: raw.contentMd, tags: raw.tags, clientId: raw.clientId,
        captureIds: "captureIds" in raw && Array.isArray(raw.captureIds) ? raw.captureIds.filter((id): id is string => typeof id === "string").slice(0,20) : [],
        contentJson: "contentJson" in raw && typeof raw.contentJson === "string" ? raw.contentJson : null,
        contentMetaJson: "contentMetaJson" in raw && typeof raw.contentMetaJson === "string" ? raw.contentMetaJson : null,
      }
    }
  } catch { /* 隐私模式或损坏的草稿不影响记录。 */ }
  return fallback
}
