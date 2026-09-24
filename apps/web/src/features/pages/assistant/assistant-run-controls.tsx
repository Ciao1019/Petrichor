import * as React from "react"
import { useAuiState } from "@assistant-ui/react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { assistantControlApi, type AssistantRecoveryState } from "@/lib/api-assistant-control"
import { isDemoMode } from "@/lib/demo/demo-mode"
import { AssistantResumeContext } from "./assistant-run-control-context"

export function AssistantRunControls({ threadId }: { threadId: string | null }) {
  const running = useAuiState((s) => s.thread.isRunning)
  const resume = React.useContext(AssistantResumeContext)
  const [recovery, setRecovery] = React.useState<AssistantRecoveryState | null>(null)
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState("")
  const [mode, setMode] = React.useState<"steer" | "follow_up">("steer")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [refresh, setRefresh] = React.useState(0)

  React.useEffect(() => {
    if (!threadId || isDemoMode()) return
    let active = true
    const check = () => {
      void assistantControlApi.recovery(threadId).then(({ data }) => {
        if (active) setRecovery(data)
      }).catch(() => {
        if (active) setError("暂时无法读取任务状态")
      })
    }
    check()
    // 断线后等待服务端取消或租约过期，恢复入口会自动出现。
    const timer = window.setInterval(check, 10000)
    return () => { active = false; window.clearInterval(timer) }
  }, [threadId, running, refresh])

  if (!threadId || isDemoMode()) return null
  const active = running || recovery?.running
  if (!active && !recovery?.available && !recovery?.needsReview && !error) return null

  const send = async () => {
    setBusy(true)
    setError("")
    try {
      await assistantControlApi.send(threadId, mode, text.trim())
      setText("")
      setOpen(false)
      toast.success(mode === "steer" ? "要求已排队，将在当前步骤结束后读取" : "要求已排队，将在本轮工作结束后继续")
    } catch {
      setError("未能追加要求，任务可能已结束。输入已保留。")
    } finally {
      setBusy(false)
      setRefresh((value) => value + 1)
    }
  }

  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-1 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        {active ? <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>补充要求</Button> : null}
        {active && !running ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={async () => {
          setBusy(true)
          try { await assistantControlApi.send(threadId, "cancel"); setRefresh((value) => value + 1) }
          catch { setError("未能停止任务，请稍后重试") }
          finally { setBusy(false) }
        }}>停止后台任务</Button> : null}
        {!active && recovery?.available ? <>
          <span>上次任务已保存进度</span>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setRecovery(null); resume() }}>从检查点继续</Button>
        </> : null}
        {!active && recovery?.needsReview ? <span role="status">上次写操作的结果待核实，请确认外部状态后重新发起任务。</span> : null}
      </div>
      {open && active ? (
        <div className="mt-2 space-y-2 rounded-xl border bg-background p-3">
          <label htmlFor="assistant-steering" className="font-medium text-foreground">补充本次任务的要求</label>
          <Textarea id="assistant-steering" value={text} onChange={(event) => setText(event.target.value)} maxLength={4000} disabled={busy} placeholder="例如：重点对比部署成本，并保留来源链接" className="min-h-20" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2">处理时机
              <select aria-label="处理时机" value={mode} onChange={(event) => setMode(event.target.value as "steer" | "follow_up")} disabled={busy} className="rounded-md border bg-background px-2 py-1 text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                <option value="steer">当前步骤结束后</option>
                <option value="follow_up">本轮工作结束后</option>
              </select>
            </label>
            <Button type="button" size="sm" onClick={() => void send()} disabled={busy || !text.trim()}>{busy ? "正在提交…" : "追加要求"}</Button>
          </div>
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-1 text-destructive">{error}<button type="button" className="ml-2 underline" onClick={() => { setError(""); setRefresh((value) => value + 1) }}>重试</button></p> : null}
    </div>
  )
}
