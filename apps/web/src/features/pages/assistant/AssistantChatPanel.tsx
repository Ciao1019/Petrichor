"use client"

import {
  AssistantRuntimeProvider,
  AuiIf,
  CompositeAttachmentAdapter,
  SimpleImageAttachmentAdapter,
  SimpleTextAttachmentAdapter,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react"
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk"
import * as React from "react"
import { toast } from "sonner"

import { WikiPagePreviewDialog } from "@/components/knowledge/WikiPagePreviewDialog"
import { AssistantTaskRail } from "@/features/pages/assistant/AssistantTaskRail"
import {
  QaMarkdownScope,
  WikiLinkClickProvider,
} from "@/features/pages/knowledge/QaMarkdown"
import {
  type AssistantPersistedPlan,
  type DocLibrary,
  type KnowledgeBaseQaModelInfo,
  type KnowledgeBaseQaSummary,
  assistantWikiApi
} from "@/lib/api"
import { isDemoMode } from "@/lib/demo/demo-mode"
import { cn } from "@/lib/utils"

import { consumePendingRetryRunId, useAgentRunsStore } from "@/features/agent-runs/store"
import { GrokComposer } from "./assistant-composer"
import { AssistantChatMessage } from "./assistant-messages"
import { AssistantWelcomeComposer } from "./assistant-welcome"
import {
  type AssistantFocusSelection,
  type AssistantUIMessage,
  focusToRequestBody,
} from "./assistant-message-utils"
import { QaThreadToc } from "./assistant-toc"
import { AssistantToolUIs } from "./assistant-tool-ui-mounts"
import { AssistantRunControls } from "./assistant-run-controls"
import { AssistantResumeContext, createResumeRequest } from "./assistant-run-control-context"

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
  const [resumeRequest] = React.useState(createResumeRequest)
  // 切换对话后，旧请求返回的 threadId 不再改变主区的当前对话。
  const mountedRef = React.useRef(true)
  React.useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
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
              if (resumeRequest.consume()) parsed.resume = true
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
        if (demoThreadId && mountedRef.current) onThreadKnown(demoThreadId)
        return demoResponse
      }
      const response = await fetch(input, nextInit)
      if (response.status === 401 && typeof window !== "undefined") {
        const redirect = encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)
        window.location.replace(`/login?redirect=${redirect}`)
      }
      if (response.status === 409 && typeof window !== "undefined") {
        const failure = await response.clone().json().catch(() => null) as { msg?: string } | null
        toast.error(failure?.msg ?? "暂时无法启动任务")
      }
      const remoteThreadId = response.headers.get(CHAT_THREAD_HEADER)
      if (remoteThreadId && mountedRef.current) {
        onThreadKnown(remoteThreadId)
      }
      return response
    }) as typeof fetch,
  }), [focusBody, onThreadKnown, selectedConfigId, threadId, resumeRequest])

  const runtime = useChatRuntime({
    id: threadId ?? `assistant-${focusSelection.kind}-draft`,
    messages: initialMessages,
    transport,
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
      <AssistantResumeContext.Provider value={() => {
        resumeRequest.request()
        runtime.thread.append("从上次检查点继续")
      }}>
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
      </AssistantResumeContext.Provider>
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
  const isEmpty = useAuiState((s) => s.thread.isEmpty)
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
      className={cn("relative flex h-full min-h-0 flex-col items-stretch bg-[#fdfdfd] px-3 dark:bg-[#141414] md:px-4", isEmpty && "overflow-y-auto")}
    >
      <AuiIf condition={(s) => s.thread.isEmpty === false}>
        <ThreadPrimitive.Viewport className="qa-thread-viewport flex min-h-0 grow flex-col overflow-y-auto pt-3">
          <ThreadPrimitive.Messages>
            {() => <AssistantChatMessage />}
          </ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
        <AssistantTaskRail
          persistedPlans={persistedPlans}
          threadId={threadId}
          onPlanPatched={onPlanPatched}
        />
        <QaThreadToc />
      </AuiIf>
      <AssistantWelcomeComposer isEmpty={isEmpty} scopeName={scopeName}>
        <AssistantRunControls key={threadId} threadId={threadId} />
        <GrokComposer
          placeholder={isEmpty ? "输入你的问题..." : "继续提问..."}
          {...composerProps}
        />
      </AssistantWelcomeComposer>
      <AuiIf condition={(s) => s.thread.isEmpty === false}>
        <p className="mx-auto w-full max-w-3xl pb-2 text-center text-[#9a9a9a] text-xs">
          回答由 AI 生成，请自行核验关键信息。
        </p>
      </AuiIf>
    </ThreadPrimitive.Root>
  )
}
