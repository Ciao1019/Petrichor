import { toast } from "sonner"

import type { AgentApiKeyScope } from "@/lib/api"

export const DEFAULT_AGENT_SCOPES: AgentApiKeyScope[] = [
  "article:write",
  "article:delete",
  "doc:read",
  "qa:read",
  "share:write",
  "ai:write",
]

export const scopeLabels: Record<AgentApiKeyScope, string> = {
  "article:write": "新建/更新文章",
  "article:delete": "删除文章",
  "doc:read": "文档查看",
  "qa:read": "文档问答",
  "share:write": "文章分享管理",
  "ai:write": "AI 摘要/思维导图",
}

export function formatDateTime(value?: string | null) {
  if (!value) return "从未"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

export function normalizeAxiosErrorMessage(e: unknown, fallback: string): string {
  if (typeof e === "object" && e && "response" in e) {
    const response = (e as { response?: { data?: { msg?: unknown } } }).response
    const apiMsg = response?.data?.msg
    if (typeof apiMsg === "string" && apiMsg) return apiMsg
  }
  if (e instanceof Error && e.message) return e.message
  return fallback
}

export async function copyToClipboard(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value)
    toast.success(`已复制${label}`)
  } catch {
    toast.error("复制失败")
  }
}

export function getBaseUrl() {
  if (typeof window === "undefined") return ""
  return window.location.origin
}

export function buildShellSnippet(apiKey: string) {
  return [
    `export PETRICHOR_BASE_URL="${getBaseUrl()}"`,
    `export PETRICHOR_API_KEY="${apiKey}"`,
    `export PETRICHOR_AGENT_SOURCE="codex"`,
    `export PETRICHOR_AGENT_TOOL="petrichor-setup"`,
  ].join("\n")
}

export function getSkillUrl() {
  const baseUrl = getBaseUrl()
  return baseUrl ? `${baseUrl}/api/agent/skill` : "/api/agent/skill"
}

export function getSkillPackUrl() {
  const baseUrl = getBaseUrl()
  return baseUrl ? `${baseUrl}/api/agent/skill-pack` : "/api/agent/skill-pack"
}

export function formatPayload(value: unknown, fallback?: string | null) {
  if (value == null) return fallback || "-"
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return fallback || String(value)
  }
}
