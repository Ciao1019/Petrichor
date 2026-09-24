import { Gauge } from "@/components/iconimate"

import { asRecord } from "./assistant-message-utils"

/** 只在工具预算真实耗尽时提示；历史消息里遗留的 warning/resolved 一律不展示。 */
export function StepBudgetNotice({ data }: { data: unknown }) {
  const payload = asRecord(data)
  if (payload?.status !== "exhausted") return null
  const label = typeof payload.label === "string" && payload.label.trim()
    ? payload.label.trim()
    : "本轮工具调用预算已用尽；如答案不完整，可继续发送消息"
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
