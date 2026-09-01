"use client"

import {
  ListChecks,
  Loader2,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Trash2,
  TriangleAlert,
  X
} from "@/components/iconimate"
import * as React from "react"
import { toast } from "sonner"

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
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
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
  type AssistantPersistedPlan,
  type AssistantThreadSummary,
  type DocLibrary,
  type KnowledgeBaseQaModelInfo,
  type KnowledgeBaseQaSummary,
  assistantApi,
  docLibraryApi,
  knowledgeBaseQaApi
} from "@/lib/api"
import { gsap } from "@/lib/gsap"

import { hydrateRunsFromMessages } from "@/features/agent-runs/hydrate"
import {
  type AssistantFocusSelection,
  type AssistantUIMessage,
  focusFromThread,
  groupThreadsByRecency,
  resolveApiErrorMessage,
  toInitialMessages
} from "./assistant-message-utils"
import { QaChatPanel } from "./AssistantChatPanel"
import { InfiniteSentinel, ThreadGroup } from "./assistant-thread-list"
import { EmptyHint, LoadingRows } from "./assistant-tool-renders"

const SKIP_DELETE_CONFIRM_KEY = "petrichor:assistant.skipDeleteConfirm"
const THREAD_PAGE_SIZE = 30


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
