"use client"

import * as React from "react"
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react"
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/react-ai-sdk"
import { ArrowUp, BookOpen, Copy, MessageCircleQuestion, RefreshCw, Square } from "@/components/iconimate"

import { MarkdownText } from "@/components/assistant-ui/markdown-text"
import { ToolFallback } from "@/components/assistant-ui/tool-fallback"
import { RetypesetSiteFooter, RetypesetSiteHeader, RetypesetSiteNav } from "@/features/pages/blog/RetypesetSiteChrome"
import { QaMarkdownScope, QaMarkdownText, QaPreparing, WikiLinkClickProvider } from "@/features/pages/knowledge/QaMarkdown"
import { SignedUrlPublicAccessProvider } from "@/hooks/use-signed-url"
import { publicSiteAppearanceApi, publicWikiApi } from "@/lib/api"
import { PublicQaToolUIs } from "./public-qa-tool-ui"
import { WikiPagePreviewDialog } from "@/components/knowledge/WikiPagePreviewDialog"

const VISITOR_ID_STORAGE_KEY = "petrichor.public-qa.visitor-id"
const VISITOR_ID_HEADER = "X-Petrichor-Visitor-Id"
const QA_MODE_HEADER = "X-Petrichor-Qa-Mode"

/** 公开问答的 Wiki 悬停预览与弹窗都走公开接口（模块级常量保证 loader 引用稳定）。 */
const loadPublicWikiDetail = (pageKey: string) =>
  publicWikiApi.detail(pageKey).then((res) => res.data)

type QaMode = "normal" | "wiki"

/** 读取/生成稳定的 visitor-id（localStorage），作为限流主键。 */
function ensureVisitorId(): string {
  if (typeof window === "undefined") return ""
  try {
    const existing = window.localStorage.getItem(VISITOR_ID_STORAGE_KEY)
    if (existing) return existing
    const next = crypto.randomUUID()
    window.localStorage.setItem(VISITOR_ID_STORAGE_KEY, next)
    return next
  } catch {
    return ""
  }
}

const SUGGESTIONS = [
  { prompt: "这个站点有哪些公开文章？分别讲了什么？" },
  { prompt: "用一段话总结本站公开内容的核心主题。" },
  { prompt: "我想了解作者在某个主题上的观点，帮我找找相关文章。" },
  { prompt: "把相关公开文章的要点整理成一个表格。" },
]

const QA_MODE_OPTIONS: Array<{ key: QaMode; label: string; icon: typeof MessageCircleQuestion }> = [
  { key: "normal", label: "普通问答", icon: MessageCircleQuestion },
  { key: "wiki", label: "Wiki 问答", icon: BookOpen },
]

type Availability = "loading" | "enabled" | "disabled" | "error"

export function PublicQaPage() {
  const [availability, setAvailability] = React.useState<Availability>("loading")

  React.useEffect(() => {
    let canceled = false
    publicSiteAppearanceApi
      .detail()
      .then((res) => {
        if (canceled) return
        setAvailability(res.data.publicQaEnabled ? "enabled" : "disabled")
      })
      .catch(() => {
        if (!canceled) setAvailability("error")
      })
    return () => {
      canceled = true
    }
  }, [])

  return (
    <main className="retypeset-home scrollbar-hide relative flex h-[100dvh] min-h-0 flex-col overflow-hidden bg-[#0044cc] text-white selection:bg-yellow-300 selection:text-blue-950">
      <div className="blog-home-grid pointer-events-none fixed inset-0 z-0" />

      <div className="relative z-30 mx-auto w-full max-w-[51.462rem] px-[min(7.25vw,3.731rem)] pt-8 lg:contents">
        <RetypesetSiteHeader dockVisible />
        <RetypesetSiteNav activeSection="ask" dockVisible />
      </div>

      <section className="relative z-20 mx-auto flex w-full min-h-0 max-w-[51.462rem] flex-1 flex-col px-[min(7.25vw,3.731rem)] py-6 lg:mx-[max(5.75rem,calc(50vw-34.25rem))] lg:max-w-[min(calc(75vw-16rem),44rem)] lg:px-0 lg:py-10">
        {availability === "loading" ? null : availability === "enabled" ? (
          <PublicQaChat />
        ) : availability === "disabled" ? (
          <CenteredHint
            icon={<MessageCircleQuestion className="size-7" />}
            title="问答功能暂未开启"
            text="站长尚未开启前台公开问答，请稍后再来或浏览文章。"
          />
        ) : (
          <CenteredHint
            icon={<MessageCircleQuestion className="size-7" />}
            title="加载失败"
            text="无法获取问答配置，请刷新页面重试。"
          />
        )}
      </section>

      <div className="relative z-30 mx-auto mt-auto w-full max-w-[51.462rem] px-[min(7.25vw,3.731rem)] pb-8 lg:contents">
        <RetypesetSiteFooter dockVisible />
      </div>
    </main>
  )
}

function CenteredHint({
  icon,
  title,
  text,
}: {
  icon?: React.ReactNode
  title?: string
  text: string
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      {icon ? <div className="text-yellow-300">{icon}</div> : null}
      {title ? <p className="text-base font-medium text-white">{title}</p> : null}
      <p className="max-w-sm text-sm text-white/70">{text}</p>
    </div>
  )
}

function PublicQaChat() {
  const visitorId = React.useMemo(() => ensureVisitorId(), [])
  // 模式只影响下一次提问的检索链路（通过请求头告知后端），
  // 用 ref 注入而不是重建 transport，切换时保留当前对话历史。
  const [qaMode, setQaMode] = React.useState<QaMode>("normal")
  const qaModeRef = React.useRef<QaMode>("normal")
  const switchQaMode = React.useCallback((mode: QaMode) => {
    qaModeRef.current = mode
    setQaMode(mode)
  }, [])
  const [wikiPreviewKey, setWikiPreviewKey] = React.useState<string | null>(null)

  const transport = React.useMemo(
    () =>
      new AssistantChatTransport({
        api: "/api/public/qa/chat",
        credentials: "omit",
        fetch: (async (input, init) => {
          const headers = new Headers(init?.headers)
          if (visitorId) headers.set(VISITOR_ID_HEADER, visitorId)
          if (qaModeRef.current === "wiki") headers.set(QA_MODE_HEADER, "wiki")
          const response = await fetch(input, { ...init, headers })
          if (response.ok) return response
          // 非流式错误（限流 / 关闭 / 异常）：后端返回的是 JSON 错误体，
          // 直接交给 AI SDK 会把 {"code":...} 原文当成消息显示。这里提取出
          // 友好的纯文本，替换响应体，让聊天里只出现一句可读的中文提示。
          let message = "问答服务暂时不可用，请稍后重试。"
          try {
            const data = (await response.clone().json()) as { msg?: unknown }
            if (typeof data?.msg === "string" && data.msg.trim()) message = data.msg
          } catch {
            // 非 JSON 错误体则沿用默认文案
          }
          return new Response(message, {
            status: response.status,
            statusText: response.statusText,
            headers: { "content-type": "text/plain; charset=utf-8" },
          })
        }) as typeof fetch,
      }),
    [visitorId],
  )

  const runtime = useChatRuntime({ transport, suggestions: SUGGESTIONS })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* publicAccess：未登录访客的媒体走免鉴权的公开预签名接口，否则图片会卡在「加载中」 */}
      <SignedUrlPublicAccessProvider publicAccess>
        <WikiLinkClickProvider
          onOpenWikiPage={setWikiPreviewKey}
          previewLoader={loadPublicWikiDetail}
        >
          {/* 工具卡片也在 Provider 内，检索结果可以直接点开 Wiki 弹窗 */}
          <PublicQaToolUIs />
          <div className="flex h-full min-h-0 flex-col">
            {/* 不写死 light：前台已统一暗色，强制浅色会让内容变成暗底暗字 */}
            <QaMarkdownScope>
              <PublicQaThread mode={qaMode} onModeChange={switchQaMode} />
            </QaMarkdownScope>
          </div>
        </WikiLinkClickProvider>
        <WikiPagePreviewDialog pageKey={wikiPreviewKey} onClose={() => setWikiPreviewKey(null)} />
      </SignedUrlPublicAccessProvider>
    </AssistantRuntimeProvider>
  )
}

function QaModeSwitch({
  mode,
  onChange,
}: {
  mode: QaMode
  onChange: (mode: QaMode) => void
}) {
  return (
    <div className="mb-3 flex w-fit items-center gap-1 self-center rounded-full border border-white/15 bg-white/5 p-1 backdrop-blur-sm">
      {QA_MODE_OPTIONS.map((option) => {
        const active = option.key === mode
        const Icon = option.icon
        return (
          <button
            key={option.key}
            type="button"
            onClick={() => onChange(option.key)}
            aria-pressed={active}
            className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
              active
                ? "bg-yellow-300 text-blue-950"
                : "text-white/70 hover:bg-white/10 hover:text-white"
            }`}
          >
            <Icon className="size-3.5" />
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

function PublicQaThread({
  mode,
  onModeChange,
}: {
  mode: QaMode
  onModeChange: (mode: QaMode) => void
}) {
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col items-stretch">
      <AuiIf condition={(s) => s.thread.isEmpty}>
        <div className="flex h-full flex-col items-center justify-center">
          <PublicQaComposer placeholder="" />
          <QaModeSwitch mode={mode} onChange={onModeChange} />
          <div className="mt-4 flex w-full max-w-3xl flex-wrap justify-center gap-2 px-2">
            <ThreadPrimitive.Suggestions>{() => <SuggestionChip />}</ThreadPrimitive.Suggestions>
          </div>
        </div>
      </AuiIf>

      <AuiIf condition={(s) => s.thread.isEmpty === false}>
        <ThreadPrimitive.Viewport className="flex grow flex-col overflow-y-auto pt-2 scrollbar-hide">
          <ThreadPrimitive.Messages>{() => <ChatMessage />}</ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
        <div className="mx-auto flex w-full max-w-3xl justify-center">
          <QaModeSwitch mode={mode} onChange={onModeChange} />
        </div>
        <PublicQaComposer placeholder="继续提问…" />
        <p className="mx-auto w-full max-w-3xl pb-1 text-center text-xs text-white/70">
          回答由 AI 生成，仅基于本站公开内容，请自行核验关键信息。
        </p>
      </AuiIf>
    </ThreadPrimitive.Root>
  )
}

function SuggestionChip() {
  return (
    <SuggestionPrimitive.Trigger send asChild>
      <button
        type="button"
        className="h-auto whitespace-normal rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 text-left text-sm font-normal text-white/80 transition-colors hover:bg-white/10 hover:text-white"
      >
        <SuggestionPrimitive.Title />
      </button>
    </SuggestionPrimitive.Trigger>
  )
}

function PublicQaComposer({ placeholder }: { placeholder: string }) {
  const isRunning = useAuiState((s) => s.thread.isRunning)

  return (
    <ComposerPrimitive.Root className="mx-auto mb-3 w-full max-w-3xl">
      <div className="overflow-hidden rounded-[28px] border border-white/15 bg-white/10 backdrop-blur-sm transition-colors focus-within:border-white/35">
        <div className="flex items-end gap-1 p-2">
          <ComposerPrimitive.Input
            id="public-qa-composer-input"
            name="message"
            placeholder={placeholder}
            minRows={1}
            className="my-2 ml-2 h-6 max-h-100 min-w-0 flex-1 resize-none bg-transparent text-base leading-6 text-white outline-none placeholder:text-white/50"
          />
          <div
            className="relative mb-0.5 h-9 w-9 shrink-0 rounded-full"
            style={{ backgroundColor: "var(--retypeset-highlight)", color: "var(--retypeset-primary)" }}
          >
            {isRunning ? (
              <ComposerPrimitive.Cancel
                className="flex h-full w-full items-center justify-center rounded-full transition-opacity hover:opacity-80"
                aria-label="停止"
              >
                <Square className="size-3.5 fill-current" />
              </ComposerPrimitive.Cancel>
            ) : (
              <ComposerPrimitive.Send
                className="flex h-full w-full items-center justify-center rounded-full transition-opacity hover:opacity-80 disabled:opacity-40"
                aria-label="发送"
              >
                <ArrowUp className="size-[18px]" />
              </ComposerPrimitive.Send>
            )}
          </div>
        </div>
      </div>
    </ComposerPrimitive.Root>
  )
}

function ChatMessage() {
  return (
    <MessagePrimitive.Root className="group/message relative mx-auto mb-2 flex w-full max-w-3xl flex-col pb-0.5">
      <AuiIf condition={(s) => s.message.role === "user"}>
        <UserMessageBubble />
      </AuiIf>
      <AuiIf condition={(s) => s.message.role === "assistant"}>
        <AssistantMessageBubble />
      </AuiIf>
    </MessagePrimitive.Root>
  )
}

function UserMessageBubble() {
  return (
    <div className="flex flex-col items-end">
      <div className="relative max-w-[90%] rounded-3xl rounded-br-lg border border-white/15 bg-white/10 px-4 py-3 text-white">
        <div className="prose prose-sm prose-invert wrap-break-word prose-p:my-0">
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
          <ActionBarPrimitive.Copy className="flex h-8 w-8 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white">
            <Copy className="size-4" />
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      </div>
    </div>
  )
}

function AssistantMessageBubble() {
  return (
    <div className="flex w-full items-start gap-3">
      <img
        src="/about-avatar.png"
        alt="助手头像"
        className="mt-0.5 size-8 shrink-0 rounded-full border border-white/15 object-cover"
        loading="lazy"
        decoding="async"
      />
      <div className="flex min-w-0 flex-1 flex-col items-start">
        <div className="w-full max-w-none">
          <AuiIf
            condition={(s) =>
              s.thread.isRunning &&
              !s.message.parts.some(
                (part) =>
                  (part.type === "text" && part.text.trim().length > 0) ||
                  part.type === "tool-call" ||
                  part.type === "reasoning",
              )
            }
          >
            <QaPreparing state="searching" />
          </AuiIf>
          <div className="wrap-break-word text-white/90">
            <MessagePrimitive.Parts>
              {({ part }) => {
                if (part.type === "text") return <QaMarkdownText />
                if (part.type === "tool-call") {
                  return <div className="not-prose my-3">{part.toolUI ?? <ToolFallback {...part} />}</div>
                }
                return null
              }}
            </MessagePrimitive.Parts>
          </div>
          <MessagePrimitive.Error>
            <ErrorPrimitive.Root className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:border-red-400/30 dark:bg-red-500/15 dark:text-red-200">
              <ErrorPrimitive.Message className="line-clamp-3" />
            </ErrorPrimitive.Root>
          </MessagePrimitive.Error>
        </div>
        <div className="mt-1 flex h-8 w-full items-center justify-start gap-0.5 opacity-0 transition-opacity group-focus-within/message:opacity-100 group-hover/message:opacity-100">
          <ActionBarPrimitive.Root className="flex items-center gap-0.5">
            <ActionBarPrimitive.Reload className="flex h-8 w-8 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white">
              <RefreshCw className="size-4" />
            </ActionBarPrimitive.Reload>
            <ActionBarPrimitive.Copy className="flex h-8 w-8 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white">
              <Copy className="size-4" />
            </ActionBarPrimitive.Copy>
          </ActionBarPrimitive.Root>
        </div>
      </div>
    </div>
  )
}
