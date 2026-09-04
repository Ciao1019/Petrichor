import { Gauge } from "@/components/iconimate"

import { asRecord } from "./assistant-message-utils"

/** 预算告警只展示运行中 warning 与真实 exhausted；resolved 会立即卸下提示。 */
export function StepBudgetNotice({ data }: { data: unknown }) {
  const payload = asRecord(data)
  if (!payload) return null
  const status = payload.status
  if (status !== "warning" && status !== "exhausted") return null
  const label = typeof payload.label === "string" && payload.label.trim()
    ? payload.label.trim()
    : status === "exhausted"
      ? "本轮工具调用预算已用尽；如答案不完整，可继续发送消息"
      : "工具调用预算即将用尽，当前任务仍在继续"
  return (
    <div
      className="mb-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-xs text-amber-950/80 dark:text-amber-100/90"
      role="status"
    >
      <Gauge className="mt-0.5 size-3.5 shrink-0 opacity-80" aria-hidden />
      <span>{label}</span>
    </div>
  )
}
