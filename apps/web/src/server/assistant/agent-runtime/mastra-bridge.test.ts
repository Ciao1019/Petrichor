import { describe, expect, it } from "vitest"
import { toModelResult } from "./mastra-bridge"
import type { ToolRunOutcome } from "./tool-executor"
import type { AgentEvidence } from "./types"

function evidence(init: Partial<AgentEvidence> & { content: string }): AgentEvidence {
    return {
        id: init.id ?? "ev-1",
        source: init.source ?? "wiki",
        title: init.title ?? "Wiki 页面",
        createdAt: 0,
        ...init,
    }
}

function outcome(items: AgentEvidence[]): ToolRunOutcome {
    return {
        ok: true,
        observation: { summary: "已读取", evidenceIds: items.map((item) => item.id) },
        evidence: items,
        evidenceCitationIndices: items.map((_item, index) => index + 1),
    } as unknown as ToolRunOutcome
}

type ModelEvidence = { content?: string }

function modelEvidence(result: unknown): ModelEvidence[] {
    return (result as { evidence?: ModelEvidence[] }).evidence ?? []
}

/**
 * 段内回给模型的 tool result 是模型当场唯一能读到的正文。
 * 全文类证据（整张 Wiki 页面）若还按片段的 1,200 字裁，模型会认定页面被截断而绕去读源文档。
 */
describe("toModelResult 的证据预算", () => {
    /** 片段类证据的单条上限，不因全文读取而放宽 */
    const SNIPPET_ITEM_MAX_CHARS = 1_200
    const page = "Wiki 正文段落。".repeat(600)

    it("全文证据完整回传，不按片段上限裁剪", () => {
        const result = toModelResult(outcome([evidence({ content: page, fullRead: true })]))
        expect(modelEvidence(result)[0]?.content).toBe(page)
    })

    it("片段证据仍受 1,200 字上限约束", () => {
        const result = toModelResult(outcome([evidence({ source: "knowledge", content: page })]))
        const content = modelEvidence(result)[0]?.content ?? ""
        expect(content).toContain(page.slice(0, SNIPPET_ITEM_MAX_CHARS))
        expect(content).toContain("本次仅给出前 1200 字")
    })

    it("全文证据不占用片段预算，同一批里的片段证据照样拿得到正文", () => {
        const result = toModelResult(outcome([
            evidence({ id: "ev-page", content: page, fullRead: true }),
            evidence({ id: "ev-chunk", source: "knowledge", content: "章节正文" }),
        ]))
        const items = modelEvidence(result)
        expect(items[0]?.content).toBe(page)
        expect(items[1]?.content).toBe("章节正文")
    })

    it("超出兜底上限时显式告知还剩多少，不静默截断", () => {
        const huge = "超长正文。".repeat(10_000)
        const result = toModelResult(outcome([evidence({ content: huge, fullRead: true })]))
        const content = modelEvidence(result)[0]?.content ?? ""
        expect(content.length).toBeLessThan(huge.length)
        expect(content).toContain(`共 ${huge.length} 字`)
    })
})
