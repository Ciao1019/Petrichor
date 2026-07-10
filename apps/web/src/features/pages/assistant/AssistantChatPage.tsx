"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  makeAssistantToolUI,
  makeAssistantDataUI,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  useAuiState,
  useMessageTiming,
  type ToolCallMessagePartStatus,
} from "@assistant-ui/react"
import {
  AssistantChatTransport,
  useChatRuntime,
  type ThreadTokenUsage,
  type UseChatRuntimeOptions,
} from "@assistant-ui/react-ai-sdk"
import { useNavigate } from "react-router-dom"
import {
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Copy,
  FileText,
  Gauge,
  Globe2,
  Library,
  ListChecks,
  ListTree,
  Loader2,
  MessageSquarePlus,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { ContextDisplay } from "@/components/assistant-ui/context-display"
import { MarkdownText } from "@/components/assistant-ui/markdown-text"
import { QaMarkdownScope, QaMarkdownText, QaPreparing } from "@/features/pages/knowledge/QaMarkdown"
import { ToolFallback } from "@/components/assistant-ui/tool-fallback"
import { CitationList } from "@/components/tool-ui/citation"
import { safeParseSerializableCitation } from "@/components/tool-ui/citation/schema"
import { DataTable } from "@/components/tool-ui/data-table"
import { safeParseSerializableDataTable } from "@/components/tool-ui/data-table/schema"
import { AssistantTaskRail, TASK_TOOL_NAMES } from "@/features/pages/assistant/AssistantTaskRail"
import { ApprovalCard } from "@/components/tool-ui/approval-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  type AssistantFocus,
  type AssistantPersistedPlan,
  type AssistantThreadSummary,
  assistantApi,
  knowledgeBaseArticleApi,
  type KnowledgeBaseQaModelInfo,
  type KnowledgeBaseQaModelOption,
  type KnowledgeBaseQaSummary,
  knowledgeBaseQaApi,
  docLibraryApi,
  type DocLibrary,
} from "@/lib/api"
import { dashboardRoutes, knowledgeBaseArticlePath } from "@/lib/dashboard-routes"
import { cn } from "@/lib/utils"
import { gsap } from "@/lib/gsap"
import { GsapFade } from "@/components/ui/gsap-transition"

const CHAT_THREAD_HEADER = "X-Petrichor-Assistant-Thread-Id"
type AssistantUIMessage = NonNullable<UseChatRuntimeOptions["messages"]>[number]
const SKIP_DELETE_CONFIRM_KEY = "petrichor:assistant.skipDeleteConfirm"

type AssistantFocusSelection =
  | { kind: "none" }
  | { kind: "knowledge"; knowledgeBaseId: string }
  | { kind: "doc_library"; libraryId: string }

function focusToRequestBody(focus: AssistantFocusSelection): AssistantFocus | null {
  if (focus.kind === "knowledge") return { knowledgeBaseId: focus.knowledgeBaseId }
  if (focus.kind === "doc_library") return { libraryId: focus.libraryId }
  return null
}

function focusFromThread(focus: AssistantFocus | null): AssistantFocusSelection {
  if (focus?.knowledgeBaseId) return { kind: "knowledge", knowledgeBaseId: String(focus.knowledgeBaseId) }
  if (focus?.libraryId) return { kind: "doc_library", libraryId: String(focus.libraryId) }
  return { kind: "none" }
}

function threadRecencyKey(thread: AssistantThreadSummary) {
  return thread.updatedAt || thread.createdAt
}

const PlanToolUI = makeAssistantToolUI({
  toolName: "upsert_plan",
  // 进度改由右侧 AssistantTaskRail 展示，消息流内不再渲染大卡
  render: () => null,
})

const ProgressToolUI = makeAssistantToolUI({
  toolName: "show_progress",
  render: () => null,
})

const ConfirmationToolUI = makeAssistantToolUI({
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

const CitationToolUI = makeAssistantToolUI({
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

function toInternalAppPath(href: string) {
  if (!href) return false
  if (href.startsWith("/") && !href.startsWith("//")) return href
  if (typeof window === "undefined") return false
  try {
    const url = new URL(href, window.location.origin)
    return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : false
  } catch {
    return false
  }
}

function parseLegacyDocumentHref(href: string) {
  if (!href) return null
  try {
    const url = new URL(href, typeof window === "undefined" ? "http://localhost" : window.location.origin)
    const match = url.pathname.match(/^\/document\/(\d+)$/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

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

function HitRows({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return null
  return (
    <div className="space-y-1.5">
      {rows.slice(0, 8).map((row, index) => {
        const badge = row.knowledgeBaseName ?? row.fileName ?? row.locator ?? row.kind ?? row.mode
        return (
          <div key={String(row.chunkId ?? row.nodeKey ?? row.pageKey ?? row.id ?? index)} className="rounded-md border bg-background px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">{String(row.title ?? "未命名")}</span>
              {badge != null ? <Badge variant="outline" className="shrink-0 text-[10px]">{String(badge)}</Badge> : null}
            </div>
            {typeof row.snippet === "string" && row.snippet ? (
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{row.snippet}</p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

const ListSystemOverviewToolUI = makeAssistantToolUI({
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

const ListKbToolUI = makeAssistantToolUI({
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

const ListDocLibrariesToolUI = makeAssistantToolUI({
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

const SearchKnowledgeToolUI = makeAssistantToolUI({
  toolName: "search_knowledge",
  render: ({ result, args, status }) => {
    const payload = asRecord(result)
    const rows = asRows(result, "hits")
    const query = String(asRecord(args)?.query ?? payload?.query ?? "")
    return (
      <ToolStatusCard title={query ? `检索知识：${query}` : "检索知识"} status={status} icon={<Search className="size-4" />} collapsible defaultOpen={false}>
        {payload?.mode ? <p className="mb-2 text-[11px] text-muted-foreground">模式 {String(payload.mode)}</p> : null}
        <HitRows rows={rows} />
      </ToolStatusCard>
    )
  },
})

const SearchDocumentsToolUI = makeAssistantToolUI({
  toolName: "search_documents",
  render: ({ result, args, status }) => {
    const payload = asRecord(result)
    const rows = asRows(result, "hits")
    const query = String(asRecord(args)?.query ?? payload?.query ?? "")
    return (
      <ToolStatusCard title={query ? `检索文档：${query}` : "检索文档"} status={status} icon={<Search className="size-4" />} collapsible defaultOpen={false}>
        <HitRows rows={rows} />
      </ToolStatusCard>
    )
  },
})

const ReadKnowledgeToolUI = makeAssistantToolUI({
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

const ReadDocumentToolUI = makeAssistantToolUI({
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

const SaveArtifactToolUI = makeAssistantToolUI({
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

const SpawnResearchSubagentToolUI = makeAssistantToolUI({
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

/** 服务端 data-context-compress → assistant-ui DataMessagePart name=context-compress */
const ContextCompressDataUI = makeAssistantDataUI({
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

function asRows(value: unknown, nestedKey?: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(asRecord).filter(isPresent)
  if (nestedKey) {
    const nested = asRecord(value)?.[nestedKey]
    if (Array.isArray(nested)) return nested.map(asRecord).filter(isPresent)
  }
  return []
}

const THREAD_PAGE_SIZE = 30

export function AssistantChatPage() {
  const [threads, setThreads] = React.useState<AssistantThreadSummary[]>([])
  const [threadsLoading, setThreadsLoading] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [nextCursor, setNextCursor] = React.useState<number | null>(null)
  const [knowledgeBases, setKnowledgeBases] = React.useState<KnowledgeBaseQaSummary[]>([])
  const [docLibraries, setDocLibraries] = React.useState<DocLibrary[]>([])
  const [modelInfo, setModelInfo] = React.useState<KnowledgeBaseQaModelInfo | null>(null)
  const [selectedConfigId, setSelectedConfigId] = React.useState<string | null>(null)
  const [focusSelection, setFocusSelection] = React.useState<AssistantFocusSelection>({ kind: "none" })
  const [activeThreadId, setActiveThreadId] = React.useState<string | null>(null)
  const [initialMessages, setInitialMessages] = React.useState<AssistantUIMessage[]>([])
  const [persistedPlans, setPersistedPlans] = React.useState<AssistantPersistedPlan[]>([])
  const [runtimeSeed, setRuntimeSeed] = React.useState(0)
  const [threadLoading, setThreadLoading] = React.useState(false)
  const [sidebarOpen, setSidebarOpen] = React.useState(true)
  const [threadFilter, setThreadFilter] = React.useState("")
  const [threadFilterCommitted, setThreadFilterCommitted] = React.useState("")
  const [manageMode, setManageMode] = React.useState(false)
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set())
  const [bulkDeleting, setBulkDeleting] = React.useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = React.useState(false)
  const [pendingDeleteThread, setPendingDeleteThread] = React.useState<AssistantThreadSummary | null>(null)
  const [deletingThread, setDeletingThread] = React.useState(false)
  const [skipNextConfirm, setSkipNextConfirm] = React.useState(false)
  const skipConfirmRef = React.useRef(false)
  const fetchTokenRef = React.useRef(0)

  React.useEffect(() => {
    if (typeof window === "undefined") return
    skipConfirmRef.current = window.localStorage.getItem(SKIP_DELETE_CONFIRM_KEY) === "1"
  }, [])

  React.useEffect(() => {
    const id = window.setTimeout(() => {
      setThreadFilterCommitted(threadFilter.trim())
    }, 250)
    return () => window.clearTimeout(id)
  }, [threadFilter])

  const buildListParams = React.useCallback((cursor: number) => {
    const params: { cursor: number; limit: number; q?: string } = {
      cursor,
      limit: THREAD_PAGE_SIZE,
    }
    if (threadFilterCommitted) params.q = threadFilterCommitted
    return params
  }, [threadFilterCommitted])

  const fetchFirstPage = React.useCallback(async () => {
    const token = ++fetchTokenRef.current
    setThreadsLoading(true)
    try {
      const response = await assistantApi.threadList(buildListParams(0))
      if (token !== fetchTokenRef.current) return
      setThreads(response.data.items)
      setNextCursor(response.data.nextCursor)
    } catch (error) {
      if (token !== fetchTokenRef.current) return
      toast.error(resolveApiErrorMessage(error, "加载对话列表失败"))
    } finally {
      if (token === fetchTokenRef.current) setThreadsLoading(false)
    }
  }, [buildListParams])

  const loadMoreThreads = React.useCallback(async () => {
    if (nextCursor == null || loadingMore || threadsLoading) return
    setLoadingMore(true)
    const token = fetchTokenRef.current
    try {
      const response = await assistantApi.threadList(buildListParams(nextCursor))
      if (token !== fetchTokenRef.current) return
      setThreads((prev) => {
        const seen = new Set(prev.map((thread) => thread.id))
        const merged = [...prev]
        for (const thread of response.data.items) {
          if (!seen.has(thread.id)) merged.push(thread)
        }
        return merged
      })
      setNextCursor(response.data.nextCursor)
    } catch (error) {
      if (token === fetchTokenRef.current) {
        toast.error(resolveApiErrorMessage(error, "加载更多对话失败"))
      }
    } finally {
      if (token === fetchTokenRef.current) setLoadingMore(false)
    }
  }, [buildListParams, loadingMore, nextCursor, threadsLoading])

  const refreshThreads = fetchFirstPage

  const refreshKnowledgeBases = React.useCallback(async () => {
    try {
      const response = await knowledgeBaseQaApi.knowledgeBaseList()
      setKnowledgeBases(response.data.knowledgeBases)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "加载知识库列表失败"))
    }
  }, [])

  const refreshDocLibraries = React.useCallback(async () => {
    try {
      const response = await docLibraryApi.listLibraries()
      setDocLibraries(response.data.libraries)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "加载文档库列表失败"))
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void fetchFirstPage()
    })
    return () => {
      cancelled = true
    }
  }, [fetchFirstPage])

  React.useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      void refreshKnowledgeBases()
      void refreshDocLibraries()
      knowledgeBaseQaApi.modelInfo()
        .then((response) => {
          if (cancelled) return
          setModelInfo(response.data)
          setSelectedConfigId((current) => current ?? response.data.configId)
        })
        .catch(() => {
          if (!cancelled) setModelInfo(null)
        })
    })
    return () => {
      cancelled = true
    }
  }, [refreshDocLibraries, refreshKnowledgeBases])

  const selectedModel = React.useMemo<KnowledgeBaseQaModelInfo | null>(() => {
    if (!modelInfo) return null
    if (selectedConfigId == null) return modelInfo
    const found = modelInfo.availableModels?.find((item) => item.configId === selectedConfigId)
    if (!found) return modelInfo
    return {
      configId: found.configId,
      modelId: found.modelId,
      modelName: found.modelName,
      contextWindow: found.contextWindow,
      availableModels: modelInfo.availableModels,
    }
  }, [modelInfo, selectedConfigId])

  const handleSelectConfigId = React.useCallback((next: string) => {
    setSelectedConfigId(next)
  }, [])

  const hideThreadSidebar = React.useCallback(() => {
    setSidebarOpen(false)
  }, [])

  const loadThread = React.useCallback(async (threadId: string) => {
    setThreadLoading(true)
    try {
      const response = await assistantApi.threadDetail(threadId)
      setActiveThreadId(response.data.thread.id)
      setFocusSelection(focusFromThread(response.data.thread.focus))
      setInitialMessages(toInitialMessages(response.data.messages))
      setPersistedPlans(response.data.plans ?? [])
      setRuntimeSeed((value) => value + 1)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "加载对话失败"))
    } finally {
      setThreadLoading(false)
    }
  }, [])

  const handleNewThread = React.useCallback(() => {
    setActiveThreadId(null)
    setInitialMessages([])
    setPersistedPlans([])
    setRuntimeSeed((value) => value + 1)
  }, [])

  const performDeleteThread = React.useCallback(async (thread: AssistantThreadSummary) => {
    setDeletingThread(true)
    try {
      await assistantApi.threadDelete(thread.id)
      setThreads((items) => items.filter((item) => item.id !== thread.id))
      setSelectedIds((prev) => {
        if (!prev.has(thread.id)) return prev
        const next = new Set(prev)
        next.delete(thread.id)
        return next
      })
      if (activeThreadId === thread.id) {
        setActiveThreadId(null)
        setInitialMessages([])
        setPersistedPlans([])
        setRuntimeSeed((value) => value + 1)
      }
      setPendingDeleteThread(null)
      toast.success("已删除对话")
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "删除对话失败"))
    } finally {
      setDeletingThread(false)
    }
  }, [activeThreadId])

  const performBulkDelete = React.useCallback(async () => {
    if (selectedIds.size === 0) return
    setBulkDeleting(true)
    const ids = Array.from(selectedIds)
    try {
      const response = await assistantApi.threadDeleteMany(ids)
      const deletedSet = new Set(ids)
      setThreads((items) => items.filter((item) => !deletedSet.has(item.id)))
      setSelectedIds(new Set())
      setConfirmBulkDelete(false)
      if (activeThreadId && deletedSet.has(activeThreadId)) {
        setActiveThreadId(null)
        setInitialMessages([])
        setPersistedPlans([])
        setRuntimeSeed((value) => value + 1)
      }
      toast.success(`已删除 ${response.data.deleted} 个对话`)
      setManageMode(false)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "批量删除失败"))
    } finally {
      setBulkDeleting(false)
    }
  }, [activeThreadId, selectedIds])

  const exitManageMode = React.useCallback(() => {
    setManageMode(false)
    setSelectedIds(new Set())
  }, [])

  const toggleThreadSelected = React.useCallback((threadId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(threadId)) next.delete(threadId)
      else next.add(threadId)
      return next
    })
  }, [])

  const handleRequestDeleteThread = React.useCallback((thread: AssistantThreadSummary) => {
    if (skipConfirmRef.current) {
      void performDeleteThread(thread)
      return
    }
    setSkipNextConfirm(false)
    setPendingDeleteThread(thread)
  }, [performDeleteThread])

  const handleConfirmDeleteThread = React.useCallback(async () => {
    if (!pendingDeleteThread) return
    if (skipNextConfirm && typeof window !== "undefined") {
      window.localStorage.setItem(SKIP_DELETE_CONFIRM_KEY, "1")
      skipConfirmRef.current = true
    }
    await performDeleteThread(pendingDeleteThread)
  }, [pendingDeleteThread, skipNextConfirm, performDeleteThread])

  const handleFocusChange = React.useCallback((next: AssistantFocusSelection) => {
    setFocusSelection(next)
    if (activeThreadId) {
      const thread = threads.find((item) => item.id === activeThreadId)
      if (thread) {
        const current = focusFromThread(thread.focus)
        const same =
          current.kind === next.kind &&
          (next.kind === "none" ||
            (next.kind === "knowledge" && current.kind === "knowledge" && current.knowledgeBaseId === next.knowledgeBaseId) ||
            (next.kind === "doc_library" && current.kind === "doc_library" && current.libraryId === next.libraryId))
        if (!same) handleNewThread()
      }
    }
  }, [activeThreadId, handleNewThread, threads])

  const handleThreadKnown = React.useCallback((threadId: string) => {
    setActiveThreadId((current) => {
      if (current && current === threadId) return current
      void refreshThreads()
      return threadId
    })
  }, [refreshThreads])

  const onStreamSettled = React.useCallback(async () => {
    await refreshThreads()
  }, [refreshThreads])

  const activeFocusName = React.useMemo(() => {
    if (focusSelection.kind === "knowledge") {
      return knowledgeBases.find((kb) => kb.id === focusSelection.knowledgeBaseId)?.name ?? "知识库"
    }
    if (focusSelection.kind === "doc_library") {
      return docLibraries.find((lib) => lib.id === focusSelection.libraryId)?.name ?? "文档库"
    }
    return null
  }, [docLibraries, focusSelection, knowledgeBases])

  const groupedThreads = React.useMemo(() => groupThreadsByRecency(threads), [threads])
  const hasActiveQuery = threadFilterCommitted.length > 0
  const selectedCount = selectedIds.size
  const visibleThreadIds = React.useMemo(() => threads.map((thread) => thread.id), [threads])
  const allVisibleSelected = visibleThreadIds.length > 0 && visibleThreadIds.every((id) => selectedIds.has(id))

  const toggleSelectAllVisible = React.useCallback(() => {
    setSelectedIds((prev) => {
      if (allVisibleSelected) {
        if (prev.size === 0) return prev
        const next = new Set(prev)
        for (const id of visibleThreadIds) next.delete(id)
        return next
      }
      const next = new Set(prev)
      for (const id of visibleThreadIds) next.add(id)
      return next
    })
  }, [allVisibleSelected, visibleThreadIds])

  // GSAP 接管 sidebar 宽度（移除原 transition-[width]）。
  const sidebarRef = React.useRef<HTMLElement | null>(null)
  const sidebarMountedRef = React.useRef(false)
  React.useLayoutEffect(() => {
    const el = sidebarRef.current
    if (!el) return
    const targetWidth = sidebarOpen ? "18rem" /* w-72 */ : "0px"
    if (!sidebarMountedRef.current) {
      sidebarMountedRef.current = true
      gsap.set(el, { width: targetWidth })
      return
    }
    const tween = gsap.to(el, {
      width: targetWidth,
      duration: 0.42,
      ease: "power2.inOut",
      overwrite: "auto",
    })
    return () => {
      tween.kill()
    }
  }, [sidebarOpen])

  return (
    <div className="relative flex h-[calc(100dvh-3.5rem)] min-h-0 w-full bg-background">
      {/* Sidebar */}
      <aside
        ref={sidebarRef}
        className="flex h-full shrink-0 flex-col overflow-hidden border-r border-border/60 bg-muted/30 will-change-[width] dark:bg-[#0e0e0e]"
      >
        <div className="flex h-full w-72 min-w-72 flex-col overflow-hidden">
          {manageMode ? (
            <div className="flex h-12 shrink-0 items-center justify-between gap-1 px-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="whitespace-nowrap text-[13px] font-semibold tracking-tight">
                  已选 {selectedCount} 项
                </span>
              </div>
              <div className="flex items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                      onClick={toggleSelectAllVisible}
                      disabled={visibleThreadIds.length === 0}
                    >
                      {allVisibleSelected ? "取消全选" : "全选"}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {allVisibleSelected ? "取消选中可见项" : "选中所有可见项"}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 rounded-md text-destructive hover:bg-destructive/10 hover:text-destructive disabled:text-muted-foreground/40"
                      onClick={() => setConfirmBulkDelete(true)}
                      disabled={selectedCount === 0 || bulkDeleting}
                    >
                      <Trash2 className="size-3.5" />
                      <span className="sr-only">删除所选</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">删除所选</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 rounded-md text-muted-foreground hover:text-foreground"
                      onClick={exitManageMode}
                      disabled={bulkDeleting}
                    >
                      <X className="size-3.5" />
                      <span className="sr-only">退出管理</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">退出管理</TooltipContent>
                </Tooltip>
              </div>
            </div>
          ) : (
            <div className="flex h-12 shrink-0 items-center justify-between gap-1 px-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="whitespace-nowrap text-[13px] font-semibold tracking-tight">对话历史</span>
                <span className="text-[11px] text-muted-foreground">{threads.length}</span>
              </div>
              <div className="flex items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 rounded-md text-muted-foreground hover:text-foreground"
                      onClick={handleNewThread}
                    >
                      <MessageSquarePlus className="size-3.5" />
                      <span className="sr-only">新对话</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">新对话</TooltipContent>
                </Tooltip>
                {threads.length > 0 ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 rounded-md text-muted-foreground hover:text-foreground"
                        onClick={() => setManageMode(true)}
                      >
                        <ListChecks className="size-3.5" />
                        <span className="sr-only">管理对话</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">管理</TooltipContent>
                  </Tooltip>
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 rounded-md text-muted-foreground hover:text-foreground"
                      onClick={() => setSidebarOpen(false)}
                    >
                      <PanelLeftClose className="size-3.5" />
                      <span className="sr-only">收起对话列表</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">收起</TooltipContent>
                </Tooltip>
              </div>
            </div>
          )}
          <div className="px-3 pb-2">
            <div className="flex items-center gap-1.5">
              <div className="relative flex flex-1 items-center">
                <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground/60" />
                <input
                  type="search"
                  value={threadFilter}
                  onChange={(event) => setThreadFilter(event.target.value)}
                  placeholder="搜索对话"
                  className="h-8 w-full rounded-md border border-transparent bg-background/60 pl-8 pr-2 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 hover:bg-background focus:border-border focus:bg-background"
                />
              </div>
            </div>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="pb-4 pr-2 pt-1">
              {threadsLoading ? (
                <div className="px-3">
                  <LoadingRows count={5} />
                </div>
              ) : threads.length === 0 ? (
                <div className="px-3">
                  <EmptyHint message={hasActiveQuery ? "没有匹配的对话" : "还没有对话"} />
                </div>
              ) : (
                <>
                  {groupedThreads.groups.map((group) => (
                    <ThreadGroup
                      key={group.key}
                      label={group.label}
                      threads={group.threads}
                      activeThreadId={activeThreadId}
                      onSelect={loadThread}
                      onDelete={handleRequestDeleteThread}
                      manageMode={manageMode}
                      selectedIds={selectedIds}
                      onToggleSelect={toggleThreadSelected}
                    />
                  ))}
                  <InfiniteSentinel
                    enabled={nextCursor != null && !threadsLoading}
                    loading={loadingMore}
                    onIntersect={loadMoreThreads}
                  />
                </>
              )}
            </div>
          </ScrollArea>
        </div>
      </aside>

      {/* Main column */}
      <main className="relative flex min-w-0 flex-1 flex-col bg-[#fdfdfd] dark:bg-[#141414]">
        {!sidebarOpen ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute left-3 top-3 z-10 size-8 rounded-md text-muted-foreground hover:text-foreground"
                onClick={() => setSidebarOpen(true)}
              >
                <PanelLeftOpen className="size-4" />
                <span className="sr-only">展开对话列表</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">展开对话列表</TooltipContent>
          </Tooltip>
        ) : null}
        {threadLoading ? (
          <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            加载中
          </div>
        ) : null}

        {/* Chat area */}
        <div className="relative min-h-0 flex-1" onPointerDownCapture={hideThreadSidebar}>
          <QaChatPanel
            key={runtimeSeed}
            focusSelection={focusSelection}
            threadId={activeThreadId}
            initialMessages={initialMessages}
            persistedPlans={persistedPlans}
            onThreadKnown={handleThreadKnown}
            onStreamSettled={onStreamSettled}
            scopeName={activeFocusName}
            knowledgeBases={knowledgeBases}
            docLibraries={docLibraries}
            onFocusChange={handleFocusChange}
            modelInfo={selectedModel}
            selectedConfigId={selectedConfigId}
            onConfigChange={handleSelectConfigId}
            onComposerFocus={hideThreadSidebar}
          />
        </div>
      </main>

      <AlertDialog
        open={confirmBulkDelete}
        onOpenChange={(open) => {
          if (!open && !bulkDeleting) setConfirmBulkDelete(false)
        }}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader className="place-items-center! items-center sm:text-center!">
            <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-destructive/10">
              <TriangleAlert className="size-6 text-destructive" />
            </div>
            <AlertDialogTitle>确定要删除选中的 {selectedCount} 个对话吗？</AlertDialogTitle>
            <AlertDialogDescription className="text-center">
              此操作无法撤销。所选对话的全部消息及相关数据将被永久删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={bulkDeleting || selectedCount === 0}
              onClick={(event) => {
                event.preventDefault()
                void performBulkDelete()
              }}
            >
              {bulkDeleting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  删除中...
                </>
              ) : (
                "删除"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingDeleteThread != null}
        onOpenChange={(open) => {
          if (!open && !deletingThread) setPendingDeleteThread(null)
        }}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader className="place-items-center! items-center sm:text-center!">
            <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-destructive/10">
              <TriangleAlert className="size-6 text-destructive" />
            </div>
            <AlertDialogTitle>确定要删除这个对话吗？</AlertDialogTitle>
            <AlertDialogDescription className="text-center">
              此操作无法撤销。「
              <span className="font-medium text-foreground">
                {pendingDeleteThread?.title ?? "该对话"}
              </span>
              」的所有消息及相关数据将被永久删除。
            </AlertDialogDescription>
            <div className="mt-3 flex items-center justify-center gap-2.5">
              <Checkbox
                id="qa-skip-delete-confirm"
                checked={skipNextConfirm}
                onCheckedChange={(value) => setSkipNextConfirm(value === true)}
              />
              <Label
                htmlFor="qa-skip-delete-confirm"
                className="cursor-pointer font-normal text-muted-foreground"
              >
                下次不再询问
              </Label>
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingThread}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deletingThread}
              onClick={(event) => {
                event.preventDefault()
                void handleConfirmDeleteThread()
              }}
            >
              {deletingThread ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  删除中...
                </>
              ) : (
                "删除"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function QaChatPanel({
  focusSelection,
  threadId,
  initialMessages,
  persistedPlans,
  onThreadKnown,
  onStreamSettled,
  scopeName,
  knowledgeBases,
  docLibraries,
  onFocusChange,
  modelInfo,
  selectedConfigId,
  onConfigChange,
  onComposerFocus,
}: {
  focusSelection: AssistantFocusSelection
  threadId: string | null
  initialMessages: AssistantUIMessage[]
  persistedPlans: AssistantPersistedPlan[]
  onThreadKnown: (threadId: string) => void
  onStreamSettled: () => void | Promise<void>
  scopeName: string | null
  knowledgeBases: KnowledgeBaseQaSummary[]
  docLibraries: DocLibrary[]
  onFocusChange: (next: AssistantFocusSelection) => void
  modelInfo: KnowledgeBaseQaModelInfo | null
  selectedConfigId: string | null
  onConfigChange: (next: string) => void
  onComposerFocus?: () => void
}) {
  const focusBody = React.useMemo(
    () => focusToRequestBody(focusSelection),
    [focusSelection],
  )
  const transport = React.useMemo(() => new AssistantChatTransport<AssistantUIMessage>({
    api: "/api/assistant/chat",
    body: {
      threadId,
      focus: focusBody,
    },
    credentials: "include",
    fetch: async (input, init) => {
      const currentConfigId = selectedConfigId
      let nextInit = init
      if (init && typeof init.body === "string") {
        try {
          const parsed = JSON.parse(init.body)
          if (parsed && typeof parsed === "object") {
            parsed.focus = focusBody
            if (currentConfigId) parsed.configId = currentConfigId
            nextInit = { ...init, body: JSON.stringify(parsed) }
          }
        } catch {
          // 非 JSON body 时保持原样
        }
      }
      const response = await fetch(input, nextInit)
      if (response.status === 401 && typeof window !== "undefined") {
        const redirect = encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)
        window.location.replace(`/login?redirect=${redirect}`)
      }
      if (response.status === 409 && typeof window !== "undefined") {
        toast.error("尚未配置对话模型", {
          action: {
            label: "去配置",
            onClick: () => { window.location.href = dashboardRoutes.aiConfig },
          },
        })
      }
      const remoteThreadId = response.headers.get(CHAT_THREAD_HEADER)
      if (remoteThreadId) {
        onThreadKnown(remoteThreadId)
      }
      return response
    },
  }), [focusBody, onThreadKnown, selectedConfigId, threadId])

  const suggestions = React.useMemo(() => {
    if (focusSelection.kind === "none") {
      return [
        { prompt: "我现在有多少个知识库和文档库？" },
        { prompt: "用一段话总结所有知识库的核心主题。" },
        { prompt: "在文档库里找找最近值得复习的内容。" },
        { prompt: "把「盘点我的知识库现状」拆成可见计划，再逐步执行。" },
      ]
    }
    if (focusSelection.kind === "doc_library") {
      return [
        { prompt: `请基于「${scopeName ?? "当前文档库"}」总结我可以问哪些问题。` },
        { prompt: "找出这份资料里最值得记住的结论。" },
        { prompt: "用表格对比文档中的关键概念。" },
        { prompt: "帮我定位和「部署 / 回滚」相关的段落。" },
      ]
    }
    return [
      { prompt: `请基于「${scopeName ?? "当前知识库"}」总结我可以问哪些问题。` },
      { prompt: "对当前知识库做一次结构化对比分析，并用表格展示。" },
      { prompt: "找出值得沉淀的结论，并给出引用。" },
      { prompt: "搜索这个知识库里和「目标 / 原则」相关的内容。" },
    ]
  }, [focusSelection.kind, scopeName])

  const runtime = useChatRuntime({
    id: threadId ?? `assistant-${focusSelection.kind}-draft`,
    messages: initialMessages,
    transport,
    suggestions,
    onFinish: () => {
      void onStreamSettled()
    },
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <PlanToolUI />
      <ProgressToolUI />
      <ConfirmationToolUI />
      <SpawnResearchSubagentToolUI />
      <ContextCompressDataUI />
      <CitationToolUI />
      <DataTableToolUI />
      <ListSystemOverviewToolUI />
      <ListKbToolUI />
      <ListDocLibrariesToolUI />
      <SearchKnowledgeToolUI />
      <SearchDocumentsToolUI />
      <ReadKnowledgeToolUI />
      <ReadDocumentToolUI />
      <SaveArtifactToolUI />
      <QaMarkdownScope>
      <div className="h-full min-h-0">
        <GrokThread
          scopeName={scopeName}
          focusSelection={focusSelection}
          knowledgeBases={knowledgeBases}
          docLibraries={docLibraries}
          onFocusChange={onFocusChange}
          modelInfo={modelInfo}
          selectedConfigId={selectedConfigId}
          onConfigChange={onConfigChange}
          onComposerFocus={onComposerFocus}
          persistedPlans={persistedPlans}
        />
      </div>
      </QaMarkdownScope>
    </AssistantRuntimeProvider>
  )
}

function GrokThread({
  scopeName,
  focusSelection,
  knowledgeBases,
  docLibraries,
  onFocusChange,
  modelInfo,
  selectedConfigId,
  onConfigChange,
  onComposerFocus,
  persistedPlans,
}: {
  scopeName: string | null
  focusSelection: AssistantFocusSelection
  knowledgeBases: KnowledgeBaseQaSummary[]
  docLibraries: DocLibrary[]
  onFocusChange: (next: AssistantFocusSelection) => void
  modelInfo: KnowledgeBaseQaModelInfo | null
  selectedConfigId: string | null
  onConfigChange: (next: string) => void
  onComposerFocus?: () => void
  persistedPlans: AssistantPersistedPlan[]
}) {
  const isUnscoped = focusSelection.kind === "none"
  const scopeLabel =
    focusSelection.kind === "none"
      ? "全部资料"
      : focusSelection.kind === "doc_library"
        ? scopeName ?? "当前文档库"
        : scopeName ?? "当前知识库"
  const composerProps = {
    knowledgeBases,
    docLibraries,
    focusSelection,
    onFocusChange,
    scopeLabel,
    modelInfo,
    selectedConfigId,
    onConfigChange,
    onComposerFocus,
  }

  return (
    <ThreadPrimitive.Root
      className="relative flex h-full flex-col items-stretch bg-[#fdfdfd] px-4 dark:bg-[#141414]"
    >
      <AuiIf condition={(s) => s.thread.isEmpty}>
        <div className="flex h-full flex-col items-center justify-center">
          <GrokComposer placeholder={isUnscoped ? "问点什么？在知识库和文档库里寻找答案..." : `在「${scopeLabel}」里问点什么？`} {...composerProps} />
          <ThreadSuggestions />
        </div>
      </AuiIf>

      <AuiIf condition={(s) => s.thread.isEmpty === false}>
        <ThreadPrimitive.Viewport className="qa-thread-viewport flex grow flex-col overflow-y-auto pt-10">
          <ThreadPrimitive.Messages>
            {() => <ChatMessage />}
          </ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
        <AssistantTaskRail persistedPlans={persistedPlans} />
        <QaThreadToc />
        <GrokComposer placeholder={isUnscoped ? "继续提问..." : `继续在「${scopeLabel}」里提问...`} {...composerProps} />
        <p className="mx-auto w-full max-w-3xl pb-2 text-center text-[#9a9a9a] text-xs">
          回答由 AI 生成，请自行核验关键信息。
        </p>
      </AuiIf>
    </ThreadPrimitive.Root>
  )
}

function ThreadSuggestions() {
  return (
    <div className="mt-4 flex w-full max-w-3xl flex-wrap justify-center gap-2 px-4">
      <ThreadPrimitive.Suggestions>
        {() => <SuggestionChip />}
      </ThreadPrimitive.Suggestions>
    </div>
  )
}

function SuggestionChip() {
  return (
    <SuggestionPrimitive.Trigger send asChild>
      <Button
        variant="outline"
        className="h-auto whitespace-normal rounded-full border-[#e5e5e5] bg-white px-3.5 py-1.5 text-left font-normal text-sm text-[#6b6b6b] shadow-none transition-colors hover:bg-[#f5f5f5] hover:text-[#0d0d0d] dark:border-[#2a2a2a] dark:bg-[#1a1a1a] dark:text-[#9a9a9a] dark:hover:bg-[#252525] dark:hover:text-white"
      >
        <SuggestionPrimitive.Title />
      </Button>
    </SuggestionPrimitive.Trigger>
  )
}

function GrokComposer({
  placeholder,
  knowledgeBases,
  docLibraries,
  focusSelection,
  onFocusChange,
  scopeLabel,
  modelInfo,
  selectedConfigId,
  onConfigChange,
  onComposerFocus,
}: {
  placeholder: string
  knowledgeBases: KnowledgeBaseQaSummary[]
  docLibraries: DocLibrary[]
  focusSelection: AssistantFocusSelection
  onFocusChange: (next: AssistantFocusSelection) => void
  scopeLabel: string
  modelInfo: KnowledgeBaseQaModelInfo | null
  selectedConfigId: string | null
  onConfigChange: (next: string) => void
  onComposerFocus?: () => void
}) {
  const isEmpty = useAuiState((s) => s.composer.isEmpty)
  const isRunning = useAuiState((s) => s.thread.isRunning)
  const contextWindow = modelInfo?.contextWindow ?? null
  const availableModels = modelInfo?.availableModels ?? []

  return (
    <ComposerPrimitive.Root
      className="group/composer mx-auto mb-3 w-full max-w-3xl"
      data-empty={isEmpty}
      data-running={isRunning}
    >
      <div className="overflow-hidden rounded-[28px] bg-[#f8f8f8] shadow-xs ring-1 ring-[#e5e5e5] ring-inset transition-shadow focus-within:ring-[#d0d0d0] dark:bg-[#212121] dark:ring-[#2a2a2a] dark:focus-within:ring-[#3a3a3a]">
        <div className="flex items-end gap-1 p-2">
          <ComposerPrimitive.Input
            id="kb-qa-composer-input"
            name="message"
            placeholder={placeholder}
            minRows={1}
            onFocus={onComposerFocus}
            className="my-2 ml-2 h-6 max-h-100 min-w-0 flex-1 resize-none bg-transparent text-[#0d0d0d] text-base leading-6 outline-none placeholder:text-[#9a9a9a] dark:text-white dark:placeholder:text-[#6b6b6b]"
          />

          <InlineScopeSelector
            knowledgeBases={knowledgeBases}
            docLibraries={docLibraries}
            value={focusSelection}
            onChange={onFocusChange}
            scopeLabel={scopeLabel}
            isEmpty={isEmpty}
          />

          <div className="relative mb-0.5 h-9 w-9 shrink-0 rounded-full bg-[#0d0d0d] text-white dark:bg-white dark:text-[#0d0d0d]">
            {/* GSAP 接管 transform+opacity，替代原 transition-all duration-300 */}
            <GsapFade
              visible={isEmpty && !isRunning}
              className="absolute inset-0"
            >
              <button
                type="button"
                className="flex h-full w-full items-center justify-center"
                aria-label="语音模式"
                tabIndex={-1}
              >
                <Mic className="size-[18px]" />
              </button>
            </GsapFade>

            <GsapFade
              visible={!isEmpty && !isRunning}
              className="absolute inset-0"
            >
              <ComposerPrimitive.Send className="flex h-full w-full items-center justify-center">
                <ArrowUp className="size-[18px]" />
              </ComposerPrimitive.Send>
            </GsapFade>

            <GsapFade
              visible={isRunning}
              className="absolute inset-0"
            >
              <ComposerPrimitive.Cancel className="flex h-full w-full items-center justify-center">
                <Square className="size-3.5 fill-current" />
              </ComposerPrimitive.Cancel>
            </GsapFade>
          </div>
        </div>
      </div>
      {contextWindow ? (
        <div className="mx-2 mt-1.5 flex items-center justify-between gap-3 text-[11px] text-[#9a9a9a] dark:text-[#6b6b6b]">
          <BottomModelSelector
            modelInfo={modelInfo}
            selectedConfigId={selectedConfigId}
            availableModels={availableModels}
            onChange={onConfigChange}
          />
          <ComposerContextBar contextWindow={contextWindow} />
        </div>
      ) : null}
    </ComposerPrimitive.Root>
  )
}

function ComposerContextBar({ contextWindow }: { contextWindow: number }) {
  const messages = useAuiState((s) => s.thread.messages)
  const usage = React.useMemo(() => extractLatestAssistantUsage(messages), [messages])
  return <ContextDisplay.Bar modelContextWindow={contextWindow} side="top" usage={usage} />
}

function extractLatestAssistantUsage(messages: unknown): ThreadTokenUsage | undefined {
  const arr = Array.isArray(messages) ? messages : []
  for (let idx = arr.length - 1; idx >= 0; idx -= 1) {
    const message = arr[idx] as { role?: unknown; metadata?: unknown } | undefined
    if (!message || message.role !== "assistant") continue
    const metadata = asRecord(message.metadata)
    if (!metadata) continue
    const usage = normalizeUsageRecord(metadata.usage)
    if (usage) return usage
    const fromCustom = normalizeUsageRecord(asRecord(metadata.custom)?.usage)
    if (fromCustom) return fromCustom
    const fromContent = normalizeUsageRecord(asRecord(asRecord(metadata)?.content)?.usage)
    if (fromContent) return fromContent
  }
  return undefined
}

function normalizeUsageRecord(value: unknown): ThreadTokenUsage | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const result: ThreadTokenUsage = {}
  let hasFields = false
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "reasoningTokens", "cachedInputTokens"] as const) {
    const raw = record[key]
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      result[key] = raw
      hasFields = true
    }
  }
  if (!hasFields) return undefined
  if (result.totalTokens === undefined && result.inputTokens !== undefined && result.outputTokens !== undefined) {
    result.totalTokens = result.inputTokens + result.outputTokens
  }
  return result
}

function InlineScopeSelector({
  knowledgeBases,
  docLibraries,
  value,
  onChange,
  scopeLabel,
  isEmpty,
}: {
  knowledgeBases: KnowledgeBaseQaSummary[]
  docLibraries: DocLibrary[]
  value: AssistantFocusSelection
  onChange: (next: AssistantFocusSelection) => void
  scopeLabel: string
  isEmpty: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const isAll = value.kind === "none"
  const ScopeIcon = value.kind === "doc_library" ? FileText : isAll ? Globe2 : Library

  const triggerRef = React.useRef<HTMLButtonElement | null>(null)
  const innerRef = React.useRef<HTMLDivElement | null>(null)
  const mountedRef = React.useRef(false)

  React.useLayoutEffect(() => {
    const trigger = triggerRef.current
    const inner = innerRef.current
    if (!trigger || !inner) return

    const targets = isEmpty
      ? { pad: 10, gap: 8, innerMax: 160, innerOpacity: 1 }
      : { pad: 0, gap: 0, innerMax: 0, innerOpacity: 0 }

    if (!mountedRef.current) {
      mountedRef.current = true
      gsap.set(trigger, {
        width: isEmpty ? "auto" : "2.25rem",
        paddingLeft: targets.pad,
        paddingRight: targets.pad,
        gap: targets.gap,
      })
      gsap.set(inner, { maxWidth: targets.innerMax, autoAlpha: targets.innerOpacity })
      return
    }

    const tweens = [
      gsap.to(trigger, {
        width: isEmpty ? "auto" : "2.25rem",
        paddingLeft: targets.pad,
        paddingRight: targets.pad,
        gap: targets.gap,
        duration: 0.28,
        ease: "power3.out",
        overwrite: "auto",
      }),
      gsap.to(inner, {
        maxWidth: targets.innerMax,
        autoAlpha: targets.innerOpacity,
        duration: 0.28,
        ease: "power3.out",
        overwrite: "auto",
      }),
    ]
    return () => {
      tweens.forEach((t) => t.kill())
    }
  }, [isEmpty])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={triggerRef}
        className={cn(
          "mb-0.5 flex h-9 shrink-0 items-center justify-center overflow-hidden rounded-full text-[#0d0d0d] will-change-[width,padding,gap] transition-colors duration-150 hover:bg-[#f0f0f0] data-[state=open]:bg-[#f0f0f0] dark:text-white dark:hover:bg-[#2a2a2a] dark:data-[state=open]:bg-[#2a2a2a]",
        )}
        aria-label="选择提问范围"
      >
        <ScopeIcon className={cn("size-[18px] shrink-0", isAll && "text-violet-600 dark:text-violet-300")} />
        <div
          ref={innerRef}
          className="flex items-center gap-1 overflow-hidden will-change-[max-width,opacity]"
        >
          <span className="max-w-[10rem] truncate whitespace-nowrap font-semibold text-sm">
            {scopeLabel}
          </span>
          <ChevronDown className="size-4 shrink-0" />
        </div>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={8} className="w-[320px] p-0">
        <Command>
          <CommandInput placeholder="搜索知识库或文档库..." />
          <CommandList>
            <CommandEmpty>没有找到范围</CommandEmpty>
            <CommandGroup heading="范围">
              <CommandItem
                value="all all-sources 全部资料"
                onSelect={() => {
                  onChange({ kind: "none" })
                  setOpen(false)
                }}
              >
                <Globe2 className="size-3.5 text-violet-600 dark:text-violet-300" />
                <span className="flex-1">全部资料</span>
                {isAll ? <Check className="size-3.5 text-primary" /> : null}
              </CommandItem>
            </CommandGroup>
            {knowledgeBases.length > 0 ? (
              <CommandGroup heading="知识库">
                {knowledgeBases.map((kb) => (
                  <CommandItem
                    key={`kb-${kb.id}`}
                    value={`kb ${kb.name} ${kb.id}`}
                    onSelect={() => {
                      onChange({ kind: "knowledge", knowledgeBaseId: kb.id })
                      setOpen(false)
                    }}
                  >
                    <Library className="size-3.5 text-muted-foreground" />
                    <span className="flex-1 truncate">{kb.name}</span>
                    {value.kind === "knowledge" && value.knowledgeBaseId === kb.id ? <Check className="size-3.5 text-primary" /> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {docLibraries.length > 0 ? (
              <CommandGroup heading="文档库">
                {docLibraries.map((lib) => (
                  <CommandItem
                    key={`lib-${lib.id}`}
                    value={`lib ${lib.name} ${lib.id}`}
                    onSelect={() => {
                      onChange({ kind: "doc_library", libraryId: lib.id })
                      setOpen(false)
                    }}
                  >
                    <FileText className="size-3.5 text-muted-foreground" />
                    <span className="flex-1 truncate">{lib.name}</span>
                    {value.kind === "doc_library" && value.libraryId === lib.id ? <Check className="size-3.5 text-primary" /> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function formatContextWindow(tokens: number | null | undefined): string | null {
  if (tokens == null || !Number.isFinite(tokens) || tokens <= 0) return null
  if (tokens >= 1_000_000) {
    const v = tokens / 1_000_000
    return `${Number.isInteger(v) ? v : v.toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    const v = tokens / 1_000
    return `${Number.isInteger(v) ? v : Math.round(v)}K`
  }
  return String(tokens)
}

function BottomModelSelector({
  modelInfo,
  selectedConfigId,
  availableModels,
  onChange,
}: {
  modelInfo: KnowledgeBaseQaModelInfo | null
  selectedConfigId: string | null
  availableModels: KnowledgeBaseQaModelOption[]
  onChange: (next: string) => void
}) {
  const hasOptions = availableModels.length > 0
  const label = modelInfo?.modelName ?? modelInfo?.modelId ?? ""
  const subLabel = modelInfo?.modelName && modelInfo?.modelId && modelInfo.modelId !== modelInfo.modelName
    ? modelInfo.modelId
    : null

  if (!label) return <span />

  const trigger = (
    <button
      type="button"
      disabled={!hasOptions}
      className={cn(
        "-mx-1 inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-1 py-0.5 outline-none transition-colors hover:bg-[#f0f0f0] data-[state=open]:bg-[#f0f0f0] disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-[#2a2a2a] dark:data-[state=open]:bg-[#2a2a2a]",
      )}
      aria-label="切换模型"
    >
      <span className="truncate text-foreground/70">{label}</span>
      {subLabel ? <span className="truncate font-mono text-[10px]">{subLabel}</span> : null}
      {hasOptions ? <ChevronDown className="size-3 shrink-0 opacity-70" /> : null}
    </button>
  )

  if (!hasOptions) return trigger

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={6} className="min-w-[220px] p-1">
        {availableModels.map((option) => {
          const active = option.configId === selectedConfigId
          const ctx = formatContextWindow(option.contextWindow)
          return (
            <DropdownMenuItem
              key={option.configId}
              onSelect={() => onChange(option.configId)}
              className="flex items-center gap-2 px-2 py-1.5"
            >
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="truncate text-sm">{option.modelName}</span>
                {option.modelId && option.modelId !== option.modelName ? (
                  <span className="truncate font-mono text-[10px] text-muted-foreground">
                    {option.modelId}
                  </span>
                ) : null}
              </span>
              {ctx ? (
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{ctx}</span>
              ) : null}
              {active ? <Check className="size-3.5 text-primary" /> : <span className="size-3.5" />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ChatMessage() {
  // data-qa-msg-id 是对话大纲（QaThreadToc）定位/滚动的 DOM 锚点
  const messageId = useAuiState((s) => s.message.id)
  return (
    <MessagePrimitive.Root data-qa-msg-id={messageId} className="group/message relative mx-auto mb-2 flex w-full max-w-3xl flex-col pb-0.5">
      <AuiIf condition={(s) => s.message.role === "user"}>
        <UserMessageBubble />
      </AuiIf>
      <AuiIf condition={(s) => s.message.role === "assistant"}>
        <AssistantMessageBubble />
      </AuiIf>
    </MessagePrimitive.Root>
  )
}

/* ─── 对话大纲（复用文档详情 .ftoc 悬浮目录，交互与 EditorTocOverlay 一致） ─── */

const QA_TOC_VIEWPORT_SELECTOR = ".qa-thread-viewport"
// 激活判定线：消息顶部越过视口顶部 + 该偏移即视为当前项（对齐文档页 +80 的判定）
const QA_TOC_ACTIVE_OFFSET = 80
// 点击定位后消息顶部距视口顶部的留白
const QA_TOC_CLICK_OFFSET = 16
const QA_TOC_LINE_W: Record<number, number> = { 2: 14, 3: 10 }
const QA_TOC_LINE_W_ACTIVE: Record<number, number> = { 2: 22, 3: 18 }

type QaTocItem = { id: string; level: number; text: string }

function getQaViewport(): HTMLElement | null {
  return document.querySelector<HTMLElement>(QA_TOC_VIEWPORT_SELECTOR)
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function firstTextOfParts(parts: readonly unknown[]): string {
  for (const raw of parts) {
    const part = asRecord(raw)
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
      return part.text.trim()
    }
  }
  return ""
}

/** 用户消息取问题原文；AI 回复优先取正文首个 Markdown 标题，否则取首行。 */
function deriveQaTocText(role: string, raw: string): string {
  const fallback = role === "user" ? "（空消息）" : "AI 回答"
  if (!raw) return fallback
  if (role === "assistant") {
    const heading = raw.match(/^#{1,6}\s+(.+)$/m)?.[1]
    if (heading) return stripInlineMarkdown(heading) || fallback
    const line = raw
      .split("\n")
      .map((item) => item.trim())
      .find((item) => item.length > 0 && !item.startsWith("```"))
    return stripInlineMarkdown(line ?? "") || fallback
  }
  return stripInlineMarkdown(raw) || fallback
}

function QaThreadToc() {
  const messages = useAuiState((s) => s.thread.messages)
  const items = React.useMemo<QaTocItem[]>(() => {
    const list: QaTocItem[] = []
    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant") continue
      list.push({
        id: message.id,
        level: message.role === "user" ? 2 : 3,
        text: deriveQaTocText(message.role, firstTextOfParts(message.parts)),
      })
    }
    return list
  }, [messages])
  const hasItems = items.length > 0

  const [activeId, setActiveId] = React.useState("")
  // null = 未测量；测好定位再渲染，避免首帧闪位
  const [tocRight, setTocRight] = React.useState<number | null>(null)
  const [tocTop, setTocTop] = React.useState<number | null>(null)

  React.useEffect(() => {
    if (!hasItems) { setActiveId(""); return }
    setActiveId((prev) => {
      if (!prev) return items[0].id
      return items.some((item) => item.id === prev) ? prev : items[0].id
    })
  }, [hasItems, items])

  // 定位：贴聊天视口右缘，顶部按视口高度 20% 并夹在视口范围内
  React.useLayoutEffect(() => {
    const calc = () => {
      const viewport = getQaViewport()
      if (!viewport) return
      const rect = viewport.getBoundingClientRect()
      const vh = window.innerHeight
      setTocRight(Math.max(4, window.innerWidth - rect.right + 8))
      setTocTop(Math.min(Math.max(vh * 0.2, rect.top + 16), vh * 0.75))
    }
    calc()
    const ro = new ResizeObserver(calc)
    ro.observe(document.documentElement)
    const viewport = getQaViewport()
    if (viewport) ro.observe(viewport)
    window.addEventListener("resize", calc)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", calc)
    }
  }, [])

  // 滚动跟踪激活项：滚动源是聊天视口而非 window，其余与文档页一致
  React.useEffect(() => {
    if (!hasItems) return
    const viewport = getQaViewport()
    if (!viewport) return
    let ticking = false

    const updateActive = () => {
      const nodes = Array.from(viewport.querySelectorAll<HTMLElement>("[data-qa-msg-id]"))
      if (!nodes.length) return
      const threshold = viewport.getBoundingClientRect().top + QA_TOC_ACTIVE_OFFSET
      let active = nodes[0]
      for (const node of nodes) {
        if (node.getBoundingClientRect().top <= threshold) active = node
      }
      const id = active.dataset.qaMsgId
      if (id) setActiveId(id)
    }

    updateActive()
    const requestUpdate = () => {
      if (ticking) return
      ticking = true
      window.requestAnimationFrame(() => { ticking = false; updateActive() })
    }
    viewport.addEventListener("scroll", requestUpdate, { passive: true })
    window.addEventListener("resize", requestUpdate)
    return () => {
      viewport.removeEventListener("scroll", requestUpdate)
      window.removeEventListener("resize", requestUpdate)
    }
  }, [hasItems])

  const handleTocClick = React.useCallback((id: string) => {
    const viewport = getQaViewport()
    if (!viewport) return
    const target = viewport.querySelector<HTMLElement>(`[data-qa-msg-id="${CSS.escape(id)}"]`)
    if (!target) return
    const top = target.getBoundingClientRect().top
      - viewport.getBoundingClientRect().top
      + viewport.scrollTop
      - QA_TOC_CLICK_OFFSET
    viewport.scrollTo({ top: Math.max(0, top), behavior: "smooth" })
    setActiveId(id)
  }, [])

  if (!hasItems || tocRight === null || tocTop === null) return null
  return (
    <QaTocOverlay
      items={items}
      activeId={activeId}
      rightOffset={tocRight}
      topOffset={tocTop}
      onTocClick={handleTocClick}
    />
  )
}

function QaTocOverlay({
  items,
  activeId,
  rightOffset,
  topOffset,
  onTocClick,
}: {
  items: QaTocItem[]
  activeId: string
  rightOffset: number
  topOffset: number
  onTocClick: (id: string) => void
}) {
  const containerRef = React.useRef<HTMLElement | null>(null)
  const clickLockRef = React.useRef(false)

  React.useEffect(() => {
    if (clickLockRef.current) return
    const container = containerRef.current
    if (!container || !activeId) return
    const el = container.querySelector<HTMLElement>(`[data-toc-id="${CSS.escape(activeId)}"]`)
    if (!el) return
    const scrollTarget = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2
    container.scrollTo({ top: scrollTarget, behavior: "smooth" })
  }, [activeId])

  const handleClick = React.useCallback((id: string) => {
    const container = containerRef.current
    if (container) {
      const el = container.querySelector<HTMLElement>(`[data-toc-id="${CSS.escape(id)}"]`)
      if (el) {
        const scrollTarget = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2
        container.scrollTo({ top: scrollTarget, behavior: "smooth" })
      }
    }
    clickLockRef.current = true
    onTocClick(id)
    setTimeout(() => { clickLockRef.current = false }, 900)
  }, [onTocClick])

  // Portal 到 body，position:fixed 相对真实视口定位（同 EditorTocOverlay）
  return createPortal(
    <nav
      className="ftoc"
      ref={containerRef}
      aria-label="对话大纲"
      style={{ right: rightOffset, top: topOffset }}
    >
      {items.map((item) => {
        const active = activeId === item.id
        const w = active ? (QA_TOC_LINE_W_ACTIVE[item.level] ?? 18) : (QA_TOC_LINE_W[item.level] ?? 10)
        return (
          <div
            key={item.id}
            data-toc-id={item.id}
            data-level={item.level}
            className={cn("ftoc-item", active && "is-active")}
            onClick={() => handleClick(item.id)}
          >
            <span className="ftoc-text">{item.text}</span>
            <span className="ftoc-line" style={{ width: w }} />
          </div>
        )
      })}
    </nav>,
    document.body
  )
}

function UserMessageBubble() {
  return (
    <div className="flex flex-col items-end">
      <div className="relative max-w-[90%] rounded-3xl rounded-br-lg border border-[#e5e5e5] bg-[#f0f0f0] px-4 py-3 text-[#0d0d0d] dark:border-[#2a2a2a] dark:bg-[#1a1a1a] dark:text-white">
        <div className="prose prose-sm dark:prose-invert wrap-break-word prose-p:my-0">
          <MessagePrimitive.Parts>
            {({ part }) => {
              if (part.type === "text") return <MarkdownText />
              return null
            }}
          </MessagePrimitive.Parts>
        </div>
      </div>
      <div className="mt-1 flex h-8 items-center justify-end gap-0.5 opacity-0 transition-opacity group-focus-within/message:opacity-100 group-hover/message:opacity-100">
        <ActionBarPrimitive.Root className="flex items-center gap-0.5">
          <ActionBarPrimitive.Edit className="flex h-8 w-8 items-center justify-center rounded-full text-[#6b6b6b] transition-colors hover:bg-[#e5e5e5] hover:text-[#0d0d0d] dark:text-[#9a9a9a] dark:hover:bg-[#2a2a2a] dark:hover:text-white">
            <Pencil className="size-4" />
          </ActionBarPrimitive.Edit>
          <ActionBarPrimitive.Copy className="flex h-8 w-8 items-center justify-center rounded-full text-[#6b6b6b] transition-colors hover:bg-[#e5e5e5] hover:text-[#0d0d0d] dark:text-[#9a9a9a] dark:hover:bg-[#2a2a2a] dark:hover:text-white">
            <Copy className="size-4" />
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      </div>
    </div>
  )
}

function AssistantMessageBubble() {
  return (
    <div className="flex flex-col items-start">
      <div className="w-full max-w-none">
        <AuiIf
          condition={(s) =>
            s.thread.isRunning &&
            // 本条助手消息还没有任何可见内容（首字 / 工具调用 / 推理 / 压缩中）时显示默认准备态
            !s.message.parts.some((part) => {
              if (part.type === "text" && "text" in part && String(part.text).trim().length > 0) return true
              if (part.type === "tool-call" || part.type === "reasoning") return true
              if (part.type === "data" && "name" in part && part.name === "context-compress") return true
              return false
            })
          }
        >
          <QaPreparing />
        </AuiIf>
        <div className="wrap-break-word">
          <MessagePrimitive.Parts>
            {({ part }) => {
              if (part.type === "text") return <QaMarkdownText />
              if (part.type === "tool-call") {
                if (TASK_TOOL_NAMES.has(part.toolName)) return null
                return (
                  <div className="not-prose my-3">
                    {part.toolUI ?? <ToolFallback {...part} />}
                  </div>
                )
              }
              return null
            }}
          </MessagePrimitive.Parts>
        </div>
        <MessagePrimitive.Error>
          <ErrorPrimitive.Root className="mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-destructive text-sm dark:bg-destructive/5 dark:text-red-200">
            <ErrorPrimitive.Message className="line-clamp-2" />
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>
      </div>
      <div className="mt-1 flex h-8 w-full items-center justify-start gap-0.5 opacity-0 transition-opacity group-focus-within/message:opacity-100 group-hover/message:opacity-100">
        <ActionBarPrimitive.Root className="flex items-center gap-0.5">
          <ActionBarPrimitive.Reload className="flex h-8 w-8 items-center justify-center rounded-full text-[#6b6b6b] transition-colors hover:bg-[#e5e5e5] hover:text-[#0d0d0d] dark:text-[#9a9a9a] dark:hover:bg-[#2a2a2a] dark:hover:text-white">
            <RefreshCw className="size-4" />
          </ActionBarPrimitive.Reload>
          <ActionBarPrimitive.Copy className="flex h-8 w-8 items-center justify-center rounded-full text-[#6b6b6b] transition-colors hover:bg-[#e5e5e5] hover:text-[#0d0d0d] dark:text-[#9a9a9a] dark:hover:bg-[#2a2a2a] dark:hover:text-white">
            <Copy className="size-4" />
          </ActionBarPrimitive.Copy>
          <MessageTimingDisplay />
        </ActionBarPrimitive.Root>
      </div>
    </div>
  )
}

function MessageTimingDisplay() {
  const liveTiming = useMessageTiming()
  const messageMetadata = useAuiState((s) => s.message.metadata)
  const persistedTiming = React.useMemo(() => readPersistedTiming(messageMetadata), [messageMetadata])
  const subAgentUsage = React.useMemo(() => readSubAgentUsage(messageMetadata), [messageMetadata])
  const timing = liveTiming?.totalStreamTime ? liveTiming : persistedTiming
  if (!timing?.totalStreamTime) return null

  const totalTimeText = formatStreamTime(timing.totalStreamTime)
  if (!totalTimeText) return null

  return (
    <div className="group/timing relative">
      <button
        type="button"
        className="ml-1 flex h-auto items-center justify-center rounded-md px-1.5 py-0.5 font-mono text-[#6b6b6b] text-xs tabular-nums transition-colors hover:bg-[#e5e5e5] hover:text-[#0d0d0d] dark:text-[#9a9a9a] dark:hover:bg-[#2a2a2a] dark:hover:text-white"
      >
        {totalTimeText}
      </button>
      <div className="pointer-events-none absolute top-1/2 left-full z-10 ml-2 -translate-y-1/2 scale-95 rounded-lg border border-[#e5e5e5] bg-white px-3 py-2 opacity-0 shadow-lg transition-[transform,opacity] duration-200 before:absolute before:top-0 before:-left-2 before:h-full before:w-2 before:content-[''] group-hover/timing:pointer-events-auto group-hover/timing:scale-100 group-hover/timing:opacity-100 dark:border-[#2a2a2a] dark:bg-[#1a1a1a]">
        <div className="grid min-w-[140px] gap-1.5 text-xs">
          {timing.firstTokenTime !== undefined && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-[#6b6b6b] dark:text-[#9a9a9a]">首字</span>
              <span className="font-mono text-[#0d0d0d] tabular-nums dark:text-white">
                {formatStreamMs(timing.firstTokenTime)}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between gap-4">
            <span className="text-[#6b6b6b] dark:text-[#9a9a9a]">总耗时</span>
            <span className="font-mono text-[#0d0d0d] tabular-nums dark:text-white">
              {formatStreamMs(timing.totalStreamTime)}
            </span>
          </div>
          {timing.tokensPerSecond !== undefined && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-[#6b6b6b] dark:text-[#9a9a9a]">速率</span>
              <span className="font-mono text-[#0d0d0d] tabular-nums dark:text-white">
                {timing.tokensPerSecond.toFixed(1)} tok/s
              </span>
            </div>
          )}
          {subAgentUsage && (
            <div className="flex items-center justify-between gap-4 border-t border-[#e5e5e5] pt-1.5 dark:border-[#2a2a2a]">
              <span className="text-[#6b6b6b] dark:text-[#9a9a9a]">子检索</span>
              <span className="font-mono text-[#0d0d0d] tabular-nums dark:text-white">
                {subAgentUsage.calls} 次 · {formatCompactTokens(subAgentUsage.totalTokens)} tok
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function readPersistedTiming(metadata: unknown) {
  const root = asRecord(metadata)
  if (!root) return undefined
  const record = asRecord(root.custom) ?? root
  const totalStreamTime = typeof record.totalStreamTime === "number" ? record.totalStreamTime : undefined
  if (!totalStreamTime) return undefined
  const firstTokenTime = typeof record.firstTokenTime === "number" ? record.firstTokenTime : undefined
  const tokensPerSecond = typeof record.tokensPerSecond === "number" ? record.tokensPerSecond : undefined
  const totalChunks = typeof record.totalChunks === "number" ? record.totalChunks : 0
  return { firstTokenTime, totalStreamTime, tokensPerSecond, totalChunks }
}

function readSubAgentUsage(metadata: unknown) {
  const root = asRecord(metadata)
  if (!root) return undefined
  const record = asRecord(root.custom) ?? root
  const usage = asRecord(record.subAgentUsage)
  if (!usage) return undefined
  const calls = typeof usage.calls === "number" ? usage.calls : 0
  if (calls <= 0) return undefined
  const inputTokens = typeof usage.inputTokens === "number" ? usage.inputTokens : 0
  const outputTokens = typeof usage.outputTokens === "number" ? usage.outputTokens : 0
  const totalTokens = typeof usage.totalTokens === "number" ? usage.totalTokens : inputTokens + outputTokens
  return { calls, totalTokens }
}

function formatCompactTokens(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

function formatStreamTime(ms: number | undefined) {
  if (ms === undefined) return null
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatStreamMs(ms: number | undefined) {
  if (ms === undefined) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function ThreadGroup({
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

function ThreadButton({
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
            ) : focus.kind === "doc_library" ? (
              <span className="inline-flex min-w-0 max-w-[120px] shrink items-center gap-0.5 rounded-sm bg-muted px-1 py-px text-muted-foreground">
                <FileText className="size-2.5 shrink-0" />
                <span className="truncate">文档库</span>
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

function InfiniteSentinel({
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

function EmptyHint({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-dashed border-border/60 bg-background/40 px-3 py-5 text-center text-xs text-muted-foreground">
      {message}
    </div>
  )
}

function LoadingRows({ count }: { count: number }) {
  return (
    <div className="space-y-1.5">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="h-10 animate-pulse rounded-md bg-muted/40" />
      ))}
    </div>
  )
}

function groupThreadsByRecency(threads: AssistantThreadSummary[]) {
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const buckets: Array<{ key: string; label: string; threads: AssistantThreadSummary[] }> = [
    { key: "today", label: "今天", threads: [] },
    { key: "yesterday", label: "昨天", threads: [] },
    { key: "week", label: "7 天内", threads: [] },
    { key: "month", label: "30 天内", threads: [] },
    { key: "older", label: "更早", threads: [] },
  ]

  for (const thread of threads) {
    const reference = thread.updatedAt
    const ts = reference ? new Date(reference).getTime() : 0
    if (!ts || Number.isNaN(ts)) {
      buckets[4].threads.push(thread)
      continue
    }
    const diff = now - ts
    if (diff < day && isSameLocalDay(ts, now)) buckets[0].threads.push(thread)
    else if (diff < 2 * day && isSameLocalDay(ts, now - day)) buckets[1].threads.push(thread)
    else if (diff < 7 * day) buckets[2].threads.push(thread)
    else if (diff < 30 * day) buckets[3].threads.push(thread)
    else buckets[4].threads.push(thread)
  }

  const groups = buckets.filter((bucket) => bucket.threads.length > 0)
  const totalShown = groups.reduce((sum, group) => sum + group.threads.length, 0)
  return { groups, totalShown }
}

function isSameLocalDay(aMs: number, bMs: number) {
  const a = new Date(aMs)
  const b = new Date(bMs)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function toInitialMessages(messages: Array<{ id: string; role: string; content?: unknown }>): AssistantUIMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      const content = normalizeAssistantPersistedContent(message.content)
      const metadata = extractPersistedMessageMetadata(content)
      const savedParts = extractPersistedParts(content)
      const parts = savedParts ?? [{ type: "text", text: extractTextFromContent(content) }]
      return {
        id: `persisted-${message.id}`,
        role: message.role,
        parts,
        ...(metadata ? { metadata } : {}),
      }
    }) as AssistantUIMessage[]
}

function normalizeAssistantPersistedContent(content: unknown) {
  // user 消息可能整条 UIMessage；assistant 多为 { parts }
  const record = asRecord(content)
  if (!record) return content
  if (Array.isArray(record.parts)) return record
  if (record.role && Array.isArray(asRecord(record)?.parts)) return record
  // 整条 UIMessage
  if (typeof record.role === "string" && Array.isArray(record.parts)) return record
  return content
}

function extractTextFromContent(content: unknown) {
  const record = asRecord(content)
  if (!record) return typeof content === "string" ? content : ""
  if (typeof record.text === "string") return record.text
  const parts = Array.isArray(record.parts) ? record.parts : []
  const texts = parts
    .map((part) => asRecord(part))
    .filter(isPresent)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
  return texts.join("\n")
}

function extractPersistedParts(content: unknown) {
  const record = asRecord(content)
  if (!record) return null
  const parts = record.parts
  if (!Array.isArray(parts) || parts.length === 0) return null
  // 仅保留 AI SDK 已知 part 类型；移除中间态（input-streaming 等）改成终态以便重渲染。
  const sanitized = parts
    .map((part) => sanitizeUIMessagePart(part))
    .filter((part): part is Record<string, unknown> => part != null)
  return sanitized.length > 0 ? sanitized : null
}

function sanitizeUIMessagePart(part: unknown): Record<string, unknown> | null {
  const record = asRecord(part)
  if (!record) return null
  const type = typeof record.type === "string" ? record.type : ""
  if (!type) return null
  if (type === "text" || type === "reasoning") {
    if (typeof record.text !== "string") return null
    return { type, text: record.text }
  }
  if (type === "step-start") {
    return { type }
  }
  if (type.startsWith("tool-") || type === "dynamic-tool") {
    // 把流式中间态归一化为最终态，避免恢复时停在 input-streaming
    const next: Record<string, unknown> = { ...record }
    const state = typeof record.state === "string" ? record.state : ""
    if (state === "input-streaming" || state === "input-available") {
      next.state = "output-available"
    } else if (!state) {
      next.state = "output-available"
    }
    if (next.output === undefined && next.result !== undefined) {
      next.output = next.result
    }
    return next
  }
  if (type === "source-url" || type === "source-document" || type === "file") {
    return record
  }
  // 自定义 data-* part（如 data-context-compress）：原样保留 type/id/data，供刷新后重放；
  // 落库前服务端会剥离 running 压缩态，历史里通常只剩 done/skipped（壳不渲染）。
  if (type.startsWith("data-")) {
    return record
  }
  return null
}

function extractPersistedMessageMetadata(content: unknown) {
  const record = asRecord(content)
  if (!record) return null
  const custom: Record<string, unknown> = {}
  if (record.usage !== undefined) custom.usage = record.usage
  if (typeof record.modelId === "string") custom.modelId = record.modelId
  if (typeof record.modelName === "string") custom.modelName = record.modelName
  if (typeof record.firstTokenTime === "number") custom.firstTokenTime = record.firstTokenTime
  if (typeof record.totalStreamTime === "number") custom.totalStreamTime = record.totalStreamTime
  if (typeof record.totalChunks === "number") custom.totalChunks = record.totalChunks
  if (typeof record.tokensPerSecond === "number") custom.tokensPerSecond = record.tokensPerSecond
  if (record.subAgentUsage !== undefined) custom.subAgentUsage = record.subAgentUsage
  return Object.keys(custom).length > 0 ? { custom } : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value != null
}

function formatRelativeTime(value: string | null | undefined) {
  if (!value) return ""
  const target = new Date(value)
  if (Number.isNaN(target.getTime())) return ""
  const diff = Date.now() - target.getTime()
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return "刚刚"
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  return target.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })
}

function toolStatusLabel(status?: ToolCallMessagePartStatus) {
  if (status?.type === "running") return "运行中"
  if (status?.type === "incomplete") return "未完成"
  if (status?.type === "requires-action") return "待操作"
  return "完成"
}

function resolveApiErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error && "response" in error) {
    const response = (error as { response?: { data?: { msg?: unknown } } }).response
    const apiMsg = response?.data?.msg
    if (typeof apiMsg === "string" && apiMsg) {
      return apiMsg
    }
  }
  if (error instanceof Error && error.message) return error.message
  return fallback
}
