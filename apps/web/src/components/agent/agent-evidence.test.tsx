// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { AgentEvidenceCard, evidenceHref } from "./agent-evidence"
import type { EvidenceViewModel } from "@/features/agent-runs/types"

const chapterEvidence: EvidenceViewModel = {
    id: "e1",
    source: "knowledge",
    title: "3.2 Consumer Group",
    snippet: "消费者组会记录每条消息的确认状态。",
    nodeKey: "article-12-node-3",
    articleId: "12",
    knowledgeBaseId: "5",
    path: ["Redis 架构设计", "消息队列", "3.2 Consumer Group"],
    citationIndex: 1,
}

afterEach(() => cleanup())

describe("知识库章节溯源", () => {
    it("链接携带章节标识、目录词和命中片段", () => {
        const href = evidenceHref(chapterEvidence)
        expect(href).not.toBeNull()

        const url = new URL(href!, "https://petrichor.local")
        expect(url.pathname).toBe("/dashboard/knowledge/5/articles/12")
        expect(url.searchParams.get("citeIndex")).toBe("1")
        expect(url.searchParams.get("citeSourceId")).toBe("article-12-node-3")
        expect(url.searchParams.get("citeChunkId")).toBe("article-12-node-3")
        expect(url.searchParams.get("citeSnippet")).toContain("消费者组")
        expect(url.searchParams.get("citeTerms")?.split("\n")).toEqual([
            "3.2 Consumer Group",
            "Redis 架构设计",
            "消息队列",
        ])
    })

    it("来源卡明确展示章节序号、目录、片段和章节入口", () => {
        render(<AgentEvidenceCard evidence={chapterEvidence} chapterPosition={{ index: 1, total: 2 }} />)

        expect(screen.getByText("章节 1/2")).toBeTruthy()
        expect(screen.getByText("3.2 Consumer Group")).toBeTruthy()
        expect(screen.getByText(/Redis 架构设计 \/ 消息队列/)).toBeTruthy()
        expect(screen.getByText(/消费者组会记录每条消息/)).toBeTruthy()
        const link = screen.getByRole("link", { name: /查看本章节/ })
        expect(link.getAttribute("href")).toContain("citeChunkId=article-12-node-3")
    })

    it("显式公开 URL 优先于后台章节链接", () => {
        const href = evidenceHref({ ...chapterEvidence, url: "/p/public-share-code" })
        expect(href).toBe("/p/public-share-code")
    })
})
