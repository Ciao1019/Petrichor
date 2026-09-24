import * as React from "react"
import { Globe, PencilLine } from "@/components/iconimate"
import type { DiscussionUser } from "@/components/editor/plugins/discussion-kit"
import { cn } from "@/lib/utils"
import { InboxComposer, type InboxComposerHandle } from "../InboxComposer"
import { CaptureWorkspace } from "./CaptureWorkspace"

type Mode = "write" | "capture"
const MODES = [{ value: "write", label: "随手写", Icon: PencilLine }, { value: "capture", label: "网页采集", Icon: Globe }] as const

interface Props { userId: string; currentUser?: DiscussionUser; onSaved: () => void; sourceRequest?: { id: string; requestedAt: number } }

// 两种记录方式共用一张卡片：标签页位于卡片头部，切换时各自的草稿与采集状态保持挂载。
export function InboxCaptureComposer({ userId, currentUser, onSaved, sourceRequest }: Props) {
  const [mode, setMode] = React.useState<Mode>("write")
  const [busy, setBusy] = React.useState(false)
  const rootRef = React.useRef<HTMLElement>(null)
  const composerRef = React.useRef<InboxComposerHandle>(null)
  const tabRefs = React.useRef<Partial<Record<Mode, HTMLButtonElement | null>>>({})
  const baseId = React.useId()
  React.useEffect(() => { if (sourceRequest) setMode("capture") }, [sourceRequest])

  function moveFocus(event: React.KeyboardEvent) {
    const index = MODES.findIndex((item) => item.value === mode)
    const nextIndex = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? MODES.length - 1 : null
    if (nextIndex === null || busy) return
    event.preventDefault()
    const next = MODES[(nextIndex + MODES.length) % MODES.length]!.value
    setMode(next)
    tabRefs.current[next]?.focus()
  }

  function append(value: Parameters<InboxComposerHandle["append"]>[0]) {
    if (!composerRef.current) throw new Error("编辑器正在加载，请稍后重试")
    composerRef.current.append(value)
    setMode("write")
    requestAnimationFrame(() => rootRef.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }))
  }

  return (
    <section ref={rootRef} aria-label="记录随笔" className="min-w-0 scroll-mt-4 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs transition-[border-color,box-shadow] focus-within:border-border focus-within:shadow-sm">
      <div role="tablist" aria-label="创作方式" className="flex items-center gap-1 border-b border-border/50 px-2 sm:px-3">
        {MODES.map(({ value, label, Icon }) => {
          const active = mode === value
          return (
            <button key={value} ref={(node) => { tabRefs.current[value] = node }} type="button" role="tab" id={`${baseId}-${value}-tab`}
              aria-selected={active} aria-controls={`${baseId}-${value}-panel`} tabIndex={active ? 0 : -1} disabled={busy && !active}
              onClick={() => setMode(value)} onKeyDown={moveFocus}
              className={cn(
                "relative flex h-10 items-center gap-1.5 px-2.5 text-xs transition-colors focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-ring disabled:opacity-50",
                "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:transition-colors",
                active ? "font-medium text-foreground after:bg-foreground" : "text-muted-foreground after:bg-transparent hover:text-foreground"
              )}>
              <Icon className="size-3.5" />{label}
            </button>
          )
        })}
      </div>
      <div role="tabpanel" id={`${baseId}-write-panel`} aria-labelledby={`${baseId}-write-tab`} hidden={mode !== "write"}>
        <InboxComposer userId={userId} currentUser={currentUser} onSaved={onSaved} composerRef={composerRef} onBusyChange={setBusy} />
      </div>
      <div role="tabpanel" id={`${baseId}-capture-panel`} aria-labelledby={`${baseId}-capture-tab`} hidden={mode !== "capture"}>
        <CaptureWorkspace userId={userId} active={mode === "capture"} sourceRequest={sourceRequest} onSaved={onSaved} onAppend={append} />
      </div>
    </section>
  )
}
