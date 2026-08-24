"use client"

import { useEffect, useMemo } from "react"
import {
    ComposerPrimitive,
    makeAssistantDataUI,
    useAuiState,
    useMessagePartText,
    useThreadRuntime,
} from "@assistant-ui/react"
import { AgentRun } from "@/components/agent/agent-run"
import { AgentCitation } from "@/components/agent/agent-evidence"
import { markRetry, useAgentRunsStore } from "@/features/agent-runs/store"
import { isAgentStreamEvent, shouldShowExecutionPanel } from "@/features/agent-runs/types"
import type { AgentRunViewModel } from "@/features/agent-runs/types"
import { QaStreamingMarkdown } from "@/features/pages/knowledge/QaMarkdown"
import { annotateNormalQaWikiMentions } from "@/lib/wiki-mentions"

/**
 * Agent 执行 UI 接线（§162.5/§162.50）。
 *
 * 后端 data-agent-event → Store → ViewModel → 组件。
 * 这里不做任何文本匹配猜状态，也不渲染模型隐藏推理。
 */

/** 事件摄取：只把事件写进 Store，本身不渲染任何内容 */
export const AgentEventDataUI = makeAssistantDataUI({
    name: "agent-event",
    render: ({ data }) => {
        const append = useAgentRunsStore((state) => state.appendEvent)
        useEffect(() => {
            if (isAgentStreamEvent(data)) append(data)
        }, [data, append])
        return null
    },
})

/** 从当前助手消息的 parts 里取出 runId */
function useMessageRunId(): string | null {
    return useAuiState((state) => {
        for (let index = state.message.parts.length - 1; index >= 0; index -= 1) {
            const part = state.message.parts[index] as { type?: string; data?: unknown }
            if (part?.type !== "data") continue
            if (isAgentStreamEvent(part.data)) return part.data.runId
        }
        return null
    })
}

export function useCurrentAgentRun(): AgentRunViewModel | null {
    const runId = useMessageRunId()
    return useAgentRunsStore((state) => (runId ? state.runs[runId] ?? null : null))
}

/**
 * 消息内的执行面板。
 * 简单请求（direct、无工具活动）不渲染，保持原有简洁聊天体验。
 */
export function AgentRunPanel() {
    const run = useCurrentAgentRun()
    const cancelRun = useAgentRunsStore((state) => state.cancelRun)
    const threadRuntime = useThreadRuntime()

    if (!shouldShowExecutionPanel(run) || !run) return null

    const isRunning = run.status === "running" || run.status === "starting"

    return (
        <AgentRun
            run={run}
            {...(isRunning
                ? { onStop: () => { cancelRun(run.id); threadRuntime.cancelRun() } }
                : {
                    // 重试创建新的 Run，并记录 retryOfRunId，不复用已失败 State（§162.24）
                    onRetry: () => {
                        markRetry(run.id)
                        threadRuntime.startRun({ parentId: null })
                    },
                })}
        />
    )
}

/**
 * 答案由 Run 的结构化文本渲染，还是由标准 text part 渲染。
 *
 * - 本次会话流式产生的 Run：从第一个 delta 一路渲染到终态，中途不换手。
 *   run 完成时交还给 text part 会重挂整棵 Markdown 树，用户看到的就是
 *   "最后一下整段刷出来"。
 * - 刷新后从后端恢复的 Run：历史消息本来就带标准 text part，交给它渲染，
 *   免得 hydrate 落地时再闪一次；除非它还在执行（那时还没有 text part）。
 */
function usesRunAnswer(run: AgentRunViewModel | null): run is AgentRunViewModel {
    if (!run?.answer) return false
    if (!run.hydrated) return true
    return run.status === "starting" || run.status === "running"
}

/** 实时答案：从结构化 delta 渲染，并一路渲染到终态 */
export function AgentStreamingAnswer() {
    const run = useCurrentAgentRun()
    if (!usesRunAnswer(run)) return null
    const running = run.status === "starting" || run.status === "running"
    const text = annotateNormalQaWikiMentions(run.answer, run.wikiMentionTargets ?? [])

    return (
        <div aria-live="polite" aria-label={running ? "回答生成中" : "回答"}>
            <QaStreamingMarkdown text={text} running={running} />
        </div>
    )
}

/**
 * 标准 text part 的渲染。
 * Run 正在接管答案时让位，避免同一段内容渲染两遍；
 * 旧链路没有 AgentRun，继续沿用原来的逐字流式渲染。
 */
export function AgentAnswerText() {
    const run = useCurrentAgentRun()
    const { text, status } = useMessagePartText()
    if (usesRunAnswer(run)) return null
    return <QaStreamingMarkdown text={text} running={!run && status?.type === "running"} />
}

/** 运行中的停止按钮（挂在面板外，确保移动端也始终可达，§162.31） */
export function AgentStopButton() {
    return (
        <ComposerPrimitive.Cancel asChild>
            <button
                type="button"
                className="rounded-md border border-border/60 px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
                停止
            </button>
        </ComposerPrimitive.Cancel>
    )
}

/**
 * 答案下方的引用条（§162.17/§162.18）。
 *
 * 正文中的 [n] 保持纯文本，这里给出可点击、可 hover 预览的编号入口，
 * 编号与 Evidence 建立稳定映射。
 */
export function AgentCitationBar() {
    const run = useCurrentAgentRun()
    const cited = useMemo(() => {
        if (!run) return []
        const used = new Set(
            (run.answer.match(/\[(\d{1,2})\]/g) ?? []).map((token) => Number(token.slice(1, -1))),
        )
        // 答案没有显式标注时，退化为展示全部来源编号
        return used.size > 0
            ? run.evidence.filter((item) => used.has(item.citationIndex))
            : run.evidence
    }, [run])

    if (!run || cited.length === 0) return null

    return (
        <div className="not-prose mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">来源</span>
            {cited.map((evidence) => (
                <AgentCitation key={evidence.id} evidence={evidence} />
            ))}
        </div>
    )
}
