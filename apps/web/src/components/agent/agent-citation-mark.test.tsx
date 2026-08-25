// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EvidenceViewModel } from "@/features/agent-runs/types"

const mocks = vi.hoisted(() => ({
    useCurrentAgentRunEvidence: vi.fn(),
}))

vi.mock("@/features/agent-runs/use-current-run", () => ({
    useCurrentAgentRunEvidence: mocks.useCurrentAgentRunEvidence,
}))

import { AgentCitationMark } from "./agent-citation-mark"

const evidence: EvidenceViewModel = {
    id: "e1",
    source: "knowledge",
    title: "Mole",
    citationIndex: 1,
}

beforeEach(() => {
    mocks.useCurrentAgentRunEvidence.mockReturnValue(evidence)
})

afterEach(() => cleanup())

describe("回答正文引用", () => {
    it("有真实来源映射时不在句末重复渲染角标", () => {
        const { container } = render(<AgentCitationMark data-citation-index="1" />)
        expect(container.firstChild).toBeNull()
    })

    it("没有来源映射时保留原文，避免误删普通数字方括号", () => {
        mocks.useCurrentAgentRunEvidence.mockReturnValue(null)
        render(<AgentCitationMark data-citation-index="7" />)
        expect(screen.getByText("[7]")).toBeTruthy()
    })
})
