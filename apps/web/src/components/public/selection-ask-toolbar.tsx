"use client"

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { ThinkingOrb, type OrbState } from "thinking-orbs"

import { ArrowRight, Check, Copy, Languages, LightbulbIcon } from "@/components/iconimate"
import { useTheme } from "@/components/theme-provider"
import { getVisitorFingerprint } from "@/features/pages/ask/visitor-fingerprint"
import {
  PUBLIC_SELECTION_MAX_CHARS,
  PUBLIC_SELECTION_MAX_QUESTION_CHARS,
  PublicSelectionAskError,
  streamPublicSelectionAsk,
  type PublicSelectionAskQuota,
  type PublicSelectionAskSource,
} from "@/lib/api"
import { cn } from "@/lib/utils"

const EASE = [0.16, 1, 0.3, 1] as const

const SWAP =
  "transition-[opacity,filter,translate] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"

/** 默认态的按钮：进入提问后左移淡出。 */
const OUT = `${SWAP} group-data-ask:pointer-events-none group-data-ask:-translate-x-2 group-data-ask:opacity-0 group-data-ask:blur-[2px]`

/** 输入框：进入提问时淡入，发出问题后让位给问题回显。 */
const IN = `pointer-events-none translate-x-2 opacity-0 blur-[2px] delay-100 ${SWAP} group-data-ask:pointer-events-auto group-data-ask:translate-x-0 group-data-ask:opacity-100 group-data-ask:blur-none group-data-sent:pointer-events-none group-data-sent:-translate-x-2 group-data-sent:opacity-0 group-data-sent:blur-[2px] group-data-sent:delay-0`

const SENT = `pointer-events-none translate-x-2 opacity-0 blur-[2px] delay-100 ${SWAP} group-data-sent:translate-x-0 group-data-sent:opacity-100 group-data-sent:blur-none`

const DEFAULT_QUESTION = "解释这段内容"

const QUICK_ACTIONS = [
  { name: "解释", question: DEFAULT_QUESTION, icon: LightbulbIcon },
  { name: "翻译", question: "翻译这段内容：原文是中文就译成英文，否则译成中文", icon: Languages },
] as const

const STAGES = {
  reading: { label: "正在阅读上下文…", orb: "listening" },
  composing: { label: "正在组织回答…", orb: "composing" },
} as const satisfies Record<string, { label: string; orb: OrbState }>

/** 首字迟迟未到时换成第二句提示（毫秒）。 */
const COMPOSING_AFTER = 1800

type Status = "idle" | "loading" | "answering" | "done" | "error"

type AskError = { message: string; retryable: boolean }

/** 回答复用文章 AI 总结的 Markdown 渲染链；首次进入提问时才加载。 */
const loadAnswerModule = () => import("@/features/pages/knowledge/QaMarkdown")

const LazyAnswerMarkdown = React.lazy(async () => {
  const module = await loadAnswerModule()
  return {
    default: function SelectionAnswerMarkdown({ text, running }: { text: string; running: boolean }) {
      return (
        <module.QaMarkdownScope>
          <module.QaStreamingMarkdown text={text} running={running} />
        </module.QaMarkdownScope>
      )
    },
  }
})

function toAskError(error: unknown): AskError {
  if (error instanceof PublicSelectionAskError) {
    // 限流、关闭、无权访问重试也不会成功，只给换问题的出口。
    return { message: error.message, retryable: error.status >= 500 }
  }
  return { message: "网络异常，请稍后再试", retryable: true }
}

export function SelectionAskToolbar({
  source,
  text,
  askMode,
  panelWidth,
  onAsk,
}: {
  source: PublicSelectionAskSource
  /** 选中的文字 */
  text: string
  askMode: boolean
  /** 展开成输入框后的宽度 */
  panelWidth: number
  onAsk: () => void
}) {
  const input = React.useRef<HTMLInputElement>(null)
  const panel = React.useRef<HTMLDivElement>(null)
  const abort = React.useRef<AbortController | null>(null)
  const reduceMotion = useReducedMotion() ?? false
  const orbTheme = useTheme().resolvedTheme === "dark" ? "dark" : "light"

  const [query, setQuery] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<Status>("idle")
  const [stage, setStage] = React.useState<keyof typeof STAGES>("reading")
  const [answer, setAnswer] = React.useState("")
  const [error, setError] = React.useState<AskError | null>(null)
  const [quota, setQuota] = React.useState<PublicSelectionAskQuota | null>(null)
  const [copied, setCopied] = React.useState(false)
  const [height, setHeight] = React.useState(0)

  React.useEffect(() => {
    const element = panel.current
    if (!element) return
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // 工具栏关闭即放弃进行中的回答。
  React.useEffect(() => () => abort.current?.abort(), [])

  // 进入提问就预取指纹与回答渲染器，发送时不用再等。
  React.useEffect(() => {
    if (!askMode) return
    void getVisitorFingerprint()
    void loadAnswerModule()
  }, [askMode])

  // 输入框容器在提问态之前是 inert 的，必须等这次渲染提交后再聚焦；快捷操作直接发问，不抢焦点。
  React.useEffect(() => {
    if (askMode && query === null) input.current?.focus({ preventScroll: true })
  }, [askMode, query])

  React.useEffect(() => {
    if (status !== "loading") return
    const timer = window.setTimeout(() => setStage("composing"), COMPOSING_AFTER)
    return () => window.clearTimeout(timer)
  }, [status])

  const run = async (question: string) => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setQuery(question)
    setStatus("loading")
    setStage("reading")
    setAnswer("")
    setError(null)
    try {
      const fingerprint = await getVisitorFingerprint()
      const nextQuota = await streamPublicSelectionAsk(
        { source, selection: text.slice(0, PUBLIC_SELECTION_MAX_CHARS), question },
        {
          fingerprint,
          signal: controller.signal,
          onDelta: (delta) => {
            setStatus("answering")
            setAnswer((current) => current + delta)
          },
        },
      )
      if (controller.signal.aborted) return
      setQuota(nextQuota)
      setStatus("done")
    } catch (caught) {
      if (controller.signal.aborted) return
      setError(toAskError(caught))
      setStatus("error")
    }
  }

  const submit = () => {
    if (query) return
    input.current?.blur()
    void run(input.current?.value.trim() || DEFAULT_QUESTION)
  }

  const askAgain = () => {
    abort.current?.abort()
    setQuery(null)
    setStatus("idle")
    setAnswer("")
    setError(null)
    if (input.current) input.current.value = ""
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板被拒绝时不打扰，访客仍可用系统复制
    }
  }

  const sent = query !== null

  return (
    <motion.div
      role="toolbar"
      aria-label="划词工具"
      data-selection-ask-toolbar
      data-ask={askMode ? "" : undefined}
      data-sent={sent ? "" : undefined}
      initial={false}
      animate={{ width: askMode ? panelWidth : "auto" }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.3, ease: EASE }}
      // 点按钮不能抢走正文选区；输入框和回答区照常可点、可选字。
      onMouseDown={(event) => {
        if (!(event.target instanceof Element && event.target.closest("input, [data-selection-ask-answer]"))) {
          event.preventDefault()
        }
      }}
      className="group flex flex-col overflow-hidden rounded-xl border border-border bg-popover whitespace-nowrap text-muted-foreground shadow-lg"
    >
      <div className="relative flex items-center gap-1 p-1.5">
        <button
          type="button"
          tabIndex={askMode ? -1 : undefined}
          onClick={() => {
            if (!askMode) onAsk()
          }}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg pr-2.5 pl-1.5 text-sm font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40 group-data-ask:hover:bg-transparent"
        >
          <ThinkingOrb state="breathing" size={20} theme={orbTheme} paused={!askMode || reduceMotion} aria-hidden className="size-5 shrink-0" />
          <span className={OUT}>问 AI</span>
        </button>

        <div className={cn("mx-1 h-5 w-px shrink-0 bg-border", OUT)} />

        {QUICK_ACTIONS.map(({ name, question, icon: Icon }) => (
          <button
            key={name}
            type="button"
            aria-label={name}
            title={name}
            inert={askMode}
            onClick={() => {
              onAsk()
              void run(question)
            }}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
              OUT,
            )}
          >
            <Icon className="size-[1.125rem]" aria-hidden />
          </button>
        ))}

        <button
          type="button"
          aria-label={copied ? "已复制" : "复制"}
          title={copied ? "已复制" : "复制"}
          inert={askMode}
          onClick={() => void copy()}
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
            OUT,
          )}
        >
          {copied ? <Check className="size-[1.125rem]" aria-hidden /> : <Copy className="size-[1.125rem]" aria-hidden />}
        </button>

        <div inert={!askMode || sent} className={cn("absolute inset-y-1.5 right-1.5 left-10 flex items-center gap-1", IN)}>
          <input
            ref={input}
            type="text"
            aria-label="就选中的内容提问"
            placeholder="问点什么，回车发送…"
            maxLength={PUBLIC_SELECTION_MAX_QUESTION_CHARS}
            // 输入法组词时的回车只是上屏，不能当作发送。
            onKeyDown={(event) => event.key === "Enter" && !event.nativeEvent.isComposing && submit()}
            className="h-8 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            aria-label="发送"
            onClick={submit}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <ArrowRight className="size-4" aria-hidden />
          </button>
        </div>

        <div
          className={cn(
            "absolute inset-y-1.5 right-3 left-10 flex items-center overflow-hidden text-sm font-medium text-foreground",
            SENT,
          )}
        >
          <span className="truncate">{query}</span>
        </div>
      </div>

      <motion.div
        initial={{ height: 0 }}
        animate={{ height }}
        transition={reduceMotion ? { duration: 0 } : { duration: 0.3, ease: EASE }}
        className="overflow-hidden"
      >
        <div ref={panel} className="relative">
          <AnimatePresence mode="popLayout" initial={false}>
            {status === "loading" ? (
              <motion.div
                key="loading"
                role="status"
                initial={{ opacity: 0, y: 4, filter: "blur(2px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -4, filter: "blur(4px)" }}
                transition={{ duration: 0.25, ease: EASE }}
                className="flex items-center gap-2 border-t border-border bg-muted/50 px-3 py-2.5"
              >
                <ThinkingOrb
                  key={STAGES[stage].orb}
                  state={STAGES[stage].orb}
                  size={20}
                  theme={orbTheme}
                  paused={reduceMotion}
                  aria-hidden
                  className="shrink-0"
                />
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={stage}
                    initial={{ opacity: 0, y: 6, filter: "blur(2px)" }}
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    exit={{ opacity: 0, y: -6, filter: "blur(2px)" }}
                    transition={{ duration: 0.15, ease: EASE }}
                    className="shimmer inline-block text-sm motion-reduce:animate-none"
                  >
                    {STAGES[stage].label}
                  </motion.span>
                </AnimatePresence>
              </motion.div>
            ) : null}

            {status === "answering" || status === "done" ? (
              <motion.div
                key="answer"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.2, ease: EASE }}
                className="border-t border-border bg-muted/50 whitespace-normal"
              >
                <div
                  data-selection-ask-answer
                  aria-live="polite"
                  className="max-h-64 min-h-[41px] overflow-y-auto overscroll-contain px-3.5 py-3 text-[15px] leading-relaxed text-foreground select-text"
                >
                  {answer ? (
                    <React.Suspense fallback={<p className="whitespace-pre-wrap">{answer}</p>}>
                      <LazyAnswerMarkdown text={answer} running={status === "answering"} />
                    </React.Suspense>
                  ) : (
                    <p className="text-sm text-muted-foreground">没有得到回答，换个问法再试试。</p>
                  )}
                </div>
                {status === "done" ? (
                  <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3.5 py-1.5 text-xs">
                    <span className="truncate">
                      AI 生成，仅供参考{quota ? ` · 本小时还可问 ${quota.remaining} 次` : ""}
                    </span>
                    <button
                      type="button"
                      onClick={askAgain}
                      className="shrink-0 rounded-md px-1.5 py-1 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
                    >
                      再问一个
                    </button>
                  </div>
                ) : null}
              </motion.div>
            ) : null}

            {status === "error" && error ? (
              <motion.div
                key="error"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, ease: EASE }}
                className="flex items-center justify-between gap-2 border-t border-border bg-muted/50 px-3.5 py-2.5 whitespace-normal"
              >
                <p role="alert" className="min-w-0 text-sm text-destructive">{error.message}</p>
                <div className="flex shrink-0 gap-1 text-xs">
                  {error.retryable && query ? (
                    <button
                      type="button"
                      onClick={() => void run(query)}
                      className="rounded-md px-1.5 py-1 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
                    >
                      重试
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={askAgain}
                    className="rounded-md px-1.5 py-1 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    换个问题
                  </button>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  )
}
