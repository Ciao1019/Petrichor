"use client"

import * as React from "react"

/**
 * 流式文本的到达整形器。
 *
 * 它不当第二个调速器，只整形「新内容以什么形状交给渲染层」：提交间隔和单次字数。
 * 存在的理由是实测——模型出字很快时，LobeHub 的渲染链会把字攒成块一次性放出来
 * （落后的 Markdown 块在 rehypeStreamAnimated 里被 `Math.min(cap, ...)` 夹进 180ms
 * 窗口，超出的字拿到完全相同的出生时间戳，于是同一帧一起淡入）。
 *
 * 数据来自 streaming.e2e.test.tsx：在 jsdom 里跑真实渲染链，按绝对时刻统计
 * 「每 16ms 有多少字开始淡入」。1527 字的结构化答案：
 *
 *   输入 600 字/秒   不整形 476 字/帧（4.0s）   整形后 23 字/帧（10.0s）
 *   输入 200 字/秒   不整形  23 字/帧（10.0s）  整形后 23 字/帧（10.0s）
 *   输入 120 字/秒   不整形  23 字/帧（15.5s）  整形后 23 字/帧（15.5s）
 *
 * 也就是说：模型慢于约 150 字/秒时它是纯直通，零代价；只有更快时才介入。
 * 残留的 23 字/帧来自 LobeHub 块队列本身，不是这一层能解决的。
 *
 * 两个常量都是扫出来的，阈值很陡，别凭感觉调：
 * - COMMIT_MS 必须大于 LobeHub 平滑器自己的 minCommitIntervalMs（balanced = 48ms）。
 *   同样每次 10 字，提交间隔 60ms → 23 字/帧，改成 48ms → 72 字/帧：
 *   提交比它的节拍还密时，它会把我们几次提交并成一次大的来处理。
 * - MAX_COMMIT_CHARS 从 10 提到 16 → 72 字/帧。
 *
 * 「一次提交不跨越换行」这条按内容长短效果不一：1527 字的长答案上毫无变化，
 * 350 字的中等答案上把 17 字/帧压到 10 字/帧。代价是总时长多一成多。
 * 取它是因为最坏情况不会更差、常见长度更好。
 */
const COMMIT_MS = 60
const MAX_COMMIT_CHARS = 10

/**
 * 参与流式节奏的 <Markdown> 配置。抽出来是为了让端到端测试和组件用同一份，
 * 改了这里测试会跟着变，不会出现"测的和跑的不是一套"。
 * 其余 prop（remark 插件、components 等）不影响放字节奏。
 */
export const LIVE_MARKDOWN_STREAM_PROPS = {
  variant: "chat",
  streamSmoothingPreset: "balanced",
  streamAnimationGranularity: "word",
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
      let next = Math.min(target, from + paceRef.current.maxCommitChars)
      // 不跨越换行：新的 Markdown 块必然起于新行，一次只推进到行尾，
      // 渲染层每次至多多处理一个块。中等长度的结构化答案上这条能把
      // 单帧最大值从 17 字压到 10 字，代价是总时长多一成多。
      const lineBreak = textRef.current.slice(from, next).indexOf("\n")
      if (lineBreak >= 0) next = from + lineBreak + 1
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
