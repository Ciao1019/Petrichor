"use client"

import * as React from "react"
import { Check, Circle, Loader2, ListTodo, X } from "lucide-react"
import { useAuiState } from "@assistant-ui/react"

import {
  safeParseSerializablePlan,
  type SerializablePlan,
} from "@/components/tool-ui/plan/schema"
import { safeParseSerializableProgressTracker } from "@/components/tool-ui/progress-tracker/schema"
import { cn } from "@/lib/utils"

import { scrollQaViewportToMessage } from "./assistant-toc"

const TASK_TOOL_NAMES = new Set(["show_progress", "upsert_plan"])

export type AssistantTaskStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"

export type AssistantTaskStep = {
  id: string
  label: string
  status: AssistantTaskStepStatus
}

export type AssistantLiveTask = {
  id: string
  title: string
  description?: string
  steps: AssistantTaskStep[]
  source: "progress" | "plan"
  /** 产出该任务的消息 id，供侧栏点击滚动 */
  messageId?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function normalizeProgressStatus(status: string): AssistantTaskStepStatus {
  if (status === "in-progress") return "in_progress"
  if (status === "pending" || status === "completed" || status === "failed") return status
  return "pending"
}

export function planToLiveTask(plan: SerializablePlan, messageId?: string): AssistantLiveTask {
  return {
    id: plan.id,
    title: plan.title,
    description: plan.description,
    source: "plan",
    messageId,
    steps: plan.todos.map((todo) => ({
      id: todo.id,
      label: todo.label,
      status: todo.status,
    })),
  }
}

export function taskHasIncompleteSteps(task: AssistantLiveTask): boolean {
  return task.steps.some((step) => step.status === "pending" || step.status === "in_progress")
}

/** 冷启动：取最新一条仍有未完成 todo 的 Plan。plans 假定已按 updated_at desc。 */
export function pickPersistedTaskForRail(
  plans: readonly SerializablePlan[] | null | undefined,
): AssistantLiveTask | null {
  if (!plans?.length) return null
  for (const plan of plans) {
    const task = planToLiveTask(plan)
    if (taskHasIncompleteSteps(task)) return task
  }
  return null
}

/**
 * live 优先；本轮从未出现 live 时才回落 persisted（避免 settle/dismiss 后立刻被库态顶回）。
 */
export function resolveRailTask(input: {
  liveTask: AssistantLiveTask | null
  persistedTask: AssistantLiveTask | null
  sawLiveThisMount: boolean
}): AssistantLiveTask | null {
  if (input.liveTask) return input.liveTask
  if (!input.sawLiveThisMount) return input.persistedTask
  return null
}

function extractLiveTaskFromMessages(messages: readonly { id?: string; parts?: readonly unknown[] }[]): AssistantLiveTask | null {
  let latest: AssistantLiveTask | null = null

  for (const message of messages) {
    const messageId = typeof message.id === "string" ? message.id : undefined
    const parts = Array.isArray(message.parts) ? message.parts : []
    for (const raw of parts) {
      const part = asRecord(raw)
      if (!part || part.type !== "tool-call") continue
      const toolName = typeof part.toolName === "string" ? part.toolName : ""
      if (!TASK_TOOL_NAMES.has(toolName)) continue

      const payload = part.result ?? part.args
      if (toolName === "show_progress") {
        const parsed = safeParseSerializableProgressTracker(payload)
        if (!parsed) continue
        const active =
          parsed.steps.find((step) => step.status === "in-progress") ??
          parsed.steps.find((step) => step.status === "pending") ??
          parsed.steps[0]
        latest = {
          id: parsed.id,
          title: parsed.choice?.summary || active?.label || "任务进度",
          description: undefined,
          source: "progress",
          messageId,
          steps: parsed.steps.map((step) => ({
            id: step.id,
            label: step.label,
            status: normalizeProgressStatus(step.status),
          })),
        }
        continue
      }

      const parsed = safeParseSerializablePlan(payload)
      if (!parsed) continue
      latest = planToLiveTask(parsed, messageId)
    }
  }

  return latest
}

/** 流结束后把卡死的 in_progress / 未执行 pending 收口，避免侧栏一直转圈。 */
export function settleLiveTask(task: AssistantLiveTask, isRunning: boolean): AssistantLiveTask {
  if (isRunning) return task

  const hasIncomplete = task.steps.some(
    (step) => step.status === "in_progress" || step.status === "pending",
  )
  if (!hasIncomplete) return task

  const hasFailure = task.steps.some((step) => step.status === "failed")
  return {
    ...task,
    steps: task.steps.map((step) => {
      if (step.status === "in_progress") {
        return { ...step, status: hasFailure ? "cancelled" : "completed" }
      }
      if (step.status === "pending") {
        return { ...step, status: "cancelled" }
      }
      return step
    }),
  }
}

export function AssistantTaskRail({
  persistedPlans,
}: {
  persistedPlans?: SerializablePlan[] | null
} = {}) {
  const messages = useAuiState((s) => s.thread.messages)
  const isRunning = useAuiState((s) => s.thread.isRunning)
  const [dismissedId, setDismissedId] = React.useState<string | null>(null)
  const [pinned, setPinned] = React.useState(false)

  const rawLive = React.useMemo(() => extractLiveTaskFromMessages(messages), [messages])
  const [sawLiveThisMount, setSawLiveThisMount] = React.useState(false)
  React.useEffect(() => {
    if (rawLive) setSawLiveThisMount(true)
  }, [rawLive])

  const settledLive = React.useMemo(
    () => (rawLive ? settleLiveTask(rawLive, isRunning) : null),
    [rawLive, isRunning],
  )
  const persistedTask = React.useMemo(
    () => pickPersistedTaskForRail(persistedPlans),
    [persistedPlans],
  )
  const task = React.useMemo(
    () => resolveRailTask({
      liveTask: settledLive,
      persistedTask,
      sawLiveThisMount,
    }),
    [settledLive, persistedTask, sawLiveThisMount],
  )
  const isPersistedOnly = !!task && !settledLive

  React.useEffect(() => {
    if (isRunning && rawLive) setPinned(true)
  }, [isRunning, rawLive])

  React.useEffect(() => {
    if (!task) {
      setDismissedId(null)
      return
    }
    if (dismissedId && dismissedId !== task.id) setDismissedId(null)
  }, [task, dismissedId])

  const completedCount = task?.steps.filter((step) => step.status === "completed").length ?? 0
  const total = task?.steps.length ?? 0
  const allSettled =
    !!task &&
    !isRunning &&
    task.steps.every((step) =>
      step.status === "completed" || step.status === "failed" || step.status === "cancelled",
    )

  React.useEffect(() => {
    // 冷启动 persisted 不自动收起；仅 live 路径在全部收口后短暂展示再 dismiss
    if (!task || !allSettled || !pinned || isPersistedOnly) return
    const timer = window.setTimeout(() => {
      setDismissedId(task.id)
      setPinned(false)
    }, 4000)
    return () => window.clearTimeout(timer)
  }, [task, allSettled, pinned, isPersistedOnly])

  const showLive = !!settledLive && dismissedId !== settledLive.id && (isRunning || pinned)
  const showPersisted = isPersistedOnly && !!task && dismissedId !== task.id
  if (!task || (!showLive && !showPersisted)) return null

  const progress = total > 0 ? Math.round((completedCount / total) * 100) : 0

  return (
    <aside
      className="pointer-events-auto absolute top-16 right-3 z-20 w-[220px] rounded-lg border border-[#e5e5e5] bg-white/95 p-3 shadow-sm backdrop-blur-sm dark:border-[#2a2a2a] dark:bg-[#1a1a1a]/95"
      aria-label="任务进度"
    >
      <div className="mb-2 flex items-start gap-2">
        <ListTodo className="mt-0.5 size-3.5 shrink-0 text-[#6b6b6b] dark:text-[#9a9a9a]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-[#0d0d0d] dark:text-white">{task.title}</p>
          <p className="mt-0.5 text-[11px] tabular-nums text-[#9a9a9a]">
            {isRunning ? `${completedCount}/${total}` : allSettled ? "已完成" : `${completedCount}/${total}`}
          </p>
        </div>
        <button
          type="button"
          className="rounded p-0.5 text-[#9a9a9a] hover:bg-[#f0f0f0] hover:text-[#0d0d0d] dark:hover:bg-[#2a2a2a] dark:hover:text-white"
          aria-label="关闭任务面板"
          onClick={() => {
            setDismissedId(task.id)
            setPinned(false)
          }}
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="mb-2.5 h-1 overflow-hidden rounded-full bg-[#ececec] dark:bg-[#2a2a2a]">
        <div
          className="h-full rounded-full bg-[#0d0d0d] transition-[width] duration-300 dark:bg-white"
          style={{ width: `${progress}%` }}
        />
      </div>

      <ul className="space-y-1.5">
        {task.steps.map((step) => {
          const canScroll = Boolean(task.messageId)
          const content = (
            <>
              <StepIcon status={step.status} />
              <span
                className={cn(
                  "min-w-0 flex-1 text-left text-[12px] leading-snug",
                  step.status === "pending" || step.status === "cancelled"
                    ? "text-[#9a9a9a]"
                    : "text-[#3a3a3a] dark:text-[#c8c8c8]",
                  step.status === "cancelled" && "line-through",
                )}
              >
                {step.label}
              </span>
            </>
          )
          return (
            <li key={step.id}>
              {canScroll ? (
                <button
                  type="button"
                  className="-mx-1 flex w-[calc(100%+0.5rem)] items-start gap-2 rounded-md px-1 py-0.5 text-left hover:bg-[#f5f5f5] dark:hover:bg-[#252525]"
                  onClick={() => {
                    if (task.messageId) scrollQaViewportToMessage(task.messageId)
                  }}
                >
                  {content}
                </button>
              ) : (
                <div className="flex items-start gap-2">{content}</div>
              )}
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

function StepIcon({ status }: { status: AssistantTaskStepStatus }) {
  if (status === "completed") {
    return <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" strokeWidth={2.5} />
  }
  if (status === "in_progress") {
    return <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-[#0d0d0d] dark:text-white" />
  }
  if (status === "failed") {
    return <X className="mt-0.5 size-3.5 shrink-0 text-destructive" strokeWidth={2.5} />
  }
  return <Circle className="mt-0.5 size-3.5 shrink-0 text-[#c8c8c8] dark:text-[#4a4a4a]" />
}

export { TASK_TOOL_NAMES }
