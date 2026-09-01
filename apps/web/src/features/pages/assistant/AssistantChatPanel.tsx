"use client"

import {
  Copy,
  PanelRight,
  Pencil,
  RefreshCw
} from "@/components/iconimate"
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
import * as React from "react"
import { toast } from "sonner"

import { UserMessageAttachments } from "@/components/assistant-ui/attachment"
import { MarkdownText } from "@/components/assistant-ui/markdown-text"
import { WikiPagePreviewDialog } from "@/components/knowledge/WikiPagePreviewDialog"
import { Button } from "@/components/ui/button"
import { AssistantTaskRail, TASK_TOOL_NAMES } from "@/features/pages/assistant/AssistantTaskRail"
import {
  QaMarkdownScope,
  QaPreparing,
  WikiLinkClickProvider,
} from "@/features/pages/knowledge/QaMarkdown"
import {
  type AssistantPersistedPlan,
  type DocLibrary,
  type KnowledgeBaseQaModelInfo,
  type KnowledgeBaseQaSummary,
  assistantWikiApi
} from "@/lib/api"
import { dashboardRoutes } from "@/lib/dashboard-routes"
import { isDemoMode } from "@/lib/demo/demo-mode"

import { consumePendingRetryRunId, useAgentRunsStore } from "@/features/agent-runs/store"
import { shouldShowExecutionPanel } from "@/features/agent-runs/types"
import {
  AgentAnswerText,
  AgentCitationBar,
  AgentRunPanel,
  AgentStreamingAnswer,
  useCurrentAgentRun,
} from "./agent-run-ui"
import { GrokComposer } from "./assistant-composer"
import {
  type AssistantFocusSelection,
  type AssistantUIMessage,
  focusToRequestBody,
  formatCompactTokens,
  formatStreamMs,
  formatStreamTime,
  readPersistedTiming,
  readSubAgentUsage
} from "./assistant-message-utils"
import { QaThreadToc } from "./assistant-toc"
import { AssistantToolUIs } from "./assistant-tool-ui-mounts"

const CHAT_THREAD_HEADER = "X-Petrichor-Assistant-Thread-Id"

export function QaChatPanel({
  focusSelection,
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
      fetch: (async (input, init) => {
        const currentConfigId = selectedConfigId
        let nextInit = init
        if (init && typeof init.body === "string") {
          try {
            const parsed = JSON.parse(init.body)
            if (parsed && typeof parsed === "object") {
              parsed.focus = focusBody
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
    }) as typeof fetch,
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
      {/* 工具卡片与消息渲染都在 Provider 内：回答和检索结果里的 Wiki 引用可点开弹窗；
          previewLoader 让回答里的内链悬停出预览小卡（聚焦知识库时带 kbId 消歧） */}
      <WikiLinkClickProvider onOpenWikiPage={setWikiPreviewKey} previewLoader={loadWikiDetail}>
        <AssistantToolUIs />
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

/**
 * 开跑到第一条执行轨迹之间的占位状态。
 *
 * 全程只允许有一个"正在…"在屏幕上。执行轨迹一出现就让位——轨迹行自带状态点和
 * 当前活动文案，两个一起就是两行几乎一样的话。
 *
 * 之所以会撞上，是两边信号源不同：轨迹读 Run Store 的 tool_started（工具一开始
 * 就到），而本组件外层的门是消息里的 tool-call part（要等工具执行完才发），
 * 工具执行中的那几秒两个条件同时成立。
 */
function AssistantPreparingStatus() {
  const run = useCurrentAgentRun()
  if (shouldShowExecutionPanel(run)) return null
  return <QaPreparing label="准备响应中" state="connecting" />
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
                // 没有专用卡片的工具不在正文里露出：泛用的「已使用工具: xxx」
                // 只是内部实现细节，执行过程由上面的运行面板负责展示。
                if (!part.toolUI) return null
                return (
                  <div className="not-prose my-3 empty:my-0 empty:hidden">
                    {part.toolUI}
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
              // 压缩结束后这个 part 仍在（status=done，原位覆盖），只有 running 才算"已有状态在显示"
              if (part.type === "data" && "name" in part && part.name === "context-compress") {
                const data = part.data
                return typeof data === "object" && data != null
                  && (data as { status?: unknown }).status === "running"
              }
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
