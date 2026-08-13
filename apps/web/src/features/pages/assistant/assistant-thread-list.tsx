"use client"

import * as React from "react"
import { Globe2, Library, Loader2, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { type AssistantThreadSummary } from "@/lib/api"
import { cn } from "@/lib/utils"

import { focusFromThread, formatRelativeTime } from "./assistant-message-utils"

export function ThreadGroup({
  label,
  threads,
  activeThreadId,
  onSelect,
  onDelete,
  manageMode,
  selectedIds,
  onToggleSelect,
}: {
  label: string
  threads: AssistantThreadSummary[]
  activeThreadId: string | null
  onSelect: (id: string) => void | Promise<void>
  onDelete: (thread: AssistantThreadSummary) => void
  manageMode: boolean
  selectedIds: Set<string>
  onToggleSelect: (threadId: string) => void
}) {
  return (
    <div className="px-2 pt-2 first:pt-0">
      <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {label}
      </div>
      <div className="space-y-0.5">
        {threads.map((thread) => (
          <ThreadButton
            key={thread.id}
            thread={thread}
            active={thread.id === activeThreadId}
            onClick={() => {
              if (manageMode) onToggleSelect(thread.id)
              else void onSelect(thread.id)
            }}
            onDelete={() => onDelete(thread)}
            manageMode={manageMode}
            selected={selectedIds.has(thread.id)}
          />
        ))}
      </div>
    </div>
  )
}

export function ThreadButton({
  thread,
  active,
  onClick,
  onDelete,
  manageMode,
  selected,
}: {
  thread: AssistantThreadSummary
  active: boolean
  onClick: () => void
  onDelete: () => void
  manageMode: boolean
  selected: boolean
}) {
  const focus = focusFromThread(thread.focus)
  const showSelectionHighlight = manageMode && selected
  return (
    <div
      className={cn(
        "group/thread relative grid w-full min-w-0 items-center gap-1 overflow-hidden rounded-md transition-colors",
        manageMode
          ? "grid-cols-[1.5rem_minmax(0,1fr)] pl-1.5 pr-1"
          : "grid-cols-[minmax(0,1fr)_1.75rem] pr-1",
        active && !manageMode
          ? "bg-accent text-foreground"
          : showSelectionHighlight
            ? "bg-violet-500/10 text-foreground"
            : "text-foreground/85 hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {active && !manageMode ? (
        <span className="absolute left-0 top-1.5 h-[calc(100%-12px)] w-0.5 rounded-r-full bg-violet-500" />
      ) : null}
      {manageMode ? (
        <Checkbox
          checked={selected}
          onCheckedChange={onClick}
          aria-label={selected ? "取消选中" : "选中对话"}
          className="size-3.5"
        />
      ) : null}
      <button
        type="button"
        onClick={onClick}
        className="block min-w-0 max-w-full overflow-hidden px-2.5 py-1.5 text-left"
      >
        <span className="block min-w-0 max-w-full overflow-hidden">
          <span className="block max-w-full truncate text-[13px] leading-tight">{thread.title}</span>
          <span className="mt-0.5 flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden text-[10.5px] text-muted-foreground">
            {focus.kind === "none" ? (
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-violet-500/10 px-1 py-px font-medium text-violet-600 dark:text-violet-300">
                <Globe2 className="size-2.5" />
                全部
              </span>
            ) : (
              <span className="inline-flex min-w-0 max-w-[120px] shrink items-center gap-0.5 rounded-sm bg-muted px-1 py-px text-muted-foreground">
                <Library className="size-2.5 shrink-0" />
                <span className="truncate">知识库</span>
              </span>
            )}
            <span className="min-w-0 shrink truncate">{formatRelativeTime(thread.updatedAt)}</span>
          </span>
        </span>
      </button>
      {manageMode ? null : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="z-10 size-7 min-w-7 shrink-0 justify-self-end rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={(event) => {
                event.stopPropagation()
                onDelete()
              }}
            >
              <Trash2 className="size-3.5" />
              <span className="sr-only">删除对话</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">删除对话</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

export function InfiniteSentinel({
  enabled,
  loading,
  onIntersect,
}: {
  enabled: boolean
  loading: boolean
  onIntersect: () => void
}) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const onIntersectRef = React.useRef(onIntersect)
  React.useEffect(() => {
    onIntersectRef.current = onIntersect
  }, [onIntersect])

  React.useEffect(() => {
    if (!enabled) return
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onIntersectRef.current()
      },
      { rootMargin: "120px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [enabled])

  if (!enabled && !loading) return null
  return (
    <div ref={ref} className="px-3 pt-2">
      {loading ? (
        <div className="flex items-center justify-center gap-1.5 py-2 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          加载中
        </div>
      ) : (
        <div className="h-4" aria-hidden />
      )}
    </div>
  )
}
