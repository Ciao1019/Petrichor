"use client"

import * as React from "react"
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  CompositeAttachmentAdapter,
  ErrorPrimitive,
  MessagePrimitive,
  SimpleImageAttachmentAdapter,
  SimpleTextAttachmentAdapter,
  SuggestionPrimitive,
  ThreadPrimitive,
  useAuiState,
  useMessageTiming,
} from "@assistant-ui/react"
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk"
import {
  Copy,
  ListChecks,
  Loader2,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PanelRight,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from "@/components/iconimate"
import { toast } from "sonner"

import { MarkdownText } from "@/components/assistant-ui/markdown-text"
import { UserMessageAttachments } from "@/components/assistant-ui/attachment"
import { Button } from "@/components/ui/button"
import {
  QaMarkdownScope,
  QaPreparing,
  WikiLinkClickProvider,
} from "@/features/pages/knowledge/QaMarkdown"
import { WikiPagePreviewDialog } from "@/components/knowledge/WikiPagePreviewDialog"
import { ToolFallback } from "@/components/assistant-ui/tool-fallback"
import { AssistantTaskRail, TASK_TOOL_NAMES } from "@/features/pages/assistant/AssistantTaskRail"
import {
  SearchDocumentsToolUI,
  SearchKnowledgeToolUI,
} from "@/features/pages/assistant/search-tool-ui"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useIsMobile } from "@/hooks/use-mobile"
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
  type AssistantPersistedPlan,
  type AssistantThreadSummary,
  assistantApi,
  assistantWikiApi,
  knowledgeBaseQaApi,
  type KnowledgeBaseQaModelInfo,
  type KnowledgeBaseQaSummary,
  docLibraryApi,
  type DocLibrary,
} from "@/lib/api"
import { dashboardRoutes } from "@/lib/dashboard-routes"
import { isDemoMode } from "@/lib/demo/demo-mode"
import { gsap } from "@/lib/gsap"

import { GrokComposer } from "./assistant-composer"
import {
  type AssistantFocusSelection,
  type AssistantUIMessage,
  focusFromThread,
  focusToRequestBody,
  formatCompactTokens,
  formatStreamMs,
  formatStreamTime,
  groupThreadsByRecency,
  readPersistedTiming,
  readSubAgentUsage,
  resolveApiErrorMessage,
  toInitialMessages,
} from "./assistant-message-utils"
import { InfiniteSentinel, ThreadGroup } from "./assistant-thread-list"
import { QaThreadToc } from "./assistant-toc"
import {
  CitationToolUI,
  ConfirmationToolUI,
  ContextCompressDataUI,
  DataTableToolUI,
  EmptyHint,
  IntentRouteDataUI,
  ListDocLibrariesToolUI,
  ListKbToolUI,
  ListSystemOverviewToolUI,
  LoadingRows,
  PlanToolUI,
  PreviewArticleUpdateToolUI,
  ProgressToolUI,
  ReadDocumentToolUI,
  ReadKnowledgeToolUI,
  SearchGraphToolUI,
  SaveArtifactToolUI,
  SearchWikiPagesToolUI,
  SpawnResearchFanoutToolUI,
  SpawnResearchSubagentToolUI,
  SpawnWriteSubagentToolUI,
  StepBudgetDataUI,
  WikiOverviewToolUI,
} from "./assistant-tool-renders"
import {
  AgentAnswerText,
  AgentCitationBar,
  AgentEventDataUI,
  AgentRunPanel,
  AgentStreamingAnswer,
} from "./agent-run-ui"
import { hydrateRunsFromMessages } from "@/features/agent-runs/hydrate"
import { consumePendingRetryRunId, useAgentRunsStore } from "@/features/agent-runs/store"

const CHAT_THREAD_HEADER = "X-Petrichor-Assistant-Thread-Id"
const SKIP_DELETE_CONFIRM_KEY = "petrichor:assistant.skipDeleteConfirm"
const THREAD_PAGE_SIZE = 30

/** 问答模式：normal 走分片/章节链路；wiki 参考 WeKnora 的 Wiki 页面检索链路。 */
export type AssistantQaMode = "normal" | "wiki"

export function AssistantChatPage() {
  const isMobile = useIsMobile()
  const [threads, setThreads] = React.useState<AssistantThreadSummary[]>([])
  const [threadsLoading, setThreadsLoading] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [nextCursor, setNextCursor] = React.useState<number | null>(null)
  const [knowledgeBases, setKnowledgeBases] = React.useState<KnowledgeBaseQaSummary[]>([])
  const [docLibraries, setDocLibraries] = React.useState<DocLibrary[]>([])
  const [modelInfo, setModelInfo] = React.useState<KnowledgeBaseQaModelInfo | null>(null)
  const [selectedConfigId, setSelectedConfigId] = React.useState<string | null>(null)
  const [focusSelection, setFocusSelection] = React.useState<AssistantFocusSelection>({ kind: "none" })
  // 问答模式只影响下一次提问的检索链路（请求体 qaMode 字段），不重置当前对话。
  const [qaMode, setQaMode] = React.useState<AssistantQaMode>("normal")
  const [activeThreadId, setActiveThreadId] = React.useState<string | null>(null)
  const [initialMessages, setInitialMessages] = React.useState<AssistantUIMessage[]>([])
  const [persistedPlans, setPersistedPlans] = React.useState<AssistantPersistedPlan[]>([])
  const [runtimeSeed, setRuntimeSeed] = React.useState(0)
  const [threadLoading, setThreadLoading] = React.useState(false)
  // 桌面默认展开；手机默认收起，避免首屏挤占聊天区
  const [sidebarOpen, setSidebarOpen] = React.useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 768 : true,
  )
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
    // 点右侧问答区（含聚焦输入框）就收起左侧对话列表，桌面与手机一致：
    // 开始提问时把宽度让给聊天，之后由主区左上角的展开按钮手动恢复
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
      // 刷新恢复：历史助手消息带 agentRunId 时把 Run 视图一起拉回来（§162.29）
      void hydrateRunsFromMessages(response.data.messages)
      setRuntimeSeed((value) => value + 1)
      if (isMobile) setSidebarOpen(false)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "加载对话失败"))
    } finally {
      setThreadLoading(false)
    }
  }, [isMobile])

  const handleNewThread = React.useCallback(() => {
    setActiveThreadId(null)
    setInitialMessages([])
    setPersistedPlans([])
    setRuntimeSeed((value) => value + 1)
    if (isMobile) setSidebarOpen(false)
  }, [isMobile])

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

  // GSAP 接管 sidebar 宽度（仅桌面；手机走 Sheet 覆盖层）
  const sidebarRef = React.useRef<HTMLElement | null>(null)
  const sidebarMountedRef = React.useRef(false)
  React.useLayoutEffect(() => {
    if (isMobile) {
      sidebarMountedRef.current = false
      return
    }
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
  }, [sidebarOpen, isMobile])

  const threadSidebarBody = (
        <div className="flex h-full w-full min-w-0 flex-col overflow-hidden md:w-72 md:min-w-72">
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
                      className="h-8 px-2 text-[11px] text-muted-foreground hover:text-foreground"
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
                      className="size-8 rounded-md text-destructive hover:bg-destructive/10 hover:text-destructive disabled:text-muted-foreground/40"
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
                      className="size-8 rounded-md text-muted-foreground hover:text-foreground"
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
                      className="size-8 rounded-md text-muted-foreground hover:text-foreground"
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
                        className="size-8 rounded-md text-muted-foreground hover:text-foreground"
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
                      className="size-8 rounded-md text-muted-foreground hover:text-foreground"
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
                  className="h-9 w-full rounded-md border border-transparent bg-background/60 pl-8 pr-2 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 hover:bg-background focus:border-border focus:bg-background"
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
  )

  return (
    <div className="relative flex min-h-0 w-full flex-1 bg-background">
      {isMobile ? (
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent
            side="left"
            className="w-[min(18rem,85vw)] gap-0 border-r border-border/60 bg-muted/30 p-0 dark:bg-[#0e0e0e] [&>button]:hidden"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>对话历史</SheetTitle>
              <SheetDescription>选择或管理历史对话</SheetDescription>
            </SheetHeader>
            {threadSidebarBody}
          </SheetContent>
        </Sheet>
      ) : (
        <aside
          ref={sidebarRef}
          className="flex h-full shrink-0 flex-col overflow-hidden border-r border-border/60 bg-muted/30 will-change-[width] dark:bg-[#0e0e0e]"
        >
          {threadSidebarBody}
        </aside>
      )}

      {/* Main column */}
      <main className="relative flex min-w-0 flex-1 flex-col bg-[#fdfdfd] dark:bg-[#141414]">
        {!sidebarOpen ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute left-3 top-3 z-10 size-9 rounded-md text-muted-foreground hover:text-foreground"
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
            qaMode={qaMode}
            onQaModeChange={setQaMode}
            threadId={activeThreadId}
            initialMessages={initialMessages}
            persistedPlans={persistedPlans}
            onThreadKnown={handleThreadKnown}
            onStreamSettled={onStreamSettled}
            onPlanPatched={(plan) => {
              setPersistedPlans((prev) => {
                const next = prev.filter((item) => item.id !== plan.id)
                return [plan, ...next]
              })
            }}
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
  qaMode,
  onQaModeChange,
  threadId,
  initialMessages,
  persistedPlans,
  onThreadKnown,
  onStreamSettled,
  onPlanPatched,
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
  qaMode: AssistantQaMode
  onQaModeChange: (next: AssistantQaMode) => void
  threadId: string | null
  initialMessages: AssistantUIMessage[]
  persistedPlans: AssistantPersistedPlan[]
  onThreadKnown: (threadId: string) => void
  onStreamSettled: () => void | Promise<void>
  onPlanPatched?: (plan: AssistantPersistedPlan) => void
  scopeName: string | null
  knowledgeBases: KnowledgeBaseQaSummary[]
  docLibraries: DocLibrary[]
  onFocusChange: (next: AssistantFocusSelection) => void
  modelInfo: KnowledgeBaseQaModelInfo | null
  selectedConfigId: string | null
  onConfigChange: (next: string) => void
  onComposerFocus?: () => void
}) {
  // 用 ref 注入请求体：切换模式不重建 transport，当前对话历史原样保留。
  const qaModeRef = React.useRef(qaMode)
  qaModeRef.current = qaMode
  const [wikiPreviewKey, setWikiPreviewKey] = React.useState<string | null>(null)
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
              // Wiki 问答模式：随请求体下发，服务端据此切换检索链路与提示词
              if (qaModeRef.current === "wiki") parsed.qaMode = "wiki"
              // 重试：带上被重试的 runId，后端据此记录 retryOfRunKey，不复用已失败 State（§162.24）
              const retryOfRunId = consumePendingRetryRunId()
              if (retryOfRunId) parsed.retryOfRunId = retryOfRunId
              if (currentConfigId) parsed.configId = currentConfigId
              nextInit = { ...init, body: JSON.stringify(parsed) }
            }
          } catch {
            // 非 JSON body 时保持原样
          }
        }
      if (isDemoMode()) {
        // 演示模式：不触网，走脚本化 SSE 回放（见 lib/demo/demo-chat.ts）
        const { demoAssistantChatResponse } = await import("@/lib/demo/demo-chat")
        const demoResponse = await demoAssistantChatResponse(nextInit)
        const demoThreadId = demoResponse.headers.get(CHAT_THREAD_HEADER)
        if (demoThreadId) onThreadKnown(demoThreadId)
        return demoResponse
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
    adapters: {
      attachments: new CompositeAttachmentAdapter([
        new SimpleImageAttachmentAdapter(),
        new SimpleTextAttachmentAdapter(),
      ]),
    },
    // Agent 事件直接从流里消费，不依赖 data part 的重渲染。
    // 复用同一个 part id 的 final_answer_delta 是原地覆盖的：两次更新落在
    // 同一帧时 React 只渲染最后一个值，中间那些 delta 的字会永久丢失。
    // onData 对每个 chunk 都会回调一次，reducer 再按 sequence 幂等去重。
    onData: (part) => {
      if (part.type === "data-agent-event") {
        useAgentRunsStore.getState().appendUnknown(part.data)
      }
    },
    onFinish: () => {
      void onStreamSettled()
    },
  })

  // focus 指定知识库时传给弹窗，用于消除跨库同名 pageKey 的歧义
  const loadWikiDetail = React.useCallback(
    (pageKey: string) => assistantWikiApi
      .detail(pageKey, focusSelection.kind === "knowledge" ? focusSelection.knowledgeBaseId : null)
      .then((res) => res.data),
    [focusSelection],
  )

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* 工具卡片与消息渲染都在 Provider 内：回答和检索结果里的 Wiki 引用可点开弹窗 */}
      <WikiLinkClickProvider onOpenWikiPage={setWikiPreviewKey}>
        <PlanToolUI />
        <ProgressToolUI />
        <ConfirmationToolUI />
        <SpawnResearchSubagentToolUI />
        <SpawnResearchFanoutToolUI />
        <SpawnWriteSubagentToolUI />
        <ContextCompressDataUI />
        <IntentRouteDataUI />
        <AgentEventDataUI />
        <StepBudgetDataUI />
        <CitationToolUI />
        <DataTableToolUI />
        <ListSystemOverviewToolUI />
        <ListKbToolUI />
        <ListDocLibrariesToolUI />
        <SearchKnowledgeToolUI />
        <SearchDocumentsToolUI />
        <SearchGraphToolUI />
        <WikiOverviewToolUI />
        <SearchWikiPagesToolUI />
        <ReadKnowledgeToolUI />
        <ReadDocumentToolUI />
        <SaveArtifactToolUI />
        <PreviewArticleUpdateToolUI />
        <QaMarkdownScope>
        <div className="h-full min-h-0">
          <GrokThread
            scopeName={scopeName}
            focusSelection={focusSelection}
            qaMode={qaMode}
            onQaModeChange={onQaModeChange}
            knowledgeBases={knowledgeBases}
            docLibraries={docLibraries}
            onFocusChange={onFocusChange}
            modelInfo={modelInfo}
            selectedConfigId={selectedConfigId}
            onConfigChange={onConfigChange}
            onComposerFocus={onComposerFocus}
            persistedPlans={persistedPlans}
            threadId={threadId}
            onPlanPatched={onPlanPatched}
          />
        </div>
        </QaMarkdownScope>
      </WikiLinkClickProvider>
      <WikiPagePreviewDialog
        pageKey={wikiPreviewKey}
        onClose={() => setWikiPreviewKey(null)}
        loadDetail={loadWikiDetail}
      />
    </AssistantRuntimeProvider>
  )
}

function GrokThread({
  scopeName,
  focusSelection,
  qaMode,
  onQaModeChange,
  knowledgeBases,
  docLibraries,
  onFocusChange,
  modelInfo,
  selectedConfigId,
  onConfigChange,
  onComposerFocus,
  persistedPlans,
  threadId,
  onPlanPatched,
}: {
  scopeName: string | null
  focusSelection: AssistantFocusSelection
  qaMode: AssistantQaMode
  onQaModeChange: (next: AssistantQaMode) => void
  knowledgeBases: KnowledgeBaseQaSummary[]
  docLibraries: DocLibrary[]
  onFocusChange: (next: AssistantFocusSelection) => void
  modelInfo: KnowledgeBaseQaModelInfo | null
  selectedConfigId: string | null
  onConfigChange: (next: string) => void
  onComposerFocus?: () => void
  persistedPlans: AssistantPersistedPlan[]
  threadId: string | null
  onPlanPatched?: (plan: AssistantPersistedPlan) => void
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
    qaMode,
    onQaModeChange,
    modelInfo,
    selectedConfigId,
    onConfigChange,
    onComposerFocus,
  }

  return (
    <ThreadPrimitive.Root
      className="relative flex h-full flex-col items-stretch bg-[#fdfdfd] px-3 dark:bg-[#141414] md:px-4"
    >
      <AuiIf condition={(s) => s.thread.isEmpty}>
        {/* 空状态：建议居中，输入框贴底，避免手机端垂直居中造成大块空白 */}
        <div className="flex h-full min-h-0 flex-col items-center">
          <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center">
            <ThreadSuggestions />
          </div>
          <GrokComposer placeholder={isUnscoped ? "问点什么？在知识库和文档库里寻找答案..." : `在「${scopeLabel}」里问点什么？`} {...composerProps} />
        </div>
      </AuiIf>

      <AuiIf condition={(s) => s.thread.isEmpty === false}>
        <ThreadPrimitive.Viewport className="qa-thread-viewport flex grow flex-col overflow-y-auto pt-10">
          <ThreadPrimitive.Messages>
            {() => <ChatMessage />}
          </ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
        <AssistantTaskRail
          persistedPlans={persistedPlans}
          threadId={threadId}
          onPlanPatched={onPlanPatched}
        />
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
    <div className="flex w-full max-w-3xl flex-wrap justify-center gap-2 px-4">
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


function ChatMessage() {
  // data-qa-msg-id 是对话大纲（QaThreadToc）定位/滚动的 DOM 锚点
  const messageId = useAuiState((s) => s.message.id)
  const role = useAuiState((s) => s.message.role)
  const isEditing = useAuiState((s) => s.message.composer.isEditing)
  if (isEditing) {
    return (
      <MessagePrimitive.Root data-qa-msg-id={messageId} className="group/message relative mx-auto mb-2 flex w-full max-w-3xl flex-col pb-0.5">
        <EditUserMessageComposer />
      </MessagePrimitive.Root>
    )
  }
  return (
    <MessagePrimitive.Root data-qa-msg-id={messageId} className="group/message relative mx-auto mb-2 flex w-full max-w-3xl flex-col pb-0.5">
      {role === "user" ? <UserMessageBubble /> : null}
      {role === "assistant" ? <AssistantMessageBubble /> : null}
    </MessagePrimitive.Root>
  )
}

function EditUserMessageComposer() {
  return (
    <div className="ml-auto flex w-full max-w-[90%] flex-col">
      <ComposerPrimitive.Root className="rounded-3xl border border-[#e5e5e5] bg-[#f0f0f0] dark:border-[#2a2a2a] dark:bg-[#1a1a1a]">
        <ComposerPrimitive.Input
          className="min-h-14 w-full resize-none bg-transparent px-4 py-3 text-sm text-[#0d0d0d] outline-none dark:text-white"
          autoFocus
        />
        <div className="mb-3 mr-3 flex items-center justify-end gap-2">
          <ComposerPrimitive.Cancel asChild>
            <Button type="button" variant="ghost" size="sm">取消</Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button type="button" size="sm">更新并重跑</Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </div>
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


function UserMessageBubble() {
  return (
    <div className="flex flex-col items-end">
      <UserMessageAttachments />
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
      <div className="mt-1 flex h-8 items-center justify-end gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-focus-within/message:opacity-100 md:group-hover/message:opacity-100">
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

function AssistantPreparingStatus() {
  const hasIntentDone = useAuiState((s) =>
    s.message.parts.some((part) => {
      if (part.type !== "data" || !("name" in part) || part.name !== "intent-route") return false
      const data = part.data
      return typeof data === "object" && data != null && "status" in data && (data as { status?: unknown }).status === "done"
    }),
  )
  // 意图已定 → 进入思考/检索（searching：扫描经线的点阵球）；未定 → 仅呼吸态待命
  return hasIntentDone
    ? <QaPreparing label="正在思考与检索…" state="searching" />
    : <QaPreparing label="准备响应中" state="breathing" />
}

function AssistantMessageBubble() {
  const hasPlanSynced = useAuiState((s) =>
    s.message.parts.some((part) => part.type === "tool-call" && part.toolName === "upsert_plan"),
  )
  return (
    <div className="flex flex-col items-start">
      <div className="w-full max-w-none">
        {hasPlanSynced ? (
          <p className="mb-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <PanelRight className="size-3 opacity-70" aria-hidden />
            计划已同步到侧栏
          </p>
        ) : null}
        <AgentRunPanel />
        <AgentStreamingAnswer />
        <div className="wrap-break-word">
          <MessagePrimitive.Parts>
            {({ part }) => {
              if (part.type === "text") return <AgentAnswerText />
              if (part.type === "tool-call") {
                if (TASK_TOOL_NAMES.has(part.toolName)) return null
                return (
                  <div className="not-prose my-3 empty:my-0 empty:hidden">
                    {part.toolUI ?? <ToolFallback {...part} />}
                  </div>
                )
              }
              // 显式走 dataRendererUI；返回 <></> 抑制 DefaultPartFallback，避免与注册 UI 叠两层
              if (part.type === "data") return part.dataRendererUI ?? <></>
              return null
            }}
          </MessagePrimitive.Parts>
        </div>
        <AgentCitationBar />
        <AuiIf
          condition={(s) =>
            s.thread.isRunning &&
            // 意图芯片只是元信息，不算「已有回答」；无正文/工具/推理/压缩中时仍显示 loading
            !s.message.parts.some((part) => {
              if (part.type === "text" && "text" in part && String(part.text).trim().length > 0) return true
              if (part.type === "tool-call" || part.type === "reasoning") return true
              if (part.type === "data" && "name" in part && part.name === "context-compress") return true
              return false
            })
          }
        >
          <AssistantPreparingStatus />
        </AuiIf>
        <MessagePrimitive.Error>
          <ErrorPrimitive.Root className="mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-destructive text-sm dark:bg-destructive/5 dark:text-red-200">
            <ErrorPrimitive.Message className="line-clamp-2" />
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>
      </div>
      <div className="mt-1 flex h-8 w-full items-center justify-start gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-focus-within/message:opacity-100 md:group-hover/message:opacity-100">
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
  const messageId = useAuiState((s) => s.message.id)
  const isRunning = useAuiState((s) => s.thread.isRunning)
  const textLength = useAuiState((s) => {
    if (s.message.role !== "assistant") return 0
    let len = 0
    for (const part of s.message.content) {
      if (part.type === "text" && typeof part.text === "string") len += part.text.length
    }
    return len
  })
  // assistant-ui converter 用 WeakMap 按 message 对象缓存；timing 后写入时消息身份不变会吃掉 metadata.timing。
  // 这里在组件内自算，保证本轮结束后悬停能看到耗时/速率。
  const trackRef = React.useRef<{
    messageId: string
    startTime: number
    lastContentLength: number
    totalChunks: number
    firstTokenTime?: number
  } | null>(null)
  const [localTiming, setLocalTiming] = React.useState<{
    firstTokenTime?: number
    totalStreamTime: number
    tokensPerSecond?: number
    totalChunks: number
  } | null>(null)

  React.useEffect(() => {
    if (isRunning) {
      if (!trackRef.current || trackRef.current.messageId !== messageId) {
        trackRef.current = {
          messageId,
          startTime: Date.now(),
          lastContentLength: 0,
          totalChunks: 0,
        }
        setLocalTiming(null)
      }
      const track = trackRef.current
      if (textLength > track.lastContentLength) {
        if (track.firstTokenTime === undefined) {
          track.firstTokenTime = Date.now() - track.startTime
        }
        track.totalChunks += 1
        track.lastContentLength = textLength
      }
      return
    }
    if (!trackRef.current || trackRef.current.messageId !== messageId) return
    const track = trackRef.current
    const totalStreamTime = Date.now() - track.startTime
    const tokenCount = Math.ceil(track.lastContentLength / 4)
    setLocalTiming({
      totalStreamTime,
      totalChunks: track.totalChunks,
      ...(track.firstTokenTime !== undefined ? { firstTokenTime: track.firstTokenTime } : {}),
      ...(totalStreamTime > 0 && tokenCount > 0
        ? { tokensPerSecond: tokenCount / (totalStreamTime / 1000) }
        : {}),
    })
    trackRef.current = null
  }, [isRunning, messageId, textLength])

  const persistedTiming = React.useMemo(() => readPersistedTiming(messageMetadata), [messageMetadata])
  const subAgentUsage = React.useMemo(() => readSubAgentUsage(messageMetadata), [messageMetadata])
  const timing = localTiming?.totalStreamTime
    ? localTiming
    : liveTiming?.totalStreamTime
      ? liveTiming
      : persistedTiming
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
      <div className="pointer-events-none absolute top-full right-0 z-10 mt-1 scale-95 rounded-lg border border-[#e5e5e5] bg-white px-3 py-2 opacity-0 shadow-lg transition-[transform,opacity] duration-200 before:absolute before:top-0 before:-left-2 before:hidden before:h-full before:w-2 before:content-[''] group-hover/timing:pointer-events-auto group-hover/timing:scale-100 group-hover/timing:opacity-100 md:top-1/2 md:left-full md:right-auto md:mt-0 md:ml-2 md:-translate-y-1/2 md:before:block dark:border-[#2a2a2a] dark:bg-[#1a1a1a]">
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
