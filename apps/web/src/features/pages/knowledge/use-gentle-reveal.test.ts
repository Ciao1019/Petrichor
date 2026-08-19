// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useGentleReveal } from "./use-gentle-reveal"

/**
 * 流式揭示的回归测试。
 *
 * 这里守的是一个很容易被"顺手修回去"的性质：推进循环必须跨越多个 delta 存活。
 * 曾经的实现把 text 放进 effect 依赖并在 cleanup 里 cancelAnimationFrame，
 * 于是每个 token 都会取消掉还没执行的那一帧、并把计时清零；delta 间隔通常
 * 短于一帧（16.7ms），回调就永远排不上，屏幕上整段不动，只在流出现空档时
 * 猛吐一大块——正是"完全不像流式"的成因。
 */

let now = 0
let nextHandle = 1
let frames = new Map<number, FrameRequestCallback>()

/** 跑一帧：把当前排队的回调全部执行（回调里再排的帧留到下一次） */
function runFrame(advanceMs = 0) {
    now += advanceMs
    const pending = [...frames.values()]
    frames.clear()
    for (const cb of pending) cb(now)
}

beforeEach(() => {
    now = 0
    nextHandle = 1
    frames = new Map()
    vi.stubGlobal("performance", { now: () => now })
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        const id = nextHandle++
        frames.set(id, cb)
        return id
    })
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
        frames.delete(id)
    })
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

describe("useGentleReveal", () => {
    it("delta 比一帧还密时，揭示仍然持续推进", () => {
        // 100 字/秒 → 10ms 一个字；关掉追平，只看匀速这条路径
        const { result, rerender } = renderHook(
            ({ text }) => useGentleReveal(text, true, { cps: 100, catchupMs: null }),
            { initialProps: { text: "" } },
        )

        let text = ""
        // 每 5ms 来一个字（快于一帧），每 4 个字浏览器才给到一帧
        for (let i = 0; i < 40; i += 1) {
            now += 5
            text += "字"
            act(() => { rerender({ text }) })
            if (i % 4 === 3) act(() => { runFrame() })
        }

        // 总共走过 200ms，10ms 一个字 → 应当揭示约 20 个字
        expect(result.current).toBeGreaterThan(10)
        expect(result.current).toBeLessThanOrEqual(text.length)
    })

    it("揭示速度不超过设定节奏，不会一次吐完", () => {
        const { result, rerender } = renderHook(
            ({ text }) => useGentleReveal(text, true, { cps: 100, catchupMs: null }),
            { initialProps: { text: "" } },
        )

        act(() => { rerender({ text: "一二三四五六七八九十" }) })
        act(() => { runFrame(50) }) // 50ms / 10ms 一个字 → 5 个字

        expect(result.current).toBe(5)
    })

    it("积压很大时在追平窗口内赶上，而不是干等", () => {
        const { result, rerender } = renderHook(
            ({ text }) => useGentleReveal(text, true, { cps: 21, catchupMs: 900 }),
            { initialProps: { text: "" } },
        )

        const long = "字".repeat(900)
        act(() => { rerender({ text: long }) })

        // 追平是指数逼近：每帧按「积压 / 900ms」放字，一个窗口内放掉约 2/3
        for (let i = 0; i < 60; i += 1) act(() => { runFrame(16.7) })
        expect(result.current).toBeGreaterThan(500)
        expect(result.current).toBeLessThan(long.length)

        // 再给几个窗口就完全追平，不会一直吊着（尾巴回落到 21 字/秒的匀速档）
        for (let i = 0; i < 300; i += 1) act(() => { runFrame(16.7) })
        expect(result.current).toBe(long.length)
    })

    it("单帧提交量有上限，不会把一大块直接甩给下游", () => {
        // 下游 LobeHub 的平滑器把「单次追加 > 100 字」当成大块粘贴直接同步，
        // 这里必须留在阈值以内，否则平滑层会被绕过。
        const { result, rerender } = renderHook(
            ({ text }) => useGentleReveal(text, true, { cps: 21, catchupMs: 900 }),
            { initialProps: { text: "" } },
        )

        act(() => { rerender({ text: "字".repeat(5_000) }) })
        act(() => { runFrame(16.7) })

        expect(result.current).toBeGreaterThan(0)
        expect(result.current).toBeLessThanOrEqual(64)
    })

    it("一次提交不跨越换行，下游块队列不会把内容压着不渲染", () => {
        // 新的 Markdown 块必然起于新行；一帧跨过多行会让 useStreamQueue
        // 把靠后的块判成 queued 直接不渲染，放行那一刻整块一次性冒出来。
        const { result, rerender } = renderHook(
            ({ text }) => useGentleReveal(text, true, { cps: 1000, catchupMs: null }),
            { initialProps: { text: "" } },
        )

        act(() => { rerender({ text: "第一行\n\n## 标题\n\n正文" }) })
        act(() => { runFrame(1000) })
        expect(result.current).toBe("第一行\n".length)

        act(() => { runFrame(1000) })
        expect(result.current).toBe("第一行\n\n".length)

        act(() => { runFrame(1000) })
        expect(result.current).toBe("第一行\n\n## 标题\n".length)
    })

    it("整段重答时从公共前缀重新揭示，而不是直接跳到全文", () => {
        const { result, rerender } = renderHook(
            ({ text }) => useGentleReveal(text, true, { cps: 1000, catchupMs: null }),
            { initialProps: { text: "" } },
        )

        act(() => { rerender({ text: "前缀AAAA" }) })
        act(() => { runFrame(1000) })
        expect(result.current).toBe(6)

        act(() => { rerender({ text: "前缀BBBB" }) })
        expect(result.current).toBe(2)
    })

    it("非流式挂载（历史消息）直接全量显示", () => {
        const { result } = renderHook(() => useGentleReveal("已经写完的答案", false))
        expect(result.current).toBe("已经写完的答案".length)
    })

    it("卸载时收掉循环，不再排新帧", () => {
        const { rerender, unmount } = renderHook(
            ({ text }) => useGentleReveal(text, true, { cps: 100, catchupMs: null }),
            { initialProps: { text: "" } },
        )
        act(() => { rerender({ text: "一二三四五" }) })
        expect(frames.size).toBeGreaterThan(0)

        unmount()
        expect(frames.size).toBe(0)
    })
})
