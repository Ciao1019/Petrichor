"use client"

import * as React from "react"
import { makeAssistantToolUI, type ToolCallMessagePartStatus } from "@assistant-ui/react"
import { useNavigate } from "react-router-dom"
import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  FileText,
  Library,
  ListTree,
  Loader2,
  Network,
  Search,
} from "@/components/iconimate"

import { GraphRetrievalBody, parseGraphRetrievalResult } from "@/components/site-graph/GraphPathChain"
import { CitationList } from "@/components/tool-ui/citation"
import { safeParseSerializableCitation } from "@/components/tool-ui/citation/schema"
import { DataTable } from "@/components/tool-ui/data-table"
import { safeParseSerializableDataTable } from "@/components/tool-ui/data-table/schema"
import { Plan } from "@/components/tool-ui/plan"
import { safeParseSerializablePlan } from "@/components/tool-ui/plan/schema"
import { ProgressTracker } from "@/components/tool-ui/progress-tracker"
import { safeParseSerializableProgressTracker } from "@/components/tool-ui/progress-tracker/schema"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value != null
}

function toolStatusLabel(status?: ToolCallMessagePartStatus) {
  if (status?.type === "running") return "运行中"
  if (status?.type === "incomplete") return "未完成"
  if (status?.type === "requires-action") return "待操作"
  return "完成"
}

function isInternalAppPath(href: string) {
  if (!href) return false
  if (href.startsWith("/")) return true
  if (typeof window === "undefined") return false
  try {
    const url = new URL(href, window.location.origin)
    return url.origin === window.location.origin
  } catch {
    return false
  }
}

function ToolStatusCard({
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
    <span className="text-white/60">
      {running ? (
        <Loader2 className="size-4 animate-spin" />
      ) : incomplete ? (
        <CircleAlert className="size-4" />
      ) : (
        icon ?? <CheckCircle2 className="size-4" />
      )}
    </span>
  )
  const badge = <Badge variant="outline" className="ml-auto border-white/20 text-[10px] text-white/70">{toolStatusLabel(status)}</Badge>

  if (collapsible && children) {
    return (
      <Collapsible defaultOpen={defaultOpen} className="rounded-xl border border-white/10 bg-white/5 p-3 shadow-sm backdrop-blur-sm">
        <CollapsibleTrigger className="group/tsc flex w-full items-center gap-2 text-sm font-medium text-white">
          {iconEl}
          <span>{title}</span>
          {badge}
          <ChevronDown className="size-4 shrink-0 text-white/50 transition-transform duration-200 group-data-[state=closed]/tsc:-rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 data-[state=closed]:hidden">{children}</CollapsibleContent>
      </Collapsible>
    )
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3 shadow-sm backdrop-blur-sm">
      <div className="flex items-center gap-2 text-sm font-medium text-white">
        {iconEl}
        <span>{title}</span>
        {badge}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  )
}

const PlanToolUI = makeAssistantToolUI({
  toolName: "show_agent_plan",
  render: ({ result, args, status }) => {
    const parsed = safeParseSerializablePlan(result ?? args)
    if (!parsed) return <ToolStatusCard title="执行计划" status={status} />
    return <Plan {...parsed} />
  },
})

const ProgressToolUI = makeAssistantToolUI({
  toolName: "show_progress",
  render: ({ result, args, status }) => {
    const parsed = safeParseSerializableProgressTracker(result ?? args)
    if (!parsed) return <ToolStatusCard title="执行进度" status={status} />
    return <ProgressTracker {...parsed} />
  },
})

function CitationToolRender({ result, args, status }: { result: unknown; args: unknown; status?: ToolCallMessagePartStatus }) {
  const navigate = useNavigate()
  const payload = asRecord(result ?? args)
  const citations = Array.isArray(payload?.citations)
    ? payload.citations.map((item) => safeParseSerializableCitation(item)).filter(isPresent)
    : []
  const handleNavigate = React.useCallback((href: string) => {
    if (isInternalAppPath(href)) {
      navigate(href)
      return
    }
    if (typeof window !== "undefined") {
      window.open(href, "_blank", "noopener,noreferrer")
    }
  }, [navigate])
  if (citations.length === 0) return <ToolStatusCard title="引用来源" status={status} />
  return (
    <CitationList
      id={String(payload?.id ?? "citations")}
      citations={citations}
      variant={payload?.variant === "inline" || payload?.variant === "stacked" ? payload.variant : "default"}
      onNavigate={handleNavigate}
    />
  )
}

const CitationToolUI = makeAssistantToolUI({
  toolName: "show_citations",
  render: ({ result, args, status }) => <CitationToolRender result={result} args={args} status={status} />,
})

const DataTableToolUI = makeAssistantToolUI({
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

function SearchArticlesRender({
  result,
  status,
  title = "检索公开文章",
  icon = <Search className="size-4" />,
}: {
  result: unknown
  status?: ToolCallMessagePartStatus
  title?: string
  icon?: React.ReactNode
}) {
  const navigate = useNavigate()
  const payload = asRecord(result)
  const rows = Array.isArray(payload?.items) ? payload.items.map(asRecord).filter(isPresent) : []
  const total = typeof payload?.total === "number" ? payload.total : rows.length
  if (rows.length === 0) {
    return <ToolStatusCard title={title} status={status} icon={icon} />
  }
  return (
    <ToolStatusCard
      title={total > rows.length ? `${title}（${rows.length}/${total}）` : title}
      status={status}
      icon={icon}
      collapsible
      defaultOpen={false}
    >
      <div className="space-y-1.5">
        {rows.slice(0, 12).map((row, index) => {
          const href = typeof row.href === "string" ? row.href : ""
          const articleTitle = String(row.title ?? "公开文章")
          const snippet = typeof row.snippet === "string" ? row.snippet : ""
          return (
            <button
              key={String(row.articleId ?? index)}
              type="button"
              onClick={() => href && navigate(href)}
              className="block w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-left text-white transition-colors hover:bg-white/10 disabled:cursor-default"
              disabled={!href}
            >
              <span className="line-clamp-1 text-sm font-medium">{articleTitle}</span>
              {snippet ? <p className="mt-1 line-clamp-2 text-xs text-white/60">{snippet}</p> : null}
            </button>
          )
        })}
      </div>
    </ToolStatusCard>
  )
}

const ListArticlesToolUI = makeAssistantToolUI({
  toolName: "list_public_articles",
  render: ({ result, status }) => (
    <SearchArticlesRender
      result={result}
      status={status}
      title="公开文章列表"
      icon={<Library className="size-4" />}
    />
  ),
})

const SearchArticlesToolUI = makeAssistantToolUI({
  toolName: "search_public_articles",
  render: ({ result, status }) => <SearchArticlesRender result={result} status={status} />,
})

const SearchTreeToolUI = makeAssistantToolUI({
  toolName: "search_document_tree",
  render: ({ result, status }) => {
    const rows = Array.isArray(result) ? result.map(asRecord).filter(isPresent) : []
    if (rows.length === 0) {
      return <ToolStatusCard title="推理式检索" status={status} icon={<ListTree className="size-4" />} />
    }
    return (
      <ToolStatusCard title="推理式检索" status={status} icon={<ListTree className="size-4" />} collapsible defaultOpen={false}>
        <div className="space-y-1.5">
          {rows.slice(0, 8).map((row, index) => {
            const path = typeof row.path === "string" ? row.path : ""
            const title = String(row.title ?? row.nodeKey ?? "章节")
            const summary = typeof row.summary === "string" ? row.summary : ""
            const reason = typeof row.reason === "string" ? row.reason : ""
            return (
              <div key={String(row.nodeKey ?? index)} className="rounded-md border border-white/10 bg-white/5 px-3 py-2">
                {path ? <p className="truncate text-[10px] text-white/60">{path}</p> : null}
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{title}</span>
                  {typeof row.depth === "number" ? (
                    <Badge variant="outline" className="shrink-0 text-[10px]">L{row.depth}</Badge>
                  ) : null}
                </div>
                {summary ? <p className="mt-1 line-clamp-2 text-xs text-white/60">{summary}</p> : null}
                {reason ? <p className="mt-1 line-clamp-1 text-[11px] text-yellow-300">命中理由：{reason}</p> : null}
              </div>
            )
          })}
        </div>
      </ToolStatusCard>
    )
  },
})

const SearchGraphToolUI = makeAssistantToolUI({
  toolName: "search_knowledge_graph",
  render: ({ result, status }) => {
    const { matched, paths, graphNodes, graphLinks, emptyMessage } = parseGraphRetrievalResult(result)

    if (paths.length === 0 && matched.length === 0) {
      return (
        <ToolStatusCard title="星图检索" status={status} icon={<Network className="size-4" />}>
          {emptyMessage ? <p className="text-xs text-white/60">{emptyMessage}</p> : null}
        </ToolStatusCard>
      )
    }

    return (
      <ToolStatusCard title="星图检索" status={status} icon={<Network className="size-4" />} collapsible defaultOpen={false}>
        <GraphRetrievalBody
          matched={matched}
          paths={paths}
          graphNodes={graphNodes}
          graphLinks={graphLinks}
          onNavigate={(route) => window.location.assign(route)}
        />
      </ToolStatusCard>
    )
  },
})

const ReadTreeNodeToolUI = makeAssistantToolUI({
  toolName: "read_tree_node",
  render: ({ result, status }) => {
    const payload = asRecord(result)
    const title = typeof payload?.title === "string" ? payload.title : "目录节点"
    const path = typeof payload?.path === "string" ? payload.path : ""
    return (
      <ToolStatusCard title="读取目录节点" status={status} icon={<FileText className="size-4" />}>
        <div className="min-w-0">
          {path ? <p className="truncate text-[10px] text-white/60">{path}</p> : null}
          <span className="line-clamp-2 text-sm font-medium">{title}</span>
        </div>
      </ToolStatusCard>
    )
  },
})

const ReadWikiToolUI = makeAssistantToolUI({
  toolName: "read_wiki_page",
  render: ({ result, status }) => {
    const payload = asRecord(result)
    const title = typeof payload?.title === "string" ? payload.title : "Wiki 页面"
    const pageKey = typeof payload?.pageKey === "string" ? payload.pageKey : ""
    return (
      <ToolStatusCard title="读取 Wiki 页面" status={status} icon={<FileText className="size-4" />}>
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate text-sm font-medium">{title}</span>
          {pageKey ? <Badge variant="outline" className="text-[10px]">{pageKey}</Badge> : null}
        </div>
      </ToolStatusCard>
    )
  },
})

function ReadSourceRender({ result, status }: { result: unknown; status?: ToolCallMessagePartStatus }) {
  const navigate = useNavigate()
  const payload = asRecord(result)
  const title = typeof payload?.title === "string" ? payload.title : "源文档"
  const href = typeof payload?.href === "string" ? payload.href : ""
  return (
    <ToolStatusCard title="核验源文档" status={status} icon={<FileText className="size-4" />}>
      <button
        type="button"
        onClick={() => href && navigate(href)}
        className="block w-full text-left disabled:cursor-default"
        disabled={!href}
      >
        <span className="line-clamp-2 text-sm font-medium">{title}</span>
      </button>
    </ToolStatusCard>
  )
}

const ReadSourceToolUI = makeAssistantToolUI({
  toolName: "read_source_article",
  render: ({ result, status }) => <ReadSourceRender result={result} status={status} />,
})

/** 在 AssistantRuntimeProvider 内挂载全部公开问答工具卡片渲染器。 */
export function PublicQaToolUIs() {
  return (
    <>
      <PlanToolUI />
      <ProgressToolUI />
      <CitationToolUI />
      <DataTableToolUI />
      <ListArticlesToolUI />
      <SearchArticlesToolUI />
      <SearchGraphToolUI />
      <SearchTreeToolUI />
      <ReadTreeNodeToolUI />
      <ReadWikiToolUI />
      <ReadSourceToolUI />
    </>
  )
}
