"use client"

import * as React from "react"
import {
  makeAssistantDataUI,
  makeAssistantToolUI,
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
  Library,
  ListTree,
  Loader2,
  Pencil,
  Search,
  Sparkles,
} from "lucide-react"
import { toast } from "sonner"

import { QaPreparing } from "@/features/pages/knowledge/QaMarkdown"
import { CitationList } from "@/components/tool-ui/citation"
import { safeParseSerializableCitation } from "@/components/tool-ui/citation/schema"
import { DataTable } from "@/components/tool-ui/data-table"
import { safeParseSerializableDataTable } from "@/components/tool-ui/data-table/schema"
import { ApprovalCard } from "@/components/tool-ui/approval-card"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { knowledgeBaseArticleApi } from "@/lib/api"
import { knowledgeBaseArticlePath } from "@/lib/dashboard-routes"

import {
  asRecord,
  asRows,
  isPresent,
  parseLegacyDocumentHref,
  toInternalAppPath,
  toolStatusLabel,
} from "./assistant-message-utils"

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

  if (!confirmationId) {
    return <ToolStatusCard title="等待确认" status={status} />
  }

  return (
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

export const ListSystemOverviewToolUI = makeAssistantToolUI({
  toolName: "list_system_overview",
  render: ({ result, status }) => {
    const payload = asRecord(result)
    return (
      <ToolStatusCard title="系统概览" status={status} icon={<Gauge className="size-4" />}>
        {payload ? (
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
            <div>知识库 <span className="font-medium">{String(payload.knowledgeBases ?? 0)}</span></div>
            <div>文章 <span className="font-medium">{String(payload.articles ?? 0)}</span></div>
            <div>文档库 <span className="font-medium">{String(payload.docLibraries ?? 0)}</span></div>
            <div>文档 <span className="font-medium">{String(payload.documents ?? 0)}</span></div>
            <div>对话 <span className="font-medium">{String(payload.assistantThreads ?? 0)}</span></div>
            <div className="flex flex-wrap gap-1">
              <Badge variant={payload.chatModelReady ? "secondary" : "outline"} className="text-[10px]">CHAT {payload.chatModelReady ? "就绪" : "未配"}</Badge>
              <Badge variant={payload.embeddingModelReady ? "secondary" : "outline"} className="text-[10px]">EMBED {payload.embeddingModelReady ? "就绪" : "未配"}</Badge>
            </div>
          </div>
        ) : null}
      </ToolStatusCard>
    )
  },
})

export const ListKbToolUI = makeAssistantToolUI({
  toolName: "list_knowledge_bases",
  render: ({ result, status }) => {
    const rows = Array.isArray(result) ? result.map(asRecord).filter(isPresent) : asRows(result, "knowledgeBases")
    return (
      <ToolStatusCard title="我的知识库" status={status} icon={<Library className="size-4" />}>
        <div className="flex flex-wrap gap-1.5">
          {rows.slice(0, 12).map((row, index) => (
            <Badge key={String(row.id ?? index)} variant="secondary" className="font-normal">{String(row.name ?? "未命名")}</Badge>
          ))}
        </div>
      </ToolStatusCard>
    )
  },
})

export const ListDocLibrariesToolUI = makeAssistantToolUI({
  toolName: "list_doc_libraries",
  render: ({ result, status }) => {
    const rows = Array.isArray(result) ? result.map(asRecord).filter(isPresent) : asRows(result, "libraries")
    return (
      <ToolStatusCard title="我的文档库" status={status} icon={<Library className="size-4" />}>
        <div className="flex flex-wrap gap-1.5">
          {rows.slice(0, 12).map((row, index) => (
            <Badge key={String(row.id ?? index)} variant="secondary" className="font-normal">{String(row.name ?? "未命名")}</Badge>
          ))}
        </div>
      </ToolStatusCard>
    )
  },
})

export const ReadKnowledgeToolUI = makeAssistantToolUI({
  toolName: "read_knowledge_node",
  render: ({ result, status }) => {
    const payload = asRecord(result)
    const title = typeof payload?.title === "string" ? payload.title : "知识节点"
    const kind = typeof payload?.kind === "string" ? payload.kind : null
    return (
      <ToolStatusCard title="阅读知识" status={status} icon={<FileText className="size-4" />}>
        <div className="flex items-center justify-between gap-2">
          <span className="line-clamp-2 text-sm font-medium">{title}</span>
          {kind ? <Badge variant="outline" className="text-[10px]">{kind}</Badge> : null}
        </div>
      </ToolStatusCard>
    )
  },
})

export const ReadDocumentToolUI = makeAssistantToolUI({
  toolName: "read_document",
  render: ({ result, status }) => {
    const payload = asRecord(result)
    const title = typeof payload?.title === "string" ? payload.title : typeof payload?.fileName === "string" ? payload.fileName : "文档"
    const locator = payload?.locator ?? payload?.fromIndex
    return (
      <ToolStatusCard title="阅读文档" status={status} icon={<FileText className="size-4" />}>
        <div className="flex items-center justify-between gap-2">
          <span className="line-clamp-2 text-sm font-medium">{title}</span>
          {locator != null ? <Badge variant="outline" className="text-[10px]">{String(locator)}</Badge> : null}
        </div>
      </ToolStatusCard>
    )
  },
})

export const SaveArtifactToolUI = makeAssistantToolUI({
  toolName: "save_answer_artifact",
  render: ({ result, status }) => {
    const payload = asRecord(result)
    const title = typeof payload?.title === "string" ? payload.title : "回答产物"
    const type = typeof payload?.kind === "string" ? payload.kind : typeof payload?.artifactType === "string" ? payload.artifactType : "artifact"
    return (
      <ToolStatusCard title="产物已保存" status={status} icon={<Sparkles className="size-4" />}>
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate text-sm font-medium">{title}</span>
          <Badge variant="outline">{type}</Badge>
        </div>
      </ToolStatusCard>
    )
  },
})

export const SpawnResearchSubagentToolUI = makeAssistantToolUI({
  toolName: "spawn_research_subagent",
  render: ({ args, result, status }) => {
    const input = asRecord(args)
    const payload = asRecord(result)
    const goal = typeof input?.goal === "string" ? input.goal : "深度检索"
    const ok = payload?.ok === true
    const summary = typeof payload?.summary === "string" ? payload.summary : ""
    const usage = asRecord(payload?.usage)
    return (
      <ToolStatusCard
        title={`子检索：${goal}`}
        status={status}
        icon={<Search className="size-4" />}
        collapsible
        defaultOpen={false}
      >
        {usage ? (
          <p className="mb-2 text-[11px] text-muted-foreground">
            {typeof usage.calls === "number" ? `${usage.calls} 次工具` : null}
            {typeof usage.totalTokens === "number" ? ` · ${usage.totalTokens} tok` : null}
            {ok === false ? " · 未完成" : null}
          </p>
        ) : null}
        {summary ? <p className="line-clamp-4 text-sm text-muted-foreground">{summary}</p> : null}
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
    return (
      <ToolStatusCard
        title={`写子代理：${goal}`}
        status={status}
        icon={<Pencil className="size-4" />}
        collapsible
        defaultOpen={false}
      >
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
    return (
      <ToolStatusCard
        title={`并行子检索：${tasks.length || results.length || "?"} 路`}
        status={status}
        icon={<ListTree className="size-4" />}
        collapsible
        defaultOpen={false}
      >
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
  doc_library: "文档库",
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
