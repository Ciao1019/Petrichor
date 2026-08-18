"use client"

import { useMemo } from "react"
import {
  makeAssistantToolUI,
  useAuiState,
  type ToolCallMessagePartStatus,
} from "@assistant-ui/react"
import { CheckCircle2, ChevronDown, CircleAlert, ExternalLink, Loader2, Search } from "@/components/iconimate"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { knowledgeBaseArticleApi } from "@/lib/api"
import { knowledgeBaseArticlePath } from "@/lib/dashboard-routes"
import { cn } from "@/lib/utils"

import {
  parseLegacyDocumentHref,
  toInternalAppPath,
} from "./assistant-message-utils"

type SearchKind = "knowledge" | "documents"

type ClusterMember = {
  toolCallId: string
  args: Record<string, unknown> | null
  result: unknown
  status?: ToolCallMessagePartStatus
}

type ClusterSnapshot = {
  isLeader: boolean
  members: ClusterMember[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value != null
}

function asRows(value: unknown, nestedKey?: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(asRecord).filter(isPresent)
  if (nestedKey) {
    const nested = asRecord(value)?.[nestedKey]
    if (Array.isArray(nested)) return nested.map(asRecord).filter(isPresent)
  }
  return []
}

function toolStatusLabel(status?: ToolCallMessagePartStatus) {
  if (status?.type === "running") return "运行中"
  if (status?.type === "incomplete") return "未完成"
  if (status?.type === "requires-action") return "待操作"
  return "完成"
}

function isRunningStatus(status?: ToolCallMessagePartStatus) {
  return status?.type === "running"
}

function isIncompleteStatus(status?: ToolCallMessagePartStatus) {
  return status?.type === "incomplete"
}

function HitRows({ rows }: { rows: Record<string, unknown>[] }) {
  const navigate = useNavigate()

  const openHref = async (href: string) => {
    const legacyDocumentId = parseLegacyDocumentHref(href)
    if (legacyDocumentId) {
      try {
        const res = await knowledgeBaseArticleApi.detail(legacyDocumentId)
        navigate(knowledgeBaseArticlePath(res.data.knowledgeBaseId, res.data.articleId))
      } catch {
        toast.error("无法打开检索结果")
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
  }

  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">无命中</p>
  }
  return (
    <div className="space-y-1.5">
      {rows.slice(0, 8).map((row, index) => {
        const badge = row.knowledgeBaseName ?? row.fileName ?? row.locator ?? row.kind ?? row.mode
        const href = typeof row.href === "string" && row.href.trim() ? row.href.trim() : null
        const title = String(row.title ?? "未命名")
        const body = (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">{title}</span>
              <span className="flex shrink-0 items-center gap-1">
                {badge != null ? (
                  <Badge variant="outline" className="text-[10px]">{String(badge)}</Badge>
                ) : null}
                {href ? <ExternalLink className="size-3 opacity-60" aria-hidden /> : null}
              </span>
            </div>
            {typeof row.snippet === "string" && row.snippet ? (
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{row.snippet}</p>
            ) : null}
          </>
        )
        return href ? (
          <button
            key={String(row.chunkId ?? row.nodeKey ?? row.pageKey ?? row.id ?? index)}
            type="button"
            className="w-full rounded-md border bg-background px-3 py-2 text-left transition-colors hover:bg-muted/40"
            onClick={() => void openHref(href)}
          >
            {body}
          </button>
        ) : (
          <div
            key={String(row.chunkId ?? row.nodeKey ?? row.pageKey ?? row.id ?? index)}
            className="rounded-md border bg-background px-3 py-2"
          >
            {body}
          </div>
        )
      })}
    </div>
  )
}

/** useAuiState 的 getSnapshot 必须引用稳定；对象/Map 每次新建会触发无限重渲染白屏。 */
function useScopeNameMap(kind: SearchKind): Map<string, string> {
  const snapshot = useAuiState((state) => {
    const entries: Array<[string, string]> = []
    const listTool = kind === "knowledge" ? "list_knowledge_bases" : "list_doc_libraries"
    for (const part of state.message.parts) {
      if (part.type !== "tool-call" || part.toolName !== listTool) continue
      const rows = Array.isArray(part.result)
        ? part.result.map(asRecord).filter(isPresent)
        : asRows(part.result, kind === "knowledge" ? "knowledgeBases" : "libraries")
      for (const row of rows) {
        const id = row.id
        const name = row.name
        if (id != null && typeof name === "string" && name.trim()) {
          entries.push([String(id), name.trim()])
        }
      }
    }
    entries.sort((a, b) => a[0].localeCompare(b[0]))
    return JSON.stringify(entries)
  })
  return useMemo(() => new Map(JSON.parse(snapshot) as Array<[string, string]>), [snapshot])
}

function useSearchCluster(toolName: string, toolCallId: string): ClusterSnapshot {
  const snapshot = useAuiState((state) => {
    const parts = state.message.parts
    const myIndex = parts.findIndex(
      (part) => part.type === "tool-call" && part.toolCallId === toolCallId,
    )
    if (myIndex < 0) {
      return JSON.stringify({ isLeader: true, members: [] as ClusterMember[] })
    }

    let start = myIndex
    let end = myIndex
    while (
      start > 0
      && parts[start - 1]?.type === "tool-call"
      && (parts[start - 1] as { toolName?: string }).toolName === toolName
    ) {
      start -= 1
    }
    while (
      end < parts.length - 1
      && parts[end + 1]?.type === "tool-call"
      && (parts[end + 1] as { toolName?: string }).toolName === toolName
    ) {
      end += 1
    }

    const members: ClusterMember[] = []
    for (let index = start; index <= end; index += 1) {
      const part = parts[index]
      if (part?.type !== "tool-call") continue
      const toolPart = part as {
        toolCallId: string
        args?: unknown
        result?: unknown
        status?: ToolCallMessagePartStatus
      }
      members.push({
        toolCallId: toolPart.toolCallId,
        args: asRecord(toolPart.args),
        result: toolPart.result,
        status: toolPart.status ?? (toolPart.result != null ? { type: "complete" as const } : { type: "running" as const }),
      })
    }

    const leader = parts[start]
    return JSON.stringify({
      isLeader: leader?.type === "tool-call" && leader.toolCallId === toolCallId,
      members,
    })
  })
  return useMemo(() => JSON.parse(snapshot) as ClusterSnapshot, [snapshot])
}

function resolveScopeLabel(
  kind: SearchKind,
  args: Record<string, unknown> | null,
  result: unknown,
  nameMap: Map<string, string>,
): string | null {
  const payload = asRecord(result)
  if (kind === "knowledge") {
    if (payload?.mode === "cross_kb") return "跨库"
    const fromHit = asRows(result, "hits").find((row) => typeof row.knowledgeBaseName === "string")
    if (typeof fromHit?.knowledgeBaseName === "string" && fromHit.knowledgeBaseName.trim()) {
      return fromHit.knowledgeBaseName.trim()
    }
    if (typeof payload?.knowledgeBaseName === "string" && payload.knowledgeBaseName.trim()) {
      return payload.knowledgeBaseName.trim()
    }
    const id = args?.knowledgeBaseId ?? payload?.knowledgeBaseId
    if (id != null) {
      const key = String(id)
      return nameMap.get(key) ?? `库 ${key}`
    }
    return null
  }

  const fromHit = asRows(result, "hits").find((row) => typeof row.libraryName === "string" || typeof row.fileName === "string")
  if (typeof fromHit?.libraryName === "string" && fromHit.libraryName.trim()) {
    return fromHit.libraryName.trim()
  }
  const id = args?.libraryId ?? payload?.libraryId
  if (id != null) {
    const key = String(id)
    return nameMap.get(key) ?? `文档库 ${key}`
  }
  if (args?.documentId != null) return `文档 ${String(args.documentId)}`
  return null
}

function resolveQuery(args: Record<string, unknown> | null, result: unknown): string {
  const payload = asRecord(result)
  const query = args?.query ?? payload?.query
  return typeof query === "string" ? query.trim() : ""
}

function hitCount(result: unknown): number {
  return asRows(result, "hits").length
}

function StatusIcon({ status }: { status?: ToolCallMessagePartStatus }) {
  if (isRunningStatus(status)) return <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
  if (isIncompleteStatus(status)) return <CircleAlert className="size-3.5 text-muted-foreground" />
  return <CheckCircle2 className="size-3.5 text-muted-foreground" />
}

function CompactSearchRow({
  kind,
  query,
  scope,
  status,
  hitCount: count,
  className,
}: {
  kind: SearchKind
  query: string
  scope: string | null
  status?: ToolCallMessagePartStatus
  hitCount?: number
  className?: string
}) {
  const verb = kind === "knowledge" ? "检索" : "检索文档"
  const title = [
    verb,
    scope,
    query ? `「${query}」` : null,
  ].filter(Boolean).join(" · ")

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground",
        "bg-muted/25",
        className,
      )}
    >
      <StatusIcon status={status} />
      <span className="min-w-0 flex-1 truncate font-medium text-foreground/85">{title}</span>
      {!isRunningStatus(status) && typeof count === "number" ? (
        <span className="shrink-0 tabular-nums">{count} 条</span>
      ) : null}
      <span className="shrink-0 text-[10px] uppercase tracking-wide opacity-80">
        {toolStatusLabel(status)}
      </span>
    </div>
  )
}

function SearchSummaryCard({
  kind,
  query,
  scope,
  status,
  result,
  defaultOpen = false,
}: {
  kind: SearchKind
  query: string
  scope: string | null
  status?: ToolCallMessagePartStatus
  result: unknown
  defaultOpen?: boolean
}) {
  const rows = asRows(result, "hits")
  const count = rows.length
  const payload = asRecord(result)
  const verb = kind === "knowledge" ? "检索" : "检索文档"
  const title = [
    query ? `${verb}「${query}」` : verb,
    scope,
    `${count} 条`,
  ].filter(Boolean).join(" · ")

  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="rounded-xl border bg-background/60 shadow-sm backdrop-blur-sm"
    >
      <CollapsibleTrigger className="group/search flex w-full items-center gap-2 px-3 py-2 text-sm font-medium">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-left">{title}</span>
        <Badge variant="outline" className="text-[10px]">{toolStatusLabel(status)}</Badge>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=closed]/search:-rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-3 py-3 data-[state=closed]:hidden">
        {payload?.mode ? (
          <p className="mb-2 text-[11px] text-muted-foreground">模式 {String(payload.mode)}</p>
        ) : null}
        <HitRows rows={rows} />
      </CollapsibleContent>
    </Collapsible>
  )
}

function SearchClusterCard({
  kind,
  members,
  nameMap,
}: {
  kind: SearchKind
  members: ClusterMember[]
  nameMap: Map<string, string>
}) {
  const anyRunning = members.some((member) => isRunningStatus(member.status))
  const totalHits = members.reduce((sum, member) => sum + hitCount(member.result), 0)
  const queries = Array.from(new Set(
    members.map((member) => resolveQuery(member.args, member.result)).filter(Boolean),
  ))
  const queryLabel = queries.length === 1 ? queries[0] : null
  const unit = kind === "knowledge" ? "知识库" : "范围"
  const summary = anyRunning
    ? `正在检索 ${members.length} 个${unit}${queryLabel ? ` ·「${queryLabel}」` : ""}`
    : `已检索 ${members.length} 个${unit}${queryLabel ? ` ·「${queryLabel}」` : ""} · 共 ${totalHits} 条`

  return (
    <Collapsible
      defaultOpen={anyRunning}
      className="rounded-xl border bg-background/60 shadow-sm backdrop-blur-sm"
    >
      <CollapsibleTrigger className="group/cluster flex w-full items-center gap-2 px-3 py-2 text-sm font-medium">
        {anyRunning ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Search className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
        <Badge variant="outline" className="text-[10px]">
          {anyRunning ? "运行中" : "完成"}
        </Badge>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=closed]/cluster:-rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 border-t px-3 py-3 data-[state=closed]:hidden">
        {members.map((member) => {
          const query = resolveQuery(member.args, member.result)
          const scope = resolveScopeLabel(kind, member.args, member.result, nameMap)
          const count = hitCount(member.result)
          const running = isRunningStatus(member.status) || isIncompleteStatus(member.status)
          if (running) {
            return (
              <CompactSearchRow
                key={member.toolCallId}
                kind={kind}
                query={query}
                scope={scope}
                status={member.status}
              />
            )
          }
          return (
            <Collapsible key={member.toolCallId} defaultOpen={false}>
              <CollapsibleTrigger className="group/member w-full text-left">
                <CompactSearchRow
                  kind={kind}
                  query={query}
                  scope={scope}
                  status={member.status}
                  hitCount={count}
                  className="hover:bg-muted/40"
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-1.5 pl-2 data-[state=closed]:hidden">
                <HitRows rows={asRows(member.result, "hits")} />
              </CollapsibleContent>
            </Collapsible>
          )
        })}
      </CollapsibleContent>
    </Collapsible>
  )
}

function SearchToolRender({
  kind,
  toolName,
  toolCallId,
  args,
  result,
  status,
}: {
  kind: SearchKind
  toolName: string
  toolCallId: string
  args: unknown
  result: unknown
  status?: ToolCallMessagePartStatus
}) {
  const nameMap = useScopeNameMap(kind)
  const cluster = useSearchCluster(toolName, toolCallId)
  const argRecord = asRecord(args)

  if (!cluster.isLeader) return null

  if (cluster.members.length > 1) {
    return <SearchClusterCard kind={kind} members={cluster.members} nameMap={nameMap} />
  }

  const query = resolveQuery(argRecord, result)
  const scope = resolveScopeLabel(kind, argRecord, result, nameMap)

  if (isRunningStatus(status) || (isIncompleteStatus(status) && result == null)) {
    return (
      <CompactSearchRow
        kind={kind}
        query={query}
        scope={scope}
        status={status}
      />
    )
  }

  return (
    <SearchSummaryCard
      kind={kind}
      query={query}
      scope={scope}
      status={status}
      result={result}
      defaultOpen={false}
    />
  )
}

export const SearchKnowledgeToolUI = makeAssistantToolUI({
  toolName: "search_knowledge",
  render: ({ args, result, status, toolCallId }) => (
    <SearchToolRender
      kind="knowledge"
      toolName="search_knowledge"
      toolCallId={toolCallId}
      args={args}
      result={result}
      status={status}
    />
  ),
})

export const SearchDocumentsToolUI = makeAssistantToolUI({
  toolName: "search_documents",
  render: ({ args, result, status, toolCallId }) => (
    <SearchToolRender
      kind="documents"
      toolName="search_documents"
      toolCallId={toolCallId}
      args={args}
      result={result}
      status={status}
    />
  ),
})
