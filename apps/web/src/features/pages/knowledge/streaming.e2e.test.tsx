// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useRef, type ComponentType } from "react"
import type { MarkdownProps } from "@lobehub/ui/es/Markdown/type"
import * as MarkdownModule from "@lobehub/ui/es/Markdown/Markdown"
import { agentRunReducer } from "@/features/agent-runs/reducer"
import type { AgentRunViewModel, AgentStreamEvent } from "@/features/agent-runs/types"
import { LIVE_MARKDOWN_STREAM_PROPS, useStreamPacer } from "./use-stream-pacer"

/**
 * 流式渲染的端到端节奏测试。
 *
 * 测的是用户唯一在意的那件事：**每一帧有多少字同时开始淡入**。
 * 单元测试量不到这个——真正决定它的是 LobeHub 三层渲染链（平滑器 → 块队列 →
 * 逐字渐显）叠加出来的结果，只能把真组件跑起来量。
 *
 * 做法：事件走真的 agentRunReducer，文本走真的 useStreamPacer 和真的 <Markdown>，
 * 用假时钟逐帧推进；每帧扫描 DOM 记下每个字的内联 animation-delay，
 * 还原出它「开始淡入」的绝对时刻，最后按 16ms 分桶。
 *
 * 覆盖不到的部分：remark 插件、主题、signed-url 组件不参与放字节奏，harness 没接。
 * 参与节奏的那几个 prop 通过 LIVE_MARKDOWN_STREAM_PROPS 与组件共用，不会漂移。
 */

const Markdown = (MarkdownModule as unknown as { default: ComponentType<MarkdownProps> }).default

globalThis.matchMedia ??= ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {},
    removeEventListener() {}, dispatchEvent: () => false,
})) as never
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never

const ANSWER = `Mole 是一个 macOS 系统清理与维护命令行工具，用来释放磁盘空间、清理缓存并卸载残留。

## 主要功能

- **磁盘清理**（\`mo clean\`）：清理系统与应用缓存、日志、临时文件
- **应用卸载**（\`mo uninstall\`）：交互式选择应用并删除其残留配置
- **系统监控**（\`mo status\`）：实时查看 CPU、内存、磁盘、网络等运行状态

## 怎么使用

安装方式有两种：通过 Homebrew 执行 \`brew install mole\`，或运行官方安装脚本。安装后在终端输入 \`mo\` 命令即可使用。

## 注意事项

首次使用建议先运行预览模式：执行 \`mo clean --dry-run\`，在实际删除前查看会清理哪些内容，确保没有重要文件被误删。`

/**
 * 专门用来暴露块队列问题的语料：一个长列表块后面紧跟一个段落。
 * 列表块越长，空行块被当成"正在动画的块"时把后面憋住的时间越明显。
 */
const BLOCK_HEAVY_ANSWER = `检索增强生成的效果好坏，主要取决于切块策略和召回排序两件事。

## 切块策略

- **父子分块**：子块用于向量召回，命中后返回父块，兼顾精度和上下文完整度
- **重叠窗口**：相邻块保留一定重叠，避免答案正好落在切块边界上被截断
- **结构感知**：优先沿标题、列表、段落边界切分，而不是按固定字数硬切

固定字数切分实现最简单，但会把一句完整的话拦腰截断，召回出来的片段读起来是断的。

## 召回排序

先用向量检索取回一批候选，再用重排模型对候选做精排，最后按分数截断。取回的候选数量要明显大于最终使用的数量，否则重排没有发挥空间。`

let seq = 0
const ev = (type: AgentStreamEvent["type"], payload: Record<string, unknown> = {}): AgentStreamEvent => {
    seq += 1
    return { runId: "run1", sequence: seq, type, timestamp: seq, payload }
}

/** 被测对象：与 QaLiveMarkdown 同构（整形器 + 同一份流式 prop + 粘性 animated） */
function LiveAnswer({ text, running, paced }: { text: string; running: boolean; paced: boolean }) {
    const shownPaced = useStreamPacer(text, running)
    const shown = paced ? shownPaced : text
    // 与组件一致：animated 只上不下，避免结束 1 秒后 LobeHub 换渲染器把整棵树重建
    const everAnimated = useRef(false)
    if (running || shown.length < text.length) everAnimated.current = true
    return (
        <Markdown {...LIVE_MARKDOWN_STREAM_PROPS} animated={everAnimated.current}>
            {shown}
        </Markdown>
    )
}

/** 每个已渲染字符的动画状态：null = 无动画，数值 = 内联 animation-delay（ms，负数=已开始） */
function scanChars(container: HTMLElement): Array<number | null> {
    const out: Array<number | null> = []
    const walk = (node: Node, delay: number | null) => {
        if (node.nodeType === 3) {
            const len = node.textContent?.length ?? 0
            for (let i = 0; i < len; i += 1) out.push(delay)
            return
        }
        if (node.nodeType !== 1) return
        const el = node as HTMLElement
        let next = delay
        if (el.classList.contains("stream-char")) {
            next = el.classList.contains("stream-char-revealed")
                ? null
                : (el.style.animationDelay ? Number.parseFloat(el.style.animationDelay) : null)
        }
        for (const child of Array.from(el.childNodes)) walk(child, next)
    }
    for (const child of Array.from(container.childNodes)) walk(child, null)
    return out
}

const FRAME = 16

function measure({ chunk, gapMs, paced, answer: source = ANSWER }: { chunk: number; gapMs: number; paced: boolean; answer?: string }) {
    seq = 0
    let run: AgentRunViewModel | null = null
    const apply = (e: AgentStreamEvent) => { run = agentRunReducer(run, e) }
    apply(ev("agent_started", { goal: "g" }))
    apply(ev("final_answer_started"))

    let answer = ""
    let running = true
    const view = () => <LiveAnswer text={answer} running={running} paced={paced} />
    const { container, rerender } = render(view())

    const visibleAt: number[] = []
    let clock = 0
    let cursor = 0
    let sinceArrival = 0

    const step = () => {
        act(() => { vi.advanceTimersByTime(FRAME) })
        clock += FRAME
        const states = scanChars(container)
        for (let i = 0; i < states.length; i += 1) {
            if (visibleAt[i] !== undefined) continue
            const d = states[i]
            visibleAt[i] = d == null ? clock : clock + Math.max(0, d)
        }
    }

    while (cursor < source.length) {
        sinceArrival += FRAME
        if (sinceArrival >= gapMs) {
            sinceArrival = 0
            const fed = Math.min(chunk, source.length - cursor)
            cursor += fed
            apply(ev("final_answer_delta", { delta: source.slice(cursor - fed, cursor) }))
            answer = run!.answer
            act(() => { rerender(view()) })
        }
        step()
    }

    // 服务端最终文本经过 trim / 去重归一化，这里只差一个结尾换行
    apply(ev("final_answer_completed", { text: `${source}\n`.trim() }))
    answer = run!.answer
    act(() => { rerender(view()) })
    step()

    apply(ev("agent_completed", { status: "completed", metrics: { durationMs: 1, toolCalls: 0 } }))
    running = false
    act(() => { rerender(view()) })
    const firstParagraphBefore = container.querySelector("p")
    for (let i = 0; i < 600; i += 1) step()
    // LobeHub 在 animated 转 false 的 1 秒后会换渲染器，整棵树会被重建。
    // 粘性 animated 就是为了不触发它，这里用节点身份验证。
    const rebuilt = container.querySelector("p") !== firstParagraphBefore

    const bins = new Map<number, number>()
    for (const t of visibleAt) {
        const bin = Math.floor(t / FRAME)
        bins.set(bin, (bins.get(bin) ?? 0) + 1)
    }
    const worstBurst = Math.max(...bins.values())
    // 最长停顿：相邻两个「有字开始淡入」的帧之间隔了多久。突现字数管"一次冒出多少"，
    // 这个管"中间卡多久"，两者都低才叫顺。
    const activeBins = [...bins.keys()].sort((a, b) => a - b)
    let worstGapMs = 0
    for (let i = 1; i < activeBins.length; i += 1) {
        worstGapMs = Math.max(worstGapMs, (activeBins[i] - activeBins[i - 1]) * FRAME)
    }
    const gaps = activeBins
        .map((b, i) => (i === 0 ? null : { at: b * FRAME, gap: (b - activeBins[i - 1]) * FRAME }))
        .filter((g): g is { at: number; gap: number } => g != null && g.gap >= 96)
        .map((g) => `${g.at}ms(+${g.gap})`)
        .join(" ")
    return {
        gaps,
        rebuilt,
        chars: visibleAt.length,
        worstBurst,
        worstGapMs,
        spanMs: Math.max(...visibleAt) - Math.min(...visibleAt),
    }
}

beforeEach(() => {
    vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval",
            "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"],
    })
})
afterEach(() => {
    cleanup()
    vi.useRealTimers()
})

describe("流式渲染节奏", () => {
    it("模型很快时，整形把单帧同时淡入的字数压下来", () => {
        const raw = measure({ chunk: 24, gapMs: 40, paced: false })   // ≈600 字/秒
        const shaped = measure({ chunk: 24, gapMs: 40, paced: true })

        console.info(
            `\n600字/秒输入（正文 ${raw.chars} 字）\n` +
            `  不整形  单帧最多 ${raw.worstBurst} 字，铺开 ${(raw.spanMs / 1000).toFixed(1)}s\n` +
            `  整形后  单帧最多 ${shaped.worstBurst} 字，铺开 ${(shaped.spanMs / 1000).toFixed(1)}s`,
        )

        // 不整形时渲染链会把字攒成块一次性放出，这是"一次冒出很多字"的观感来源
        expect(raw.worstBurst).toBeGreaterThan(40)
        // 整形后必须显著改善，且不能退化——参数是实测挑的，改动会在这里现形
        expect(shaped.worstBurst).toBeLessThanOrEqual(20)
        expect(shaped.worstBurst).toBeLessThan(raw.worstBurst / 2)
        // 顺带守住"整形没有吞字"：正文字数 = 原文去掉 Markdown 标记后的可见字数
        expect(shaped.chars).toBeGreaterThan(280)
        expect(shaped.chars).toBe(raw.chars)
        // 真组件渲染在满量并发下会明显变慢，给足超时避免 flake
    }, 60_000)

    it("块边界不会把后面的内容整块憋住", () => {
        const shaped = measure({ chunk: 12, gapMs: 40, paced: true, answer: BLOCK_HEAVY_ANSWER })

        console.info(
            `\n块边界停顿（长列表块 + 后续段落）\n` +
            `  最长 ${shaped.worstGapMs}ms，单帧最多 ${shaped.worstBurst} 字\n` +
            `  >=96ms 的停顿: ${shaped.gaps || "无"}`,
        )

        // 守的是 patches/@lobehub__ui@*.patch：空行是 marked 的 space token，没有任何
        // 可见字符，却会被 useStreamQueue 当成"正在动画的块"，把它后面的块判成 queued
        // 直接 return null，等 (n-1)*charDelay+180 ≈ 198ms 才放行、再整块冒出来。
        // 补丁把空行并进前一个块，块数每次只 +1，这个停顿就没有了。
        // 实测：补丁关掉 208ms / 一帧涌出 32 字，补丁开启 96ms。
        expect(shaped.worstGapMs).toBeLessThan(140)
        expect(shaped.worstBurst).toBeLessThanOrEqual(20)
    }, 60_000)

    it("回答结束后不会把整棵 DOM 重建一遍", () => {
        const shaped = measure({ chunk: 12, gapMs: 40, paced: true, answer: BLOCK_HEAVY_ANSWER })

        // animated 一旦转 false，LobeHub 会在 1 秒后把渲染器从 StreamdownRender 换成
        // MarkdownRenderer，两者 DOM 结构不同，整棵树被换掉：代码块重新高亮、图片重新
        // 请求，看得见地闪一下。QaLiveMarkdown 用粘性 animated 规避，这里守住它。
        expect(shaped.rebuilt).toBe(false)
    }, 60_000)

    it("模型不快时整形基本是直通，不会拖慢", () => {
        const raw = measure({ chunk: 8, gapMs: 40, paced: false })    // ≈200 字/秒
        const shaped = measure({ chunk: 8, gapMs: 40, paced: true })

        console.info(
            `\n200字/秒输入\n` +
            `  不整形  单帧最多 ${raw.worstBurst} 字，铺开 ${(raw.spanMs / 1000).toFixed(1)}s\n` +
            `  整形后  单帧最多 ${shaped.worstBurst} 字，铺开 ${(shaped.spanMs / 1000).toFixed(1)}s`,
        )

        expect(shaped.worstBurst).toBeLessThanOrEqual(20)
        // 额外延迟控制在 1s 以内
        expect(shaped.spanMs).toBeLessThan(raw.spanMs + 1000)
    }, 60_000)
})
