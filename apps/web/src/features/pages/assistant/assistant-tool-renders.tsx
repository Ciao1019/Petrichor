"use client"

import * as React from "react"
import {
  makeAssistantDataUI,
  makeAssistantToolUI,
  ComposerPrimitive,
  useAuiState,
  type ToolCallMessagePartStatus,
} from "@assistant-ui/react"
import { useNavigate } from "react-router-dom"
import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Compass,
  FileText,
  Gauge,
  ListTree,
  Loader2,
  Pencil,
  Search,
  Square,
} from "lucide-react"
import { toast } from "sonner"

import { QaPreparing } from "@/features/pages/knowledge/QaMarkdown"
import { CitationList } from "@/components/tool-ui/citation"
import { safeParseSerializableCitation } from "@/components/tool-ui/citation/schema"
import { DataTable } from "@/components/tool-ui/data-table"
import { safeParseSerializableDataTable } from "@/components/tool-ui/data-table/schema"
import { ApprovalCard } from "@/components/tool-ui/approval-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { knowledgeBaseArticleApi } from "@/lib/api"
import { knowledgeBaseArticlePath } from "@/lib/dashboard-routes"

import {
  asRecord,
  isPresent,
  parseLegacyDocumentHref,
  toInternalAppPath,
  toolStatusLabel,
} from "./assistant-message-utils"
import { ProcessToolGroup } from "./process-tool-group"

const SUBAGENT_BUDGET_LABEL = "最多 6 步 · 超时 90s"
const FANOUT_BUDGET_LABEL = "最多 3 路并行 · 每路 6 步 / 90s"

function isSpawnRunning(status?: ToolCallMessagePartStatus) {
  return status?.type === "running" || status?.type === "incomplete"
}

function SpawnBudgetBar({
  label,
  status,
  errorCode,
}: {
  label: string
  status?: ToolCallMessagePartStatus
  errorCode?: string | null
}) {
  const running = isSpawnRunning(status)
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <Gauge className="size-3 opacity-70" aria-hidden />
        {running ? `进行中 · ${label}` : label}
        {errorCode === "aborted" ? " · 已取消" : null}
        {errorCode === "tool_timeout" ? " · 已超时" : null}
      </span>
      {running ? (
        <ComposerPrimitive.Cancel asChild>
          <Button type="button" size="sm" variant="outline" className="h-7 gap-1 px-2 text-[11px]">
            <Square className="size-3 fill-current" />
            停止
          </Button>
        </ComposerPrimitive.Cancel>
      ) : null}
    </div>
  )
}

function SubagentStepsList({ steps }: { steps: unknown }) {
  if (!Array.isArray(steps) || steps.length === 0) return null
  return (
    <Collapsible className="mb-2 rounded-md border border-border/50 bg-muted/20 px-2 py-1.5">
      <CollapsibleTrigger className="group/steps flex w-full items-center gap-1 text-[11px] text-muted-foreground">
        <ChevronDown className="size-3 transition-transform group-data-[state=closed]/steps:-rotate-90" />
        子步骤 · {steps.length}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 space-y-0.5 data-[state=closed]:hidden">
        {steps.map((item, index) => {
          const row = asRecord(item)
          const name = typeof row?.toolName === "string" ? row.toolName : `step-${index + 1}`
          const ok = row?.ok !== false
          const errorCode = typeof row?.errorCode === "string" ? row.errorCode : null
          return (
            <div key={`${name}-${index}`} className="flex items-center gap-1.5 text-[11px]">
              {ok
                ? <CheckCircle2 className="size-3 shrink-0 text-emerald-600/80" />
                : <CircleAlert className="size-3 shrink-0 text-amber-600/80" />}
              <span className="truncate font-mono">{name}</span>
              {errorCode ? <span className="text-muted-foreground">· {errorCode}</span> : null}
            </div>
          )
        })}
      </CollapsibleContent>
    </Collapsible>
  )
}

export const PlanToolUI = makeAssistantToolUI({
  toolName: "upsert_plan",
  // 进度改由右侧 AssistantTaskRail 展示，消息流内不再渲染大卡
  render: () => null,
})

export const ProgressToolUI = makeAssistantToolUI({
  toolName: "show_progress",
  render: () => null,
})

export const ConfirmationToolUI = makeAssistantToolUI({
  toolName: "request_user_confirmation",
  render: (props) => <ConfirmationToolRender {...props} />,
})

function ConfirmationToolRender({
  args,
  result,
  status,
  addResult,
}: {
  args: unknown
  result?: unknown
  status?: ToolCallMessagePartStatus
  addResult: (result: unknown) => void
}) {
  const payload = asRecord(result) ?? asRecord(args)
  const confirmationId = typeof payload?.id === "string" ? payload.id : null
  const title = typeof payload?.title === "string" ? payload.title : "请确认操作"
  const description = typeof payload?.description === "string" ? payload.description : undefined
  const confirmLabel = typeof payload?.confirmLabel === "string" ? payload.confirmLabel : "确认"
  const cancelLabel = typeof payload?.cancelLabel === "string" ? payload.cancelLabel : "取消"
  const variant = payload?.variant === "destructive" ? "destructive" : "default"
  const decision = asRecord(result)
  const confirmed = typeof decision?.confirmed === "boolean" ? decision.confirmed : null
  const choice = confirmed === true ? "approved" as const : confirmed === false ? "denied" as const : undefined
  const action = asRecord(payload?.action)
  const actionToolName = typeof action?.toolName === "string" ? action.toolName : ""
  // critical 工具不提供会话放行按钮（与服务端 DESTRUCTIVE_CRITICAL 对齐）
  const canAllowForThread = Boolean(actionToolName)
    && !/^(delete_|revoke_|set_public_qa_enabled)/.test(actionToolName)

  if (!confirmationId) {
    return <ToolStatusCard title="等待确认" status={status} />
  }

  return (
    <div className="space-y-2">
      <ApprovalCard
        id={confirmationId}
        title={title}
        description={description}
        variant={variant}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        choice={choice}
        onConfirm={() => {
          if (choice != null) return
          addResult({ confirmed: true, confirmationId })
        }}
        onCancel={() => {
          if (choice != null) return
          addResult({ confirmed: false, confirmationId, cancelled: true })
        }}
      />
      {choice == null && canAllowForThread ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={() => {
            addResult({ confirmed: true, confirmationId, allowForThread: true })
          }}
        >
          本会话允许同类操作
        </Button>
      ) : null}
      {decision?.allowForThread === true ? (
        <p className="text-[11px] text-muted-foreground">已为本会话放行该工具（非破坏性删除类）</p>
      ) : null}
    </div>
  )
}

export const CitationToolUI = makeAssistantToolUI({
  toolName: "show_citations",
  render: ({ result, args, status }) => (
    <CitationToolRender result={result} args={args} status={status} />
  ),
})

function CitationToolRender({ result, args, status }: { result: unknown; args: unknown; status?: ToolCallMessagePartStatus }) {
  const navigate = useNavigate()
  const payload = asRecord(result ?? args)
  const citations = Array.isArray(payload?.citations)
    ? payload.citations.map((item) => safeParseSerializableCitation(item)).filter(isPresent)
    : []
  const handleNavigate = React.useCallback(async (href: string) => {
    const legacyDocumentId = parseLegacyDocumentHref(href)
    if (legacyDocumentId) {
      try {
        const res = await knowledgeBaseArticleApi.detail(legacyDocumentId)
        navigate(knowledgeBaseArticlePath(res.data.knowledgeBaseId, res.data.articleId))
      } catch {
        toast.error("无法打开引用文档")
      }
      return
    }
    const internalPath = toInternalAppPath(href)
    if (internalPath) {
      navigate(internalPath)
      return
    }
    if (typeof window !== "undefined") {
      window.open(href, "_blank", "noopener,noreferrer")
    }
  }, [navigate])
  if (citations.length === 0) {
    return <ToolStatusCard title="引用来源" status={status} />
  }
  return (
    <CitationList
      id={String(payload?.id ?? "citations")}
      citations={citations}
      variant={payload?.variant === "inline" || payload?.variant === "stacked" ? payload.variant : "default"}
      onNavigate={handleNavigate}
    />
  )
}

export const DataTableToolUI = makeAssistantToolUI({
  toolName: "show_data_table",
  render: ({ result, args, status }) => {
    const payload = asRecord(result ?? args)
    const parsed = safeParseSerializableDataTable(payload)
    if (!parsed) return <ToolStatusCard title="结构化表格" status={status} />
    return (
      <div className="space-y-2">
        {typeof payload?.title === "string" && payload.title ? (
          <p className="text-sm font-medium">{payload.title}</p>
        ) : null}
        <DataTable {...parsed} />
      </div>
    )
  },
})

/* 以下 6 个「过程类」工具统一走 ProcessToolGroup：合并成一段单行过程日志，
   由该组首条调用渲染全部，其余返回 null（外层 empty:hidden 兜住空 div）。 */
export const ListSystemOverviewToolUI = makeAssistantToolUI({
  toolName: "list_system_overview",
  render: ({ toolCallId }) => <ProcessToolGroup toolCallId={toolCallId} />,
})

export const ListKbToolUI = makeAssistantToolUI({
  toolName: "list_knowledge_bases",
  render: ({ toolCallId }) => <ProcessToolGroup toolCallId={toolCallId} />,
})

export const ReadKnowledgeToolUI = makeAssistantToolUI({
  toolName: "read_knowledge_node",
  render: ({ toolCallId }) => <ProcessToolGroup toolCallId={toolCallId} />,
})

export const SaveArtifactToolUI = makeAssistantToolUI({
  toolName: "save_answer_artifact",
  render: ({ toolCallId }) => <ProcessToolGroup toolCallId={toolCallId} />,
})

export const PreviewArticleUpdateToolUI = makeAssistantToolUI({
  toolName: "preview_article_update",
  render: ({ result, status }) => {
    const payload = asRecord(result)
    if (!payload) return <ToolStatusCard title="文章更新预览" status={status} />
    const title = asRecord(payload.title)
    const diff = typeof payload.contentDiff === "string" ? payload.contentDiff : null
    return (
      <ToolStatusCard
        title="文章更新预览（未落库）"
        status={status}
        icon={<FileText className="size-4" />}
        collapsible
        defaultOpen
      >
        {title?.changed === true ? (
          <p className="mb-2 text-xs text-muted-foreground">
            标题：<span className="line-through opacity-70">{String(title.before ?? "")}</span>
            {" → "}
            <span className="font-medium text-foreground">{String(title.after ?? "")}</span>
          </p>
        ) : null}
        {diff ? (
          <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {diff}
          </pre>
        ) : (
          <p className="text-xs text-muted-foreground">
            {typeof payload.message === "string" ? payload.message : "无正文变更"}
          </p>
        )}
      </ToolStatusCard>
    )
  },
})

function SpawnCitationsBlock({ citations }: { citations: unknown }) {
  const navigate = useNavigate()
  const parsed = Array.isArray(citations)
    ? citations.map((item) => safeParseSerializableCitation(item)).filter(isPresent)
    : []
  const handleNavigate = React.useCallback(async (href: string) => {
    const legacyDocumentId = parseLegacyDocumentHref(href)
    if (legacyDocumentId) {
      try {
        const res = await knowledgeBaseArticleApi.detail(legacyDocumentId)
        navigate(knowledgeBaseArticlePath(res.data.knowledgeBaseId, res.data.articleId))
      } catch {
        toast.error("无法打开引用文档")
      }
      return
    }
    const internalPath = toInternalAppPath(href)
    if (internalPath) {
      navigate(internalPath)
      return
    }
    if (typeof window !== "undefined") {
      window.open(href, "_blank", "noopener,noreferrer")
    }
  }, [navigate])
  if (parsed.length === 0) return null
  return (
    <div className="mt-2">
      <CitationList
        id="spawn-citations"
        citations={parsed}
        variant="stacked"
        onNavigate={handleNavigate}
      />
    </div>
  )
}

export const SpawnResearchSubagentToolUI = makeAssistantToolUI({
  toolName: "spawn_research_subagent",
  render: ({ args, result, status }) => {
    const input = asRecord(args)
    const payload = asRecord(result)
    const goal = typeof input?.goal === "string" ? input.goal : "深度检索"
    const ok = payload?.ok === true
    const summary = typeof payload?.summary === "string" ? payload.summary : ""
    const usage = asRecord(payload?.usage)
    const errorCode = typeof payload?.errorCode === "string" ? payload.errorCode : null
    return (
      <ToolStatusCard
        title={`子检索：${goal}`}
        status={status}
        icon={<Search className="size-4" />}
        collapsible
        defaultOpen={isSpawnRunning(status) || errorCode === "aborted"}
      >
        <SpawnBudgetBar label={SUBAGENT_BUDGET_LABEL} status={status} errorCode={errorCode} />
        <SubagentStepsList steps={payload?.steps} />
        {usage ? (
          <p className="mb-2 text-[11px] text-muted-foreground">
            {typeof usage.calls === "number" ? `${usage.calls} 次工具` : null}
            {typeof usage.totalTokens === "number" ? ` · ${usage.totalTokens} tok` : null}
            {ok === false && errorCode !== "aborted" ? " · 未完成" : null}
          </p>
        ) : null}
        {summary ? <p className="line-clamp-4 text-sm text-muted-foreground">{summary}</p> : null}
        <SpawnCitationsBlock citations={payload?.citations} />
      </ToolStatusCard>
    )
  },
})

export const SpawnWriteSubagentToolUI = makeAssistantToolUI({
  toolName: "spawn_write_subagent",
  render: ({ args, result, status }) => {
    const input = asRecord(args)
    const payload = asRecord(result)
    const goal = typeof input?.goal === "string" ? input.goal : "写入规划"
    const summary = typeof payload?.summary === "string" ? payload.summary : ""
    const actions = Array.isArray(payload?.proposedActions) ? payload.proposedActions : []
    const errorCode = typeof payload?.errorCode === "string" ? payload.errorCode : null
    return (
      <ToolStatusCard
        title={`写子代理：${goal}`}
        status={status}
        icon={<Pencil className="size-4" />}
        collapsible
        defaultOpen={isSpawnRunning(status) || errorCode === "aborted"}
      >
        <SpawnBudgetBar label={SUBAGENT_BUDGET_LABEL} status={status} errorCode={errorCode} />
        <SubagentStepsList steps={payload?.steps} />
        {actions.length > 0 ? (
          <p className="mb-2 text-[11px] text-muted-foreground">{actions.length} 条提案</p>
        ) : null}
        {summary ? <p className="line-clamp-4 text-sm text-muted-foreground">{summary}</p> : null}
      </ToolStatusCard>
    )
  },
})

export const SpawnResearchFanoutToolUI = makeAssistantToolUI({
  toolName: "spawn_research_fanout",
  render: ({ args, result, status }) => {
    const input = asRecord(args)
    const payload = asRecord(result)
    const tasks = Array.isArray(input?.tasks) ? input.tasks : []
    const results = Array.isArray(payload?.results) ? payload.results : []
    const usage = asRecord(payload?.usage)
    const errorCode = typeof payload?.errorCode === "string" ? payload.errorCode : null
    const mergedCitations = results.flatMap((item) => {
      const row = asRecord(item)
      return Array.isArray(row?.citations) ? row.citations : []
    })
    return (
      <ToolStatusCard
        title={`并行子检索：${tasks.length || results.length || "?"} 路`}
        status={status}
        icon={<ListTree className="size-4" />}
        collapsible
        defaultOpen={isSpawnRunning(status) || errorCode === "aborted"}
      >
        <SpawnBudgetBar label={FANOUT_BUDGET_LABEL} status={status} errorCode={errorCode} />
        {results.length > 0 ? (
          <div className="mb-2 space-y-2">
            {results.map((item, index) => {
              const row = asRecord(item)
              const goal = typeof asRecord(tasks[index])?.goal === "string"
                ? String(asRecord(tasks[index])?.goal)
                : `第 ${index + 1} 路`
              return (
                <div key={index} className="rounded-md border border-border/40 px-2 py-1.5">
                  <p className="mb-1 truncate text-[11px] font-medium">{goal}</p>
                  <SubagentStepsList steps={row?.steps} />
                  {typeof row?.summary === "string" ? (
                    <p className="line-clamp-2 text-[11px] text-muted-foreground">{row.summary}</p>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : null}
        {usage ? (
          <p className="mb-2 text-[11px] text-muted-foreground">
            {typeof usage.succeeded === "number" && typeof usage.tasks === "number"
              ? `${usage.succeeded}/${usage.tasks} 成功`
              : null}
            {typeof usage.totalTokens === "number" ? ` · ${usage.totalTokens} tok` : null}
          </p>
        ) : null}
        <ul className="space-y-1 text-sm text-muted-foreground">
          {results.slice(0, 3).map((item, index) => {
            const row = asRecord(item)
            const summary = typeof row?.summary === "string" ? row.summary : ""
            return (
              <li key={index} className="line-clamp-2">
                {index + 1}. {summary || (row?.ok === false ? "失败" : "…")}
              </li>
            )
          })}
        </ul>
        <SpawnCitationsBlock citations={mergedCitations} />
      </ToolStatusCard>
    )
  },
})

/** 服务端 data-context-compress → assistant-ui DataMessagePart name=context-compress */
export const ContextCompressDataUI = makeAssistantDataUI({
  name: "context-compress",
  render: ({ data }) => {
    const payload = asRecord(data)
    if (payload?.status !== "running") return null
    const label = typeof payload.label === "string" && payload.label.trim()
      ? payload.label.trim()
      : "正在整理对话上下文…"
    return <QaPreparing label={label} />
  },
})

const INTENT_DOMAIN_LABELS: Record<string, string> = {
  knowledge: "知识库",
  system: "系统",
  content_write: "内容写入",
  admin: "管理",
}

function IntentRouteChips({ data }: { data: unknown }) {
  // 同一条消息若出现多条 intent-route（流式 id 未合并 / 历史脏数据），只展示最后一条
  const isLastIntentPart = useAuiState((s) => {
    if (s.part.type !== "data" || !("name" in s.part) || s.part.name !== "intent-route") return true
    let lastIndex = -1
    for (let index = 0; index < s.message.parts.length; index += 1) {
      const part = s.message.parts[index]
      if (part.type === "data" && "name" in part && part.name === "intent-route") lastIndex = index
    }
    if (lastIndex < 0) return true
    const myIndex = s.message.parts.indexOf(s.part)
    return myIndex < 0 ? false : myIndex === lastIndex
  })

  const payload = asRecord(data)
  if (!isLastIntentPart || !payload) return null
  if (payload.status === "running") {
    const label = typeof payload.label === "string" && payload.label.trim()
      ? payload.label.trim()
      : "正在识别意图…"
    return <QaPreparing label={label} />
  }
  if (payload.status !== "done") return null

  const domains = Array.isArray(payload.domains)
    ? payload.domains.filter((d): d is string => typeof d === "string")
    : []
  const fallbackLabel = typeof payload.label === "string" ? payload.label.trim() : ""
  // 来源 / 置信度 / rationale 仅供审计，不对用户展示
  if (domains.length === 0 && !fallbackLabel) return null

  return (
    <div
      className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
      role="status"
      aria-label={fallbackLabel || "意图路由"}
    >
      <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 font-medium text-foreground/80">
        <Compass className="size-3 opacity-70" aria-hidden />
        意图
      </span>
      {domains.length > 0 ? domains.map((domain) => (
        <span
          key={domain}
          className="rounded-md border border-border/50 bg-background/80 px-1.5 py-0.5 text-foreground/75"
        >
          {INTENT_DOMAIN_LABELS[domain] ?? domain}
        </span>
      )) : (
        <span className="text-foreground/75">{fallbackLabel}</span>
      )}
    </div>
  )
}

/** 服务端 data-intent-route → 常驻意图芯片（done 落库保留，刷新仍可见） */
export const IntentRouteDataUI = makeAssistantDataUI({
  name: "intent-route",
  render: IntentRouteChips,
})

/** 服务端 data-step-budget → 步数将尽 / 已用尽提示 */
export const StepBudgetDataUI = makeAssistantDataUI({
  name: "step-budget",
  render: ({ data }) => {
    const payload = asRecord(data)
    if (!payload) return null
    const status = payload.status
    if (status !== "warning" && status !== "exhausted") return null
    const label = typeof payload.label === "string" && payload.label.trim()
      ? payload.label.trim()
      : status === "exhausted"
        ? "本轮步数已用尽，可继续发消息接着做"
        : "本轮步数将尽"
    return (
      <div
        className="mb-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-xs text-amber-950/80 dark:text-amber-100/90"
        role="status"
      >
        <Gauge className="mt-0.5 size-3.5 shrink-0 opacity-80" aria-hidden />
        <span>{label}</span>
      </div>
    )
  },
})

export function ToolStatusCard({
  title,
  status,
  icon,
  children,
  collapsible = false,
  defaultOpen = true,
}: {
  title: string
  status?: ToolCallMessagePartStatus
  icon?: React.ReactNode
  children?: React.ReactNode
  collapsible?: boolean
  defaultOpen?: boolean
}) {
  const running = status?.type === "running"
  const incomplete = status?.type === "incomplete"
  const iconEl = (
    <span className="text-muted-foreground">
      {running ? <Loader2 className="size-4 animate-spin" /> : incomplete ? <CircleAlert className="size-4" /> : icon ?? <CheckCircle2 className="size-4" />}
    </span>
  )
  const badge = <Badge variant="outline" className="ml-auto text-[10px]">{toolStatusLabel(status)}</Badge>

  if (collapsible && children) {
    return (
      <Collapsible defaultOpen={defaultOpen} className="rounded-xl border bg-background/60 p-3 shadow-sm backdrop-blur-sm">
        <CollapsibleTrigger className="group/tsc flex w-full items-center gap-2 text-sm font-medium">
          {iconEl}
          <span>{title}</span>
          {badge}
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=closed]/tsc:-rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 data-[state=closed]:hidden">{children}</CollapsibleContent>
      </Collapsible>
    )
  }

  return (
    <div className="rounded-xl border bg-background/60 p-3 shadow-sm backdrop-blur-sm">
      <div className="flex items-center gap-2 text-sm font-medium">
        {iconEl}
        <span>{title}</span>
        {badge}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  )
}

export function EmptyHint({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-dashed border-border/60 bg-background/40 px-3 py-5 text-center text-xs text-muted-foreground">
      {message}
    </div>
  )
}

export function LoadingRows({ count }: { count: number }) {
  return (
    <div className="space-y-1.5">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="h-10 animate-pulse rounded-md bg-muted/40" />
      ))}
    </div>
  )
}
