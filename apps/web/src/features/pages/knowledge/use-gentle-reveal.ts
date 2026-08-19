"use client"

import * as React from "react"

// —— 温柔节流：比 LobeHub silky 预设再慢一点的稳定放字节奏 ——
// LobeHub 的 streamSmoothingPreset 速率写死且 silky 已是最慢档，这里在喂给
// <Markdown> 之前先按更慢的节奏揭示，让本节奏成为瓶颈，渐显/平滑照常叠加。
// 想更慢/更快只需调 GENTLE_CPS。
export const GENTLE_CPS = 21 // 稳定放字速度（字/秒）。silky≈28，这里更柔。
export const GENTLE_CATCHUP_MS = 900 // 突发大块积压时，在该窗口内温和追平。

/**
 * 单次提交的字数上限。
 *
 * 下游 LobeHub <Markdown enableStream> 有两处按「一次提交了多少」走的分支，
 * 会把均匀的输入重新攒成块：
 * - useSmoothStreamContent：单次追加超过 largeAppendChars（silky = 100）
 *   就判定为大块粘贴，跳过平滑直接整段同步；
 * - useStreamQueue：一次提交里新增两个以上 Markdown 块时，靠后的块直接
 *   不渲染（渲染函数里 return null），要等队列定时器逐块放行——放行那一刻
 *   整块的字一次性出现。实测一帧只喂 12 个字，屏幕上能一次冒出 141 个字。
 *
 * 所以除了控制速率，还要控制每次提交的形状：不超过这个字数，且不跨越换行。
 */
const MAX_COMMIT_CHARS = 64

const noopTick = () => {}

export type GentleRevealOptions = {
  cps?: number
  catchupMs?: number | null
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1
  return i
}

/**
 * 把不规则到达的流式文本，换算成一个匀速推进的「已揭示字数」。
 *
 * 关键约束：推进循环必须跨越多个 delta 存活。流式时每个 token 都会让 text 变一次，
 * 若在每次变化时取消并重排 rAF，回调就永远排不到一帧（delta 间隔通常短于 16.7ms），
 * 累计时间也会被清零——表现为整段停摆、只在流出现空档时猛吐一坨。
 */
export function useGentleReveal(
  text: string,
  isRunning: boolean,
  options: GentleRevealOptions = {},
): number {
  const cps = options.cps ?? GENTLE_CPS
  const catchupMs = options.catchupMs ?? GENTLE_CATCHUP_MS
  const steadyMsPerChar = 1000 / cps
  const [revealed, setRevealed] = React.useState(() => (isRunning ? 0 : text.length))
  const effectiveRevealed = Math.min(revealed, text.length)

  const revealedRef = React.useRef(effectiveRevealed)
  const targetRef = React.useRef(text.length)
  const textRef = React.useRef(text)
  const prevTextRef = React.useRef(text)
  const rafRef = React.useRef<number | null>(null)
  const lastTimeRef = React.useRef(0)
  // 节奏参数放 ref：改速率不需要重建 tick，循环也就不会被打断。
  const paceRef = React.useRef({ steadyMsPerChar, catchupMs })
  paceRef.current = { steadyMsPerChar, catchupMs }
  const tickRef = React.useRef<() => void>(noopTick)

  React.useEffect(() => {
    revealedRef.current = effectiveRevealed
  }, [effectiveRevealed])

  // tick 只建一次：它全部读 ref，没有需要跟随的依赖。
  if (tickRef.current === noopTick) {
    tickRef.current = () => {
      const now = performance.now()
      const delta = now - lastTimeRef.current
      const remaining = targetRef.current - revealedRef.current
      if (remaining <= 0) {
        rafRef.current = null
        return
      }
      // 积压越大越快（追平），越小越趋于匀速 GENTLE_CPS。
      const { steadyMsPerChar: steady, catchupMs: catchup } = paceRef.current
      const msPerChar = catchup == null ? steady : Math.min(steady, catchup / remaining)
      let charsToAdd = Math.floor(delta / msPerChar)
      if (charsToAdd <= 0) {
        // 时间不够放下一个字：继续排帧，但保留已累计的 delta。
        rafRef.current = requestAnimationFrame(tickRef.current)
        return
      }
      if (charsToAdd > remaining) charsToAdd = remaining
      if (charsToAdd > MAX_COMMIT_CHARS) charsToAdd = MAX_COMMIT_CHARS
      // 不跨越换行：新的 Markdown 块必然起于新行，一次只推进一行就能保证
      // 下游每次至多多出一个块，块队列不会把内容压着不渲染。
      const from = revealedRef.current
      const lineBreak = textRef.current.slice(from, from + charsToAdd).indexOf("\n")
      if (lineBreak >= 0) charsToAdd = lineBreak + 1
      // 没放完的字不吃掉对应的时间，留给下一帧继续推进
      lastTimeRef.current = now - (delta - charsToAdd * msPerChar)
      const next = revealedRef.current + charsToAdd
      revealedRef.current = next
      setRevealed(next)
      rafRef.current = next < targetRef.current ? requestAnimationFrame(tickRef.current) : null
    }
  }

  React.useEffect(() => {
    const prev = prevTextRef.current
    prevTextRef.current = text
    textRef.current = text
    // 整段重答：从公共前缀重新揭示，而不是直接跳到全文。
    if (!text.startsWith(prev)) {
      const common = commonPrefixLength(prev, text)
      if (revealedRef.current > common) {
        revealedRef.current = common
        setRevealed(common)
      }
    }
    targetRef.current = text.length
    if (revealedRef.current >= text.length) return
    if (rafRef.current == null) {
      lastTimeRef.current = performance.now()
      rafRef.current = requestAnimationFrame(tickRef.current)
    }
    // 刻意不写 cleanup：见函数注释，取消重排会让揭示饿死。循环只在卸载时收掉。
  }, [text])

  React.useEffect(() => () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  return effectiveRevealed
}
