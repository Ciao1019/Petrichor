"use client"

import * as React from "react"
import { useMessagePartText } from "@assistant-ui/react"
import { Markdown, remarkVideo, ThemeProvider, type MarkdownProps } from "@lobehub/ui"
import { ThinkingOrb, type OrbState } from "thinking-orbs"

import { useTheme } from "@/components/theme-provider"
import { useGentleReveal } from "./use-gentle-reveal"
import { LIVE_MARKDOWN_STREAM_PROPS, useStreamPacer } from "./use-stream-pacer"
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
 * animated 只跟随是否在流式中，历史消息直接静态显示。
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
  /** 文本一次性给全（如文章 AI 总结），需要自己做打字机效果 */
  revealOnMount?: boolean
  revealCps?: number
  catchupMs?: number | null
}) {
  // 两条路径的差别不是参数，是"谁来控制节奏"，所以拆成两个组件而不是一个分支：
  // 流式路径完全不该挂 useGentleReveal 的 rAF 循环。
  if (revealOnMount) {
    return <QaRevealedMarkdown text={text} revealCps={revealCps} catchupMs={catchupMs} />
  }
  return <QaLiveMarkdown text={text} running={running} />
}

/**
 * 流式渲染。
 *
 * 调速器只有一个，就是 LobeHub 自己那套（useSmoothStreamContent 按帧插值 +
 * useStreamQueue 块级节奏 + rehypeStreamAnimated 逐字渐显）。官方
 * StreamingPlayground 把 2~8 字 / 35~120ms 的原始 chunk 直接塞进去，效果很顺，
 * 我们不再在它上面叠自己的节流——那会让它的 inputActive 恒为真、进不了 flush 分支。
 *
 * useStreamPacer 做的是另一件事：只整形"到达的形状"（提交间隔和单次字数），
 * 不改变谁来控制节奏。模型很快时这一步是必要的，理由和实测数字见该文件注释。
 */
function QaLiveMarkdown({ text, running }: { text: string; running: boolean }) {
  // 只整形"到达形状"，不当第二个调速器：每 60ms 提交一次、每次至多 10 字、不跨行。
  // 模型很快时这一步把单帧最大同时淡入字数从 60 压到 18（见 use-stream-pacer 注释）。
  const shown = useStreamPacer(text, running)
  // 整形还没放完时要继续保持动画，否则剩下的字会失去渐显直接出现。
  const animating = running || shown.length < text.length
  return (
    <Markdown
      // 预设跟官方 demo 一致；这几个 prop 与端到端测试共用同一份常量
      {...LIVE_MARKDOWN_STREAM_PROPS}
      animated={animating}
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

/**
 * 打字机渲染：文本已经全在手里（文章 AI 总结），由 useGentleReveal 逐字放出。
 * 这里我们就是唯一的节奏来源，LobeHub 只负责把放出来的字渐显。
 */
function QaRevealedMarkdown({
  text,
  revealCps,
  catchupMs,
}: {
  text: string
  revealCps?: number
  catchupMs?: number | null
}) {
  const revealed = useGentleReveal(text, true, { cps: revealCps, catchupMs })
  const shown = revealed >= text.length ? text : text.slice(0, revealed)
  const animating = revealed < text.length
  return (
    <Markdown
      variant="chat"
      animated={animating}
      streamSmoothingPreset="balanced"
      remarkPlugins={QA_REMARK_PLUGINS}
      components={QA_MARKDOWN_COMPONENTS}
      reactMarkdownProps={QA_REACT_MARKDOWN_PROPS}
      enableImageGallery={false}
    >
      {shown}
    </Markdown>
  )
}
