import type { AiModelCapability, AiProviderAccent, AiPurpose } from "@/lib/api"

/** 供应商徽章配色，跟目录里的 accent 一一对应 */
export const ACCENT_CLASS: Record<AiProviderAccent, string> = {
  emerald: "bg-emerald-500/10 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900",
  orange: "bg-orange-500/10 text-orange-700 border-orange-200 dark:text-orange-400 dark:border-orange-900",
  blue: "bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-900",
  violet: "bg-violet-500/10 text-violet-700 border-violet-200 dark:text-violet-400 dark:border-violet-900",
  amber: "bg-amber-500/10 text-amber-700 border-amber-200 dark:text-amber-400 dark:border-amber-900",
  rose: "bg-rose-500/10 text-rose-700 border-rose-200 dark:text-rose-400 dark:border-rose-900",
  cyan: "bg-cyan-500/10 text-cyan-700 border-cyan-200 dark:text-cyan-400 dark:border-cyan-900",
  slate: "bg-slate-500/10 text-slate-700 border-slate-200 dark:text-slate-400 dark:border-slate-800",
}

export const PURPOSE_LABEL: Record<AiPurpose, string> = {
  CHAT: "对话（Chat）",
  VISION: "多模态（Vision）",
  DOC_QA: "文档库问答（Doc QA）",
  EMBEDDING: "向量嵌入（Embedding）",
}

export const PURPOSE_SUMMARY: Record<AiPurpose, string> = {
  CHAT: "文章摘要、思维导图、知识图谱与站内助手的主力模型。",
  VISION: "把 PDF / Word 的整页图片识别转写为文章内容。",
  DOC_QA: "基于文档库文件内容做 agentic 检索与回答。",
  EMBEDDING: "把文档分块和查询转成向量用于相似度召回。维度由模型自动探测，无需填写。",
}

export const CAPABILITY_LABEL: Record<AiModelCapability, string> = {
  tools: "工具调用",
  vision: "图像输入",
  reasoning: "推理",
  json: "结构化输出",
}

export function formatDateTime(value?: string | null) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

/** 1048576 → 1M，200000 → 200K，用于模型列表里的上下文窗口列 */
export function formatContextWindow(value?: number | null) {
  if (!value || value <= 0) return "-"
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (value >= 1000) return `${Math.round(value / 1000)}K`
  return String(value)
}

/**
 * 取出可读的错误文案。
 *
 * axios 在非 2xx 时抛的 Error.message 是「Request failed with status code 400」这种
 * 对用户毫无信息量的通用串，真正的原因在 response.data.msg 里（见 server/http/response）。
 * 优先取服务端消息，拿不到才退回 axios 文案。
 */
export function errorMessage(error: unknown, fallback: string) {
  const serverMsg = (error as { response?: { data?: { msg?: unknown } } })?.response?.data?.msg
  if (typeof serverMsg === "string" && serverMsg.trim()) return serverMsg.trim()
  if (error instanceof Error && error.message) return error.message
  return fallback
}
