"use client"

import * as React from "react"
import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  useAuiState,
  useMessageTiming,
} from "@assistant-ui/react"
import { Copy, PanelRight, Pencil, RefreshCw } from "@/components/iconimate"

import { UserMessageAttachments } from "@/components/assistant-ui/attachment"
import { MarkdownText } from "@/components/assistant-ui/markdown-text"
import { Button } from "@/components/ui/button"
import { TASK_TOOL_NAMES } from "@/features/pages/assistant/AssistantTaskRail"

import {
  AgentAnswerText,
  AgentCitationBar,
  AgentRunPanel,
  AgentStreamingAnswer,
  AssistantPreparingStatus,
} from "./agent-run-ui"
import {
  formatCompactTokens,
  formatStreamMs,
  formatStreamTime,
  readPersistedTiming,
  readSubAgentUsage,
} from "./assistant-message-utils"

/**
 * 助手消息渲染：后台助手与前台公开问答共用同一套气泡、执行面板、引用条与操作栏，
 * 两端的交互因此保持一致；差异只在外层的运行时与可用能力。
 */
export function AssistantChatMessage() {
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
