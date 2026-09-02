import { toast } from "sonner"

import type { AgentApiKeyScope } from "@/lib/api"

export const DEFAULT_AGENT_SCOPES: AgentApiKeyScope[] = [
  "article:write",
  "article:delete",
  "doc:read",
  "qa:read",
  "share:write",
  "ai:write",
  "wiki:read",
  "wiki:write",
]

export const scopeLabels: Record<AgentApiKeyScope, string> = {
  "article:write": "新建/更新文章",
  "article:delete": "删除文章",
  "doc:read": "文档查看",
  "qa:read": "文档问答",
  "share:write": "文章分享管理",
  "ai:write": "AI 摘要/思维导图",
  "wiki:read": "知识 Wiki 浏览",
  "wiki:write": "知识 Wiki 重建",
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

export function buildSkillEnvironmentSnippet(apiKey: string) {
  return [
    `export PETRICHOR_BASE_URL="${getBaseUrl()}"`,
    `export PETRICHOR_API_KEY="${apiKey}"`,
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

export function getMcpUrl() {
  const baseUrl = getBaseUrl()
  return baseUrl ? `${baseUrl}/api/mcp` : "/api/mcp"
}

export function buildClaudeCodeMcpSnippet() {
  return [
    `claude mcp add --transport http petrichor ${getMcpUrl()} \\`,
    `  --header "Authorization: Bearer ptc_live_xxx"`,
  ].join("\n")
}

export function buildCodexMcpSnippet() {
  return [
    `# ~/.codex/config.toml`,
    `[mcp_servers.petrichor]`,
    `url = "${getMcpUrl()}"`,
    `http_headers = { Authorization = "Bearer ptc_live_xxx" }`,
  ].join("\n")
}

export function buildJsonMcpSnippet() {
  return JSON.stringify(
    {
      mcpServers: {
        petrichor: {
          url: getMcpUrl(),
          headers: { Authorization: "Bearer ptc_live_xxx" },
        },
      },
    },
    null,
    2,
  )
}

export function buildClaudeCodeSkillSnippet() {
  return [
    `mkdir -p ~/.claude/skills/petrichor`,
    `curl -L "${getSkillUrl()}" -o ~/.claude/skills/petrichor/SKILL.md`,
    ``,
    `export PETRICHOR_BASE_URL="${getBaseUrl()}"`,
    `export PETRICHOR_API_KEY="ptc_live_xxx"`,
  ].join("\n")
}

export function buildCodexSkillSnippet() {
  return [
    `mkdir -p ~/.codex/skills/petrichor`,
    `curl -L "${getSkillUrl()}" -o ~/.codex/skills/petrichor/SKILL.md`,
    ``,
    `export PETRICHOR_BASE_URL="${getBaseUrl()}"`,
    `export PETRICHOR_API_KEY="ptc_live_xxx"`,
  ].join("\n")
}

export function buildGenericSkillSnippet() {
  return [
    `mkdir -p ./skills/petrichor`,
    `curl -L "${getSkillUrl()}" -o ./skills/petrichor/SKILL.md`,
    ``,
    `export PETRICHOR_BASE_URL="${getBaseUrl()}"`,
    `export PETRICHOR_API_KEY="ptc_live_xxx"`,
    ``,
    `curl -sS "$PETRICHOR_BASE_URL/api/agent/capabilities" \\`,
    `  -H "Authorization: Bearer $PETRICHOR_API_KEY"`,
  ].join("\n")
}

// 从审计日志的 User-Agent 中识别 MCP 工具调用（服务端委托请求会带 petrichor-mcp/<toolName> 前缀）
export function parseMcpToolFromUserAgent(userAgent?: string | null): string | null {
  const match = userAgent?.match(/^petrichor-mcp\/([a-z0-9_]+)/)
  return match?.[1] ?? null
}
