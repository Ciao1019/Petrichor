"use client"

import * as React from "react"

/**
 * 流式文本的到达整形器。
 *
 * 它不当第二个调速器，只整形「新内容以什么形状交给渲染层」：提交间隔、单次可见字数、
 * 块边界怎么切。存在的理由是实测——模型出字很快时，LobeHub 的渲染链会把字攒成块
 * 一次性放出来（落后的 Markdown 块在 rehypeStreamAnimated 里被 `Math.min(cap, ...)`
 * 夹进 180ms 窗口，超出的字拿到完全相同的出生时间戳，于是同一帧一起淡入）。
 *
 * 数据来自 streaming.e2e.test.tsx：在 jsdom 里跑真实渲染链，按绝对时刻统计
 * 「每 16ms 有多少字开始淡入」。307 字的结构化中文答案：
 *
 *   输入 600 字/秒    不整形 43 字/帧（1.6s）   整形后 15 字/帧（3.0s）
 *   输入 200 字/秒    不整形 13 字/帧（3.0s）   整形后 13 字/帧（3.0s）
 *   输入 3000 字/秒   不整形 58 字/帧（1.1s）   整形后 14 字/帧（2.4s）
 *
 * 也就是说：模型慢于约 200 字/秒时它是纯直通，零代价；只有更快时才介入。
 *
 * 两个常量都是扫出来的，别凭感觉调：
 * - COMMIT_MS 必须大于 LobeHub 平滑器自己的 minCommitIntervalMs（balanced = 48ms）。
 *   提交比它的节拍还密时，它会把我们几次提交并成一次大的来处理。
 * - MAX_COMMIT_CHARS 10 → 13 → 16：单帧最大 15 → 19 → 26 字，总时长 3.0 → 2.5 → 2.3s。
 *   取 10 是因为这条链上更值钱的是"不要一次冒出一堆字"，不是少那半秒。
 */
const COMMIT_MS = 60
const MAX_COMMIT_CHARS = 10

/**
 * 预算按「可见字符」计，不按原始字符。
 *
 * 原因是实测：结构化答案里 `\n` 和行首的 `##` / `- ` / `> ` 不产生任何可见字形，
 * 但按原始字符计费时它们照样吃掉每次 10 字的额度，一个 60ms tick 经常只放出
 * 1~3 个能看见的字，块边界处甚至一个都没有——观感上就是一顿一顿的。
 *
 * 只放行「行首的结构标记」，不放行行内的 `**` / 反引号：后者数量不封顶，
 * 放行会让一次提交塞进太多原始字符，反而把单帧突现字数顶上去。
 */
/** 行首的缩进与块标记：`#` `-` `*` `+` `1.` `>`，它们由列表/标题样式渲染，不是正文字形 */
const LINE_OPENING_RE = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)]|#{1,6}|>)[ \t]*)*/
/** 兜底：一次提交最多推进多少原始字符，防止整行都是标记时一次吐太多 */
const MAX_COMMIT_RAW_CHARS = MAX_COMMIT_CHARS * 2

/** 从 `i` 起跳过行首的缩进和块标记，返回新的下标 */
function skipLineOpening(text: string, i: number): number {
  const window = text.slice(i, i + 24)
  const matched = LINE_OPENING_RE.exec(window)
  return matched ? i + matched[0].length : i
}

/** 该字符是否要计入本次提交的可见字预算 */
function costsBudget(ch: string): boolean {
  return ch !== " " && ch !== "\t"
}

/**
 * 参与流式节奏的 <Markdown> 配置。抽出来是为了让端到端测试和组件用同一份，
 * 改了这里测试会跟着变，不会出现"测的和跑的不是一套"。
 * 其余 prop（remark 插件、components 等）不影响放字节奏。
 *
 * granularity 从 word 改成 char 是量出来的：word 粒度下 Intl.Segmenter 把中文切成
 * 2~4 字一段，同一段共用一个出生时间戳，整段一起闪；char 粒度让"有字出现的帧"
 * 从 103 提到 112（同一段 283 字的结构化中文答案），是连续的擦除感而不是一块块地闪。
 * 代价是 span 数量约翻倍。
 *
 * preset 试过 realtime，别再改回去：它缓冲小、minCommitIntervalMs 只有 32ms，会把
 * 整形器 60ms 一次的提交在更少的帧里吐完。实测同一段答案单帧最大同时淡入字数
 * balanced 15 字 → realtime 30 字。realtime 只在"完全不整形"时更好，而整形器不能去掉
 * （不整形时 3000 字/秒会出现 58 字/帧）。两层的取舍是配套的，只换一层会变差。
 */
export const LIVE_MARKDOWN_STREAM_PROPS = {
  variant: "chat",
  streamSmoothingPreset: "balanced",
  streamAnimationGranularity: "char",
} as const

const noopTick = () => {}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1
  return i
}

export type StreamPacerOptions = {
  commitMs?: number
  maxCommitChars?: number
}

export function useStreamPacer(
  text: string,
  running: boolean,
  options: StreamPacerOptions = {},
): string {
  const commitMs = options.commitMs ?? COMMIT_MS
  const maxCommitChars = options.maxCommitChars ?? MAX_COMMIT_CHARS
  const paceRef = React.useRef({ commitMs, maxCommitChars })
  paceRef.current = { commitMs, maxCommitChars }
  const [emitted, setEmitted] = React.useState(() => (running ? 0 : text.length))
  const capped = Math.min(emitted, text.length)

  const emittedRef = React.useRef(capped)
  const textRef = React.useRef(text)
  const prevTextRef = React.useRef(text)
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null)
  const tickRef = React.useRef<() => void>(noopTick)

  React.useEffect(() => {
    emittedRef.current = capped
  }, [capped])

  const stop = React.useCallback(() => {
    if (timerRef.current != null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  if (tickRef.current === noopTick) {
    tickRef.current = () => {
      const target = textRef.current.length
      const from = emittedRef.current
      if (from >= target) {
        stop()
        return
      }
      const text = textRef.current
      const budget = paceRef.current.maxCommitChars
      let next = from
      let spent = 0
      let hasVisible = false
      // 起点若正好是行首，先白拿掉缩进和块标记
      if (next === 0 || text[next - 1] === "\n") next = skipLineOpening(text, next)
      while (next < target && spent < budget && next - from < MAX_COMMIT_RAW_CHARS) {
        if (text[next] === "\n") {
          // 一次提交至多让块数 +1。整段换行和前一块的收尾放在同一次提交里，
          // 新块的第一个可见字留给下一次。
          //
          // 这条只保证「我们交出去的形状」是干净的。真正修掉块边界卡顿的是
          // patches/@lobehub__ui@*.patch——LobeHub 的平滑器在我们下游，它会把
          // 我们分开的两次提交重新并到同一帧，marked 于是一次切出空行块和新块，
          // 零可见字的空行块占住 useStreamQueue，后面那块被判 queued 直接
          // return null，约 198ms 后才整块涌出（实测冻结 176ms 再一帧冒 32 字）。
          // 补丁把空行并进前一块，从根上消掉；这条规则是配套的第二道，别只留一个。
          const runStart = next
          while (next < target && text[next] === "\n") next += 1
          if (hasVisible || next - runStart >= 2) break
          next = skipLineOpening(text, next)
          continue
        }
        const ch = text[next]
        next += 1
        if (costsBudget(ch)) {
          spent += 1
          hasVisible = true
        }
      }
      emittedRef.current = next
      setEmitted(next)
      if (next >= textRef.current.length) stop()
    }
  }

  React.useEffect(() => {
    const prev = prevTextRef.current
    prevTextRef.current = text
    textRef.current = text
    // 整段重答：回到公共前缀重新放，而不是直接跳到全文
    if (!text.startsWith(prev)) {
      const common = commonPrefixLength(prev, text)
      if (emittedRef.current > common) {
        emittedRef.current = common
        setEmitted(common)
      }
    }
    if (emittedRef.current >= text.length) return
    if (timerRef.current == null) {
      timerRef.current = setInterval(() => tickRef.current(), paceRef.current.commitMs)
    }
    // 这里刻意不写 cleanup：流式时每个 delta 都会跑一遍本 effect，
    // 在此清掉定时器再重建会让它永远凑不满一个提交周期。只在卸载时收。
  }, [text])

  React.useEffect(() => stop, [stop])

  return capped >= text.length ? text : text.slice(0, capped)
}
