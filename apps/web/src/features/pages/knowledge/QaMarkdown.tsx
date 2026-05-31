"use client"

import * as React from "react"
import { useMessagePartText } from "@assistant-ui/react"
import { Markdown, ThemeProvider, type MarkdownProps } from "@lobehub/ui"

import { useTheme } from "@/components/theme-provider"
import {
  SignedMarkdownImage,
  storageMarkdownUrlTransform,
} from "@/components/assistant-ui/signed-markdown-image"

const QA_REACT_MARKDOWN_PROPS = {
  urlTransform: storageMarkdownUrlTransform,
}
const QA_MARKDOWN_COMPONENTS: NonNullable<MarkdownProps["components"]> = {
  img: SignedMarkdownImage,
}

/** 解析当前明暗：跟随 app 的 theme-provider（system 时再跟随系统）。 */
function useIsDark() {
  const { theme } = useTheme()
  const [systemDark, setSystemDark] = React.useState(false)
  React.useEffect(() => {
    if (theme !== "system" || typeof window === "undefined") return
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const update = () => setSystemDark(mq.matches)
    update()
    mq.addEventListener("change", update)
    return () => mq.removeEventListener("change", update)
  }, [theme])
  return theme === "dark" || (theme === "system" && systemDark)
}

/**
 * 仅作用于问答区的 LobeHub 主题作用域。
 * enableGlobalStyle={false}：禁止 antd 全局样式注入，避免影响 app 其它地方。
 */
export function QaMarkdownScope({ children }: { children: React.ReactNode }) {
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

function useGentleReveal(text: string, isRunning: boolean): number {
  const steadyMsPerChar = 1000 / GENTLE_CPS
  const [revealed, setRevealed] = React.useState(() => (isRunning ? 0 : text.length))

  const [tracked, setTracked] = React.useState(text)
  if (text !== tracked) {
    setTracked(text)
    // 流被替换（新消息/重新生成）时回退进度，避免闪烁。
    if (!text.startsWith(tracked)) setRevealed(isRunning ? 0 : text.length)
  }

  const revealedRef = React.useRef(revealed)
  revealedRef.current = revealed
  const targetRef = React.useRef(text.length)
  targetRef.current = text.length
  const prevTextRef = React.useRef(text)
  const rafRef = React.useRef<number | null>(null)
  const lastTimeRef = React.useRef(0)

  const tick = React.useCallback(() => {
    const now = performance.now()
    const delta = now - lastTimeRef.current
    const remaining = targetRef.current - revealedRef.current
    if (remaining <= 0) {
      rafRef.current = null
      return
    }
    // 积压越大越快（追平），越小越趋于匀速 GENTLE_CPS。
    const msPerChar = Math.min(steadyMsPerChar, GENTLE_CATCHUP_MS / remaining)
    let charsToAdd = Math.floor(delta / msPerChar)
    if (charsToAdd <= 0) {
      rafRef.current = requestAnimationFrame(tick)
      return
    }
    if (charsToAdd > remaining) charsToAdd = remaining
    lastTimeRef.current = now - (delta - charsToAdd * msPerChar)
    const next = revealedRef.current + charsToAdd
    revealedRef.current = next
    setRevealed(next)
    rafRef.current = next < targetRef.current ? requestAnimationFrame(tick) : null
  }, [steadyMsPerChar])

  React.useEffect(() => {
    const prev = prevTextRef.current
    prevTextRef.current = text
    if (!text.startsWith(prev) && isRunning) revealedRef.current = 0
    if (revealedRef.current >= text.length) return
    if (rafRef.current == null) {
      lastTimeRef.current = performance.now()
      rafRef.current = requestAnimationFrame(tick)
    }
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [text, isRunning, tick])

  return revealed
}

/**
 * 首字到达前的"准备响应中"流光文字。
 * 纯 CSS：渐变 + background-clip:text + 扫光动画，明暗主题自适配（用 currentColor + color-mix），
 * 不引入额外依赖。关键帧用 <style> 内联，namespace 化避免冲突。
 */
export function QaPreparing({ label = "准备响应中" }: { label?: string }) {
  const isDark = useIsDark()
  // 用明确颜色而非 currentColor：之前 color:transparent 会把 currentColor 也解析成透明 → 整段不可见。
  const base = isDark ? "rgba(229,229,229,0.32)" : "rgba(13,13,13,0.30)"
  const hi = isDark ? "rgba(255,255,255,0.95)" : "rgba(13,13,13,0.92)"
  return (
    <div className="py-1" role="status" aria-label={label}>
      <style>{
        "@keyframes qa-shimmer{0%{background-position:200% center}100%{background-position:-200% center}}"
      }</style>
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
  const revealed = useGentleReveal(text, isRunning)
  const shown = revealed >= text.length ? text : text.slice(0, revealed)
  const animating = isRunning || revealed < text.length
  return (
    <Markdown
      variant="chat"
      animated={animating}
      enableStream
      streamSmoothingPreset="silky"
      components={QA_MARKDOWN_COMPONENTS}
      reactMarkdownProps={QA_REACT_MARKDOWN_PROPS}
      // KB 回答用不到图片画廊预览；关掉它顺带消除 antd Image 的 rootClassName 弃用告警。
      enableImageGallery={false}
    >
      {shown}
    </Markdown>
  )
}
