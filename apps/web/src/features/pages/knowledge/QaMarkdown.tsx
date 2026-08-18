"use client"

import * as React from "react"
import { useMessagePartText } from "@assistant-ui/react"
import { Markdown, remarkVideo, ThemeProvider, type MarkdownProps } from "@lobehub/ui"
import { ThinkingOrb, type OrbState } from "thinking-orbs"

import { useTheme } from "@/components/theme-provider"
import { AgentCitationMark } from "@/components/agent/agent-citation-mark"
import { remarkCitations } from "@/features/agent-runs/remark-citations"
import {
  SignedMarkdownImage,
  storageMarkdownUrlTransform,
} from "@/components/assistant-ui/signed-markdown-image"
import {
  remarkStripDanglingMediaTags,
  SignedMarkdownAudio,
  SignedMarkdownFile,
  SignedMarkdownVideo,
} from "@/components/assistant-ui/signed-markdown-media"

const QA_REACT_MARKDOWN_PROPS = {
  urlTransform: storageMarkdownUrlTransform,
}
// LobeHub 默认已用 remarkVideo 处理 <video>；这里再补上 <audio>/<file>，
// 把它们从原始 HTML 节点转成可渲染元素（无需开启 allowHtml）。
const QA_REMARK_PLUGINS: NonNullable<MarkdownProps["remarkPlugins"]> = [
  [remarkVideo, { videoTags: ["audio", "file"] }],
  remarkStripDanglingMediaTags,
  // 正文里的 [n] 转成可交互引用角标；无对应证据时组件会退回纯文本
  remarkCitations,
]
const QA_MARKDOWN_COMPONENTS: NonNullable<MarkdownProps["components"]> = {
  citation: AgentCitationMark,
  img: SignedMarkdownImage,
  video: SignedMarkdownVideo,
  audio: SignedMarkdownAudio,
  file: SignedMarkdownFile,
}

// 允许调用方（如前台 /ask 蓝底页面）强制明暗，覆盖 app 主题判断。
const QaForcedDarkContext = React.createContext<boolean | null>(null)

/** 解析当前明暗：优先用强制模式，否则跟随 app 的 theme-provider（system 时再跟随系统）。 */
function useIsDark() {
  const forced = React.useContext(QaForcedDarkContext)
  // 必须用 resolvedTheme：它已解析 system 且已应用 forcedTheme，
  // 而 theme 只是用户偏好，在强制暗色的前台页上会得出相反结论
  const { resolvedTheme } = useTheme()
  if (forced != null) return forced
  return resolvedTheme === "dark"
}

/**
 * 仅作用于问答区的 LobeHub 主题作用域。
 * enableGlobalStyle={false}：禁止 antd 全局样式注入，避免影响 app 其它地方。
 */
export function QaMarkdownScope({
  children,
  mode,
}: {
  children: React.ReactNode
  /** 强制明暗，不传则跟随 app 主题。前台 /ask 蓝底页面传 "dark" 让正文为浅色。 */
  mode?: "light" | "dark"
}) {
  const forced = mode == null ? null : mode === "dark"
  return (
    <QaForcedDarkContext.Provider value={forced}>
      <QaMarkdownThemeShell>{children}</QaMarkdownThemeShell>
    </QaForcedDarkContext.Provider>
  )
}

function QaMarkdownThemeShell({ children }: { children: React.ReactNode }) {
  const isDark = useIsDark()
  return (
    <ThemeProvider
      themeMode={isDark ? "dark" : "light"}
      enableGlobalStyle={false}
      // ThemeProvider 内部的 antd <App> 包裹层默认只有 minHeight:inherit，
      // 会打断外层 h-full 高度链，这里补回 100% 高度。
      style={{ height: "100%", minHeight: 0 }}
    >
      {children}
    </ThemeProvider>
  )
}

// —— 温柔节流：比 LobeHub silky 预设再慢一点的稳定放字节奏 ——
// LobeHub 的 streamSmoothingPreset 速率写死且 silky 已是最慢档，这里在喂给
// <Markdown> 之前先按更慢的节奏揭示，让本节奏成为瓶颈，渐显/平滑照常叠加。
// 想更慢/更快只需调 GENTLE_CPS。
const GENTLE_CPS = 21 // 稳定放字速度（字/秒）。silky≈28，这里更柔。
const GENTLE_CATCHUP_MS = 900 // 突发大块积压时，在该窗口内温和追平。

type GentleRevealOptions = {
  cps?: number
  catchupMs?: number | null
}

function useGentleReveal(text: string, isRunning: boolean, options: GentleRevealOptions = {}): number {
  const cps = options.cps ?? GENTLE_CPS
  const catchupMs = options.catchupMs ?? GENTLE_CATCHUP_MS
  const steadyMsPerChar = 1000 / cps
  const [revealed, setRevealed] = React.useState(() => (isRunning ? 0 : text.length))
  const effectiveRevealed = Math.min(revealed, text.length)

  const revealedRef = React.useRef(revealed)
  const targetRef = React.useRef(text.length)
  const rafRef = React.useRef<number | null>(null)
  const lastTimeRef = React.useRef(0)
  const tickRef = React.useRef<() => void>(() => {})

  React.useEffect(() => {
    revealedRef.current = effectiveRevealed
  }, [effectiveRevealed])

  React.useEffect(() => {
    targetRef.current = text.length
  }, [text.length])

  React.useEffect(() => {
    tickRef.current = () => {
      const now = performance.now()
      const delta = now - lastTimeRef.current
      const remaining = targetRef.current - revealedRef.current
      if (remaining <= 0) {
        rafRef.current = null
        return
      }
      // 积压越大越快（追平），越小越趋于匀速 GENTLE_CPS。
      const msPerChar = catchupMs == null
        ? steadyMsPerChar
        : Math.min(steadyMsPerChar, catchupMs / remaining)
      let charsToAdd = Math.floor(delta / msPerChar)
      if (charsToAdd <= 0) {
        rafRef.current = requestAnimationFrame(tickRef.current)
        return
      }
      if (charsToAdd > remaining) charsToAdd = remaining
      lastTimeRef.current = now - (delta - charsToAdd * msPerChar)
      const next = revealedRef.current + charsToAdd
      revealedRef.current = next
      setRevealed(next)
      rafRef.current = next < targetRef.current ? requestAnimationFrame(tickRef.current) : null
    }
  }, [steadyMsPerChar, catchupMs])

  React.useEffect(() => {
    if (revealedRef.current >= text.length) return
    if (rafRef.current == null) {
      lastTimeRef.current = performance.now()
      rafRef.current = requestAnimationFrame(tickRef.current)
    }
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [text, isRunning])

  return effectiveRevealed
}

/**
 * 首字到达前的"准备响应中"提示：thinking-orbs 点阵球 + 流光文字。
 *
 * - 球体：thinking-orbs 的 2D canvas 渲染，state 表达当前在做什么（思考/检索/整理…）。
 *   主题不走它的 auto 探测——/ask 前台强制暗色时 DOM 上仍是亮色 class，会判反；
 *   这里直接把 useIsDark 的结论传进去。
 * - 文字：渐变 + background-clip:text + 扫光动画，明暗自适配。
 *   关键帧用 <style> 内联，namespace 化避免冲突。
 */
export function QaPreparing({
  label = "准备响应中",
  state = "breathing",
}: {
  label?: string
  /** 见 thinking-orbs 九态；按当前阶段选：思考=working、检索=searching、整理=weaving… */
  state?: OrbState
}) {
  const isDark = useIsDark()
  // 用明确颜色而非 currentColor：之前 color:transparent 会把 currentColor 也解析成透明 → 整段不可见。
  const base = isDark ? "rgba(229,229,229,0.32)" : "rgba(13,13,13,0.30)"
  const hi = isDark ? "rgba(255,255,255,0.95)" : "rgba(13,13,13,0.92)"
  return (
    <div className="flex items-center gap-2 py-1" role="status" aria-label={label}>
      <style>{
        "@keyframes qa-shimmer{0%{background-position:200% center}100%{background-position:-200% center}}"
      }</style>
      <ThinkingOrb
        state={state}
        size={20}
        theme={isDark ? "dark" : "light"}
        aria-hidden
        className="shrink-0"
      />
      <span
        className="inline-block select-none text-sm font-medium"
        style={{
          backgroundImage: `linear-gradient(90deg, ${base} 0%, ${base} 40%, ${hi} 50%, ${base} 60%, ${base} 100%)`,
          backgroundSize: "200% auto",
          backgroundClip: "text",
          WebkitBackgroundClip: "text",
          color: "transparent",
          WebkitTextFillColor: "transparent",
          animation: "qa-shimmer 1.8s linear infinite",
        }}
      >
        {label}
      </span>
    </div>
  )
}

/**
 * 问答助手回答的渲染：直接用 LobeHub Markdown。
 * - 先经 useGentleReveal 节流，再交给 LobeHub 做 silky 平滑 + 字符渐显
 * - animated：流式中（含节流未放完）开启渐显，历史消息直接显示
 */
export function QaMarkdownText() {
  const { text, status } = useMessagePartText()
  const isRunning = status?.type === "running"
  return <QaStreamingMarkdown text={text} running={isRunning} />
}

export function QaStreamingMarkdown({
  text,
  running = false,
  revealOnMount = false,
  revealCps,
  catchupMs,
}: {
  text: string
  running?: boolean
  revealOnMount?: boolean
  revealCps?: number
  catchupMs?: number | null
}) {
  const shouldReveal = running || revealOnMount
  const revealed = useGentleReveal(text, shouldReveal, { cps: revealCps, catchupMs })
  const shown = revealed >= text.length ? text : text.slice(0, revealed)
  const animating = running || revealed < text.length
  return (
    <Markdown
      variant="chat"
      animated={animating}
      enableStream
      streamSmoothingPreset="silky"
      remarkPlugins={QA_REMARK_PLUGINS}
      components={QA_MARKDOWN_COMPONENTS}
      reactMarkdownProps={QA_REACT_MARKDOWN_PROPS}
      // KB 回答用不到图片画廊预览；关掉它顺带消除 antd Image 的 rootClassName 弃用告警。
      enableImageGallery={false}
    >
      {shown}
    </Markdown>
  )
}
