"use client"

import * as React from "react"
import { AssistantRuntimeProvider, AuiIf, ThreadPrimitive, useAuiState } from "@assistant-ui/react"
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/react-ai-sdk"
import { History, MessageSquarePlus } from "@/components/iconimate"

import { EvidenceHrefProvider, type EvidenceHrefResolver } from "@/components/agent"
import { WikiPagePreviewDialog } from "@/components/knowledge/WikiPagePreviewDialog"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useAgentRunsStore } from "@/features/agent-runs/store"
import { GrokComposer } from "@/features/pages/assistant/assistant-composer"
import { AssistantChatMessage } from "@/features/pages/assistant/assistant-messages"
import {
  type AssistantFocusSelection,
  type AssistantUIMessage,
  groupThreadsByRecency,
} from "@/features/pages/assistant/assistant-message-utils"
import { ThreadGroup } from "@/features/pages/assistant/assistant-thread-list"
import { AssistantToolUIs } from "@/features/pages/assistant/assistant-tool-ui-mounts"
import { AssistantWelcomeComposer } from "@/features/pages/assistant/assistant-welcome"
import { QaMarkdownScope, WikiLinkClickProvider } from "@/features/pages/knowledge/QaMarkdown"
import { SignedUrlPublicAccessProvider } from "@/hooks/use-signed-url"
import { publicQaApi, publicWikiApi, type AssistantThreadSummary, type PublicQaScope } from "@/lib/api"
import { isDemoMode } from "@/lib/demo/demo-mode"
import { cn } from "@/lib/utils"
import {
  deletePublicQaThread,
  listPublicQaThreads,
  loadPublicQaThread,
  restoreRunsFromMessages,
  savePublicQaThread,
} from "./public-qa-history"
import { PublicQaToc } from "./public-qa-toc"
import { FINGERPRINT_HEADER, getVisitorFingerprint } from "./visitor-fingerprint"

/** 公开问答的 Wiki 悬停预览与弹窗走公开接口（模块级常量保证 loader 引用稳定）。 */
const loadPublicWikiDetail = (pageKey: string) => publicWikiApi.detail(pageKey).then((res) => res.data)

/** 访客只能跳转到公开文章与公开 Wiki，后台地址一律不生成链接。 */
const publicEvidenceHref: EvidenceHrefResolver = (evidence) => {
  const url = evidence.url?.trim()
  return url && (url.startsWith("/p/") || url.startsWith("/wiki/")) ? url : null
}


type ActiveThread = {
  id: string
  messages: AssistantUIMessage[]
  knowledgeBaseId: string | null
}

function draftThread(knowledgeBaseId: string | null): ActiveThread {
  return { id: crypto.randomUUID(), messages: [], knowledgeBaseId }
}

/** 前台问答：与后台助手同一套消息、执行面板与输入框；历史只存在访客浏览器。 */
export function PublicQaChat() {
  const [threads, setThreads] = React.useState<AssistantThreadSummary[]>(() => listPublicQaThreads())
  const [active, setActive] = React.useState<ActiveThread>(() => draftThread(null))
  const [scopes, setScopes] = React.useState<PublicQaScope[]>([])

  React.useEffect(() => {
    const controller = new AbortController()
    publicQaApi.scopes(controller.signal)
      .then((res) => setScopes(res.data.items))
      .catch(() => {
        // 范围列表不可用时仍可问「全部公开资料」。
      })
    return () => controller.abort()
  }, [])

  const openThread = React.useCallback((id: string) => {
    const record = loadPublicQaThread(id)
    if (!record) {
      setThreads(listPublicQaThreads())
      return
    }
    restoreRunsFromMessages(record.messages)
    setActive({ id: record.id, messages: record.messages, knowledgeBaseId: record.knowledgeBaseId })
  }, [])

  const deleteThread = React.useCallback((thread: AssistantThreadSummary) => {
    deletePublicQaThread(thread.id)
    setThreads(listPublicQaThreads())
    setActive((current) => (current.id === thread.id ? draftThread(current.knowledgeBaseId) : current))
  }, [])

  const settle = React.useCallback((threadId: string, knowledgeBaseId: string | null, messages: AssistantUIMessage[]) => {
    savePublicQaThread({ id: threadId, knowledgeBaseId, messages })
    setThreads(listPublicQaThreads())
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PublicQaThreadRuntime
        key={active.id}
        thread={active}
        scopes={scopes}
        onKnowledgeBaseChange={(knowledgeBaseId) => setActive((current) => ({ ...current, knowledgeBaseId }))}
        onSettled={settle}
        toolbar={
          <PublicQaToolbar
            threads={threads}
            activeThreadId={active.id}
            onSelect={openThread}
            onDelete={deleteThread}
            onNewThread={() => setActive(draftThread(active.knowledgeBaseId))}
          />
        }
      />
    </div>
  )
}

/** 工具栏里的对话大纲读取线程状态，因此必须渲染在 AssistantRuntimeProvider 内。 */
function PublicQaToolbar({
  threads,
  activeThreadId,
  onSelect,
  onDelete,
  onNewThread,
}: {
  threads: AssistantThreadSummary[]
  activeThreadId: string
  onSelect: (id: string) => void
  onDelete: (thread: AssistantThreadSummary) => void
  onNewThread: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const groups = React.useMemo(() => groupThreadsByRecency(threads).groups, [threads])
  return (
    <header aria-label="对话操作" className="mx-auto flex h-12 w-full max-w-3xl shrink-0 items-center justify-end gap-1 px-1">
      <PublicQaToc />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="h-9 gap-1.5 rounded-lg text-muted-foreground hover:text-foreground">
            <History className="size-4" aria-hidden />
            历史对话
            {threads.length > 0 ? <span className="font-mono text-[11px] tabular-nums opacity-70">{threads.length}</span> : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} className="w-[min(320px,calc(100vw-2rem))] p-0">
          <div className="border-b px-3 py-2 text-xs text-muted-foreground">历史只保存在当前浏览器</div>
          <div className="max-h-[min(420px,60vh)] overflow-y-auto py-2">
            {groups.length > 0 ? groups.map((group) => (
              <ThreadGroup
                key={group.key}
                label={group.label}
                threads={group.threads}
                activeThreadId={activeThreadId}
                onSelect={(id) => {
                  onSelect(id)
                  setOpen(false)
                }}
                onDelete={onDelete}
                manageMode={false}
                selectedIds={new Set()}
                onToggleSelect={() => undefined}
              />
            )) : (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">还没有历史对话</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-9 rounded-lg text-muted-foreground hover:text-foreground"
        aria-label="新建对话"
        title="新建对话"
        onClick={onNewThread}
      >
        <MessageSquarePlus className="size-4" aria-hidden />
      </Button>
    </header>
  )
}

function PublicQaThreadRuntime({
  thread,
  scopes,
  onKnowledgeBaseChange,
  onSettled,
  toolbar,
}: {
  thread: ActiveThread
  scopes: PublicQaScope[]
  onKnowledgeBaseChange: (knowledgeBaseId: string | null) => void
  onSettled: (threadId: string, knowledgeBaseId: string | null, messages: AssistantUIMessage[]) => void
  toolbar: React.ReactNode
}) {
  const [wikiPreviewKey, setWikiPreviewKey] = React.useState<string | null>(null)
  // 进入对话即预取指纹，首问不必等待采集。
  React.useEffect(() => {
    if (!isDemoMode()) void getVisitorFingerprint()
  }, [])
  // 请求体里的范围读最新值：同一对话中途切换范围后，下一问立即生效。
  const focusRef = React.useRef(thread.knowledgeBaseId)
  focusRef.current = thread.knowledgeBaseId
  const settledRef = React.useRef(onSettled)
  settledRef.current = onSettled

  const transport = React.useMemo(() => new AssistantChatTransport<AssistantUIMessage>({
    api: "/api/public/qa/chat",
    credentials: "omit",
    fetch: (async (input, init) => {
      let nextInit = init
      if (init && typeof init.body === "string") {
        try {
          const parsed: unknown = JSON.parse(init.body)
          if (parsed && typeof parsed === "object") {
            const knowledgeBaseId = focusRef.current
            nextInit = { ...init, body: JSON.stringify({ ...parsed, focus: knowledgeBaseId ? { knowledgeBaseId } : null }) }
          }
        } catch {
          // 非 JSON body 保持原样
        }
      }
      if (isDemoMode()) {
        // 演示模式不触网：复用后台助手的脚本化 Agent 事件回放。
        const { demoAssistantChatResponse } = await import("@/lib/demo/demo-chat")
        return demoAssistantChatResponse(nextInit)
      }
      const headers = new Headers(nextInit?.headers)
      const fingerprint = await getVisitorFingerprint()
      if (fingerprint) headers.set(FINGERPRINT_HEADER, fingerprint)
      const response = await fetch(input, { ...nextInit, headers })
      if (response.ok) return response
      // 流开始前的错误（关闭、限流、参数）是 JSON；转成一句可读提示交给消息错误区显示。
      let message = "问答服务暂时不可用，请稍后重试。"
      try {
        const data = (await response.clone().json()) as { msg?: unknown }
        if (typeof data?.msg === "string" && data.msg.trim()) message = data.msg
      } catch {
        // 非 JSON 错误体沿用默认文案
      }
      return new Response(message, {
        status: response.status,
        statusText: response.statusText,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }) as typeof fetch,
  }), [])

  const runtime = useChatRuntime({
    id: thread.id,
    messages: thread.messages,
    transport,
    // 与后台一致：Agent 事件直接从流里消费，reducer 按 sequence 幂等去重。
    onData: (part) => {
      if (part.type === "data-agent-event") useAgentRunsStore.getState().appendUnknown(part.data)
    },
    onFinish: ({ messages }) => {
      settledRef.current(thread.id, focusRef.current, messages)
    },
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* publicAccess：未登录访客的媒体走免鉴权的公开预签名接口 */}
      <SignedUrlPublicAccessProvider publicAccess>
        <EvidenceHrefProvider value={publicEvidenceHref}>
          <WikiLinkClickProvider onOpenWikiPage={setWikiPreviewKey} previewLoader={loadPublicWikiDetail}>
            <AssistantToolUIs />
            <QaMarkdownScope>
              {/* QaMarkdownScope 外层是 block 的 antd App，flex-1 不生效；用 h-full 接住高度，消息区才能在内部滚动。 */}
              <div className="flex h-full min-h-0 flex-col">
                {toolbar}
                <div className="min-h-0 flex-1">
                  <PublicQaThread
                    scopes={scopes}
                    knowledgeBaseId={thread.knowledgeBaseId}
                    onKnowledgeBaseChange={onKnowledgeBaseChange}
                  />
                </div>
              </div>
            </QaMarkdownScope>
          </WikiLinkClickProvider>
          <WikiPagePreviewDialog pageKey={wikiPreviewKey} onClose={() => setWikiPreviewKey(null)} />
        </EvidenceHrefProvider>
      </SignedUrlPublicAccessProvider>
    </AssistantRuntimeProvider>
  )
}

function PublicQaThread({
  scopes,
  knowledgeBaseId,
  onKnowledgeBaseChange,
}: {
  scopes: PublicQaScope[]
  knowledgeBaseId: string | null
  onKnowledgeBaseChange: (knowledgeBaseId: string | null) => void
}) {
  const isEmpty = useAuiState((s) => s.thread.isEmpty)
  const knowledgeBases = React.useMemo(
    () => scopes.map((scope) => ({ id: scope.knowledgeBaseId, name: scope.name })),
    [scopes],
  )
  const scopeName = knowledgeBaseId
    ? scopes.find((scope) => scope.knowledgeBaseId === knowledgeBaseId)?.name ?? "当前知识库"
    : null
  const focusSelection: AssistantFocusSelection = knowledgeBaseId
    ? { kind: "knowledge", knowledgeBaseId }
    : { kind: "none" }

  return (
    // 前台与文章页一致隐藏滚动条，定位交给右侧对话大纲。
    <ThreadPrimitive.Root className={cn("relative flex h-full min-h-0 flex-col items-stretch", isEmpty && "scrollbar-hide overflow-y-auto")}>
      <AuiIf condition={(s) => s.thread.isEmpty === false}>
        <ThreadPrimitive.Viewport className="qa-thread-viewport scrollbar-hide flex min-h-0 grow flex-col overflow-y-auto pt-3">
          <ThreadPrimitive.Messages>
            {() => <AssistantChatMessage />}
          </ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
      </AuiIf>
      <AssistantWelcomeComposer
        isEmpty={isEmpty}
        scopeName={scopeName}
        description="从一个问题开始，在本站公开文章与 Wiki 里找到答案和出处。"
      >
        <GrokComposer
          placeholder={isEmpty ? "输入你的问题..." : "继续提问..."}
          knowledgeBases={knowledgeBases}
          docLibraries={[]}
          focusSelection={focusSelection}
          onFocusChange={(next) => onKnowledgeBaseChange(next.kind === "knowledge" ? next.knowledgeBaseId : null)}
          scopeLabel={scopeName ?? "全部公开资料"}
          allScopeLabel="全部公开资料"
          modelInfo={null}
          selectedConfigId={null}
          onConfigChange={() => undefined}
          allowAttachments={false}
        />
      </AssistantWelcomeComposer>
      <AuiIf condition={(s) => s.thread.isEmpty === false}>
        <p className="mx-auto w-full max-w-3xl pb-2 text-center text-xs text-muted-foreground">
          回答由 AI 生成，仅基于本站公开内容，请自行核验关键信息。
        </p>
      </AuiIf>
    </ThreadPrimitive.Root>
  )
}
