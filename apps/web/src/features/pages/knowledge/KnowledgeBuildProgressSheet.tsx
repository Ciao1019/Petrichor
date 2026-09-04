import { AgentPlan, type AgentPlanStep } from "@/components/assistant-ui/elements/agent-plan"
import { AgentStatus, type AgentState } from "@/components/assistant-ui/elements/agent-status"
import { JobProgress, type JobStage } from "@/components/assistant-ui/elements/job-progress"
import { Timeline, type TimelineEvent } from "@/components/assistant-ui/elements/timeline"
import { field, paper } from "@/components/assistant-ui/elements/surfaces"
import { clamp } from "@/components/assistant-ui/utils/range"
import {
  AlertCircle,
  Brain,
  ChevronDown,
  Combine,
  FileText,
  GitForkIcon,
  History,
  Loader2,
  Network,
  RefreshCw,
  Sparkles,
  XCircle,
} from "@/components/iconimate"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type {
  ArticleKnowledgeBuildJobResponse,
  ArticleKnowledgeBuildPhase,
  ArticleKnowledgeBuildProgressStage,
  ArticleKnowledgeBuildStageStatus,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import * as React from "react"
import { KnowledgeBuildAgentActivity } from "./KnowledgeBuildAgentActivity"

const STAGE_ORDER: ArticleKnowledgeBuildPhase[] = [
  "queued",
  "preparing",
  "analyzing",
  "pages",
  "taxonomy",
  "persisting",
  "embedding",
  "completed",
]

const STAGE_LABELS: Record<string, string> = {
  queued: "等待 Worker",
  preparing: "准备文档",
  analyzing: "理解与抽取",
  "analyzing.agent": "文档 Agent 阅读与抽取",
  "analyzing.questions": "生成推荐问题",
  pages: "生成 Wiki 页面",
  taxonomy: "语义合并与目录",
  "taxonomy.resolution": "同义知识与跨文章关系",
  "taxonomy.catalog": "全局知识目录",
  persisting: "保存知识与检索索引",
  embedding: "补充向量索引",
  completed: "完成",
}

const PHASE_INDEX: Partial<Record<ArticleKnowledgeBuildPhase, number>> = Object.fromEntries(
  STAGE_ORDER.map((phase, index) => [phase, index]),
)

/** JobProgress 的阶段序列：八个阶段等权重。 */
const JOB_STAGES: JobStage[] = STAGE_ORDER.map((phase) => ({
  name: STAGE_LABELS[phase] ?? phase,
  weight: 1,
}))

function fallbackStageIndex(job: ArticleKnowledgeBuildJobResponse): number {
  const direct = PHASE_INDEX[job.progress.phase]
  if (direct !== undefined) return direct
  const percent = job.progress.percent
  if (percent >= 95) return 6
  if (percent >= 90) return 5
  if (percent >= 75) return 4
  if (percent >= 45) return 3
  if (percent >= 5) return 2
  return 0
}

function fallbackStages(job: ArticleKnowledgeBuildJobResponse): ArticleKnowledgeBuildProgressStage[] {
  const activeIndex = fallbackStageIndex(job)
  return STAGE_ORDER.map((id, index) => ({
    id,
    status: job.status === "completed"
      ? "completed"
      : index < activeIndex
        ? "completed"
        : index === activeIndex
          ? job.status === "failed" ? "failed" : "running"
          : "pending",
    message: index === activeIndex ? job.progress.message : undefined,
  }))
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 1) return `${remainingSeconds} 秒`
  return `${minutes} 分 ${remainingSeconds.toString().padStart(2, "0")} 秒`
}

function formatEventTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "--:--:--"
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date)
}

function stageCounter(stage: ArticleKnowledgeBuildProgressStage): string | undefined {
  if (!stage.total) return undefined
  return `${stage.completed ?? 0}/${stage.total}`
}

function planStepStatus(status: ArticleKnowledgeBuildStageStatus): AgentPlanStep["status"] {
  if (status === "completed") return "done"
  if (status === "running") return "active"
  if (status === "failed") return "failed"
  return "pending"
}

function jobState(job: ArticleKnowledgeBuildJobResponse | undefined, submitting: boolean): {
  label: string
  state: AgentState
} {
  if (submitting) {
    return { label: "正在提交", state: "waiting" }
  }
  if (!job) {
    return { label: "正在获取状态", state: "waiting" }
  }
  if (job.status === "pending") {
    return {
      label: job.progress.phase === "retrying" ? "等待重试" : "排队中",
      state: "waiting",
    }
  }
  if (job.status === "processing") {
    return { label: "构建中", state: "working" }
  }
  if (job.status === "failed") {
    return { label: "构建失败", state: "failed" }
  }
  if ((job.result?.warnings.length ?? 0) > 0) {
    return { label: "部分完成", state: "done" }
  }
  return { label: "已完成", state: "done" }
}

function ResultSummary({ job }: { job: ArticleKnowledgeBuildJobResponse }) {
  if (!job.result) return null
  const result = job.result
  const stats = [
    { label: "切片", value: result.chunkCount, Icon: FileText },
    { label: "推荐问题", value: result.recommendedQuestionCount, Icon: Sparkles },
    { label: "实体", value: result.entityCount, Icon: Network },
    { label: "概念", value: result.conceptCount, Icon: Brain },
    { label: "合并知识", value: result.mergedKnowledgeCount ?? 0, Icon: Combine },
    { label: "知识关系", value: result.relationCount ?? 0, Icon: GitForkIcon },
  ]
  return (
    <section className={cn(paper, "flex w-full flex-col gap-3 rounded-2xl p-4")}>
      <h3 className="text-[13.5px] font-medium">构建结果</h3>
      <div className="grid grid-cols-3 gap-2">
        {stats.map(({ label, value, Icon }) => (
          <div key={label} className={cn(field, "rounded-xl px-2 py-2.5 text-center")}>
            <div className="flex items-center justify-center gap-1 text-[11px] leading-4 text-foreground/45">
              <Icon className="size-3 shrink-0" aria-hidden />
              {label}
            </div>
            <div className="mt-1 text-base font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

export interface KnowledgeBuildProgressSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  articleName: string
  job?: ArticleKnowledgeBuildJobResponse
  submitting: boolean
  onRebuild: () => void
}

export function KnowledgeBuildProgressSheet({
  open,
  onOpenChange,
  articleName,
  job,
  submitting,
  onRebuild,
}: KnowledgeBuildProgressSheetProps) {
  const [eventsOpen, setEventsOpen] = React.useState(false)
  const [now, setNow] = React.useState(() => Date.now())
  const running = submitting || job?.status === "pending" || job?.status === "processing"

  React.useEffect(() => {
    if (!open || !running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [open, running])

  React.useEffect(() => {
    if (!open) setEventsOpen(false)
  }, [open])

  const stages = job?.progress.stages?.length ? job.progress.stages : job ? fallbackStages(job) : []
  const firstUnfinished = stages.findIndex((stage) => stage.status !== "completed")
  const stageIndex = firstUnfinished === -1 ? stages.length : firstUnfinished
  const percent = Math.min(100, Math.max(0, Math.round(job?.progress.percent ?? 0)))
  const stageProgress = stages.length
    ? clamp((percent / 100) * stages.length - stageIndex, 0, 1)
    : 0
  const failed = job?.status === "failed"
  const state = jobState(job, submitting)
  const startedAt = Date.parse(job?.startedAt ?? job?.createdAt ?? "")
  const terminal = job?.status === "completed" || failed
  const endedAt = terminal && job?.completedAt ? Date.parse(job.completedAt) : now
  const elapsed = Number.isFinite(startedAt) && Number.isFinite(endedAt)
    ? Math.max(0, endedAt - startedAt)
    : 0
  const heartbeatAt = Date.parse(job?.progress.heartbeatAt ?? "")
  const heartbeatStale = job?.status === "processing"
    && Number.isFinite(heartbeatAt)
    && now - heartbeatAt > 30_000
  const events = [...(job?.progress.events ?? [])].reverse()
  const agentActivities = job?.progress.agentActivities ?? []
  const warnings = job?.result?.warnings ?? []
  const currentStage = stages.find((stage) => stage.status === "running")
    ?? stages.find((stage) => stage.status === "failed")
  const children = currentStage?.children ?? []
  const planSteps: AgentPlanStep[] = children.map((child) => ({
    label: STAGE_LABELS[child.id] ?? child.id,
    status: planStepStatus(child.status),
    counter: stageCounter(child),
  }))
  const planDetails = children.map((child) => child.message)
  const timelineEvents: TimelineEvent[] = events.map((event) => ({
    id: event.id,
    when: "past",
    time: formatEventTime(event.createdAt),
    title: event.message,
  }))
  const jobTitle = submitting
    ? "正在提交知识构建任务"
    : job?.progress.message ?? "等待任务状态"
  const attempt = job?.progress.attempt
    ? `第 ${job.progress.attempt}/${job.progress.maxAttempts ?? job.progress.attempt} 次尝试`
    : undefined
  const progressCount = job?.progress.total
    ? `${job.progress.completed ?? 0}/${job.progress.total}`
    : undefined

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-[520px]">
        <SheetHeader className="border-b px-5 py-5 pr-12">
          <SheetTitle className="truncate text-base">{articleName || "知识构建详情"}</SheetTitle>
          <div className="flex flex-wrap items-center gap-2">
            <AgentStatus
              state={state.state}
              label={state.label}
              elapsed={terminal ? undefined : formatDuration(elapsed)}
            />
            {attempt ? (
              <span className="text-xs text-muted-foreground">{attempt}</span>
            ) : null}
          </div>
          <SheetDescription className="sr-only">
            {state.label}，已运行 {formatDuration(elapsed)}
            {attempt ? `，${attempt}` : ""}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 px-5 py-5">
            <section className="space-y-3" aria-label={`知识构建进度 ${percent}%`}>
              <JobProgress
                title={jobTitle}
                stages={JOB_STAGES}
                stageIndex={stageIndex}
                stageProgress={stageProgress}
                value={`${percent}%`}
                eta={progressCount}
                failed={failed}
                className="max-w-none"
              />
              {heartbeatStale ? (
                <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <AlertCircle className="size-3.5" aria-hidden />
                  超过 30 秒未收到 Worker 心跳，正在等待状态恢复
                </p>
              ) : null}
            </section>

            {planSteps.length > 0 ? (
              <AgentPlan
                title={STAGE_LABELS[currentStage?.id ?? ""] ?? "当前阶段"}
                steps={planSteps}
                details={planDetails}
                className="max-w-none"
              />
            ) : null}

            <KnowledgeBuildAgentActivity activities={agentActivities} />

            {job?.status === "completed" ? <ResultSummary job={job} /> : null}

            {warnings.length > 0 ? (
              <section className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-4">
                <h3 className="flex items-center gap-2 text-[13.5px] font-medium text-amber-800 dark:text-amber-300">
                  <AlertCircle className="size-4" aria-hidden />
                  构建警告
                </h3>
                <ul className="mt-2 space-y-1.5 text-xs leading-5 text-amber-800/90 dark:text-amber-200/90">
                  {warnings.map((warning) => <li key={warning}>• {warning}</li>)}
                </ul>
              </section>
            ) : null}

            {failed ? (
              <section className="rounded-2xl border border-destructive/25 bg-destructive/5 p-4 text-[13.5px] text-destructive">
                <div className="flex items-start gap-2">
                  <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <p>{job?.error || job?.progress.message || "知识构建失败，请稍后重试"}</p>
                </div>
              </section>
            ) : null}

            <Collapsible open={eventsOpen} onOpenChange={setEventsOpen}>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-between rounded-xl px-3 text-[13.5px] text-foreground/55 hover:text-foreground/90"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <History className="size-3.5" aria-hidden />
                    运行记录{timelineEvents.length ? `（${timelineEvents.length}）` : ""}
                  </span>
                  <ChevronDown
                    className={cn("size-4 transition-transform", eventsOpen && "rotate-180")}
                    aria-hidden
                  />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                {timelineEvents.length > 0 ? (
                  <Timeline
                    events={timelineEvents}
                    visibleCount={timelineEvents.length}
                    className="mt-2 max-w-none"
                  />
                ) : (
                  <p className="px-3 py-3 text-xs text-muted-foreground">暂无阶段事件</p>
                )}
              </CollapsibleContent>
            </Collapsible>
          </div>
        </ScrollArea>

        {job && terminal ? (
          <SheetFooter className="border-t px-5 py-4">
            <Button type="button" disabled={submitting} onClick={onRebuild}>
              {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
              {submitting ? "正在提交" : "重新构建"}
            </Button>
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
