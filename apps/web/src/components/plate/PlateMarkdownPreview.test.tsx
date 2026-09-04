// @vitest-environment jsdom

import * as React from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const plateMock = vi.hoisted(() => ({
    setContentVersion: null as React.Dispatch<React.SetStateAction<number>> | null,
    setValue: vi.fn(),
}))

vi.mock("platejs/react", async () => {
    const React = await import("react")

    function Plate({ children }: { children?: React.ReactNode }) {
        return React.createElement(React.Fragment, null, children)
    }

    function PlateContent() {
        const [version, setVersion] = React.useState(0)

        React.useEffect(() => {
            plateMock.setContentVersion = setVersion
            return () => {
                plateMock.setContentVersion = null
            }
        }, [])

        if (version === 0) {
            return React.createElement("div", { "data-testid": "plate-content-empty" })
        }

        const children = [
            React.createElement("h2", { key: "h2" }, "安装 Mole"),
            React.createElement("h3", { key: "h3" }, "安全操作"),
        ]

        return version === 1
            ? React.createElement("div", { "data-testid": "plate-content-v1" }, children)
            : React.createElement("section", { "data-testid": "plate-content-v2" }, children)
    }

    return {
        Plate,
        PlateContent,
        usePlateEditor: () => ({ tf: { setValue: plateMock.setValue } }),
    }
})

vi.mock("@/components/plate/plate-markdown", () => ({
    createPlateMarkdownPlugins: () => [],
    deserializeEditorContent: () => [],
    parseContentMetaJson: () => undefined,
}))

vi.mock("@/hooks/use-signed-url", async () => {
    const React = await import("react")
    return {
        SignedUrlPublicAccessProvider: ({ children }: { children?: React.ReactNode }) =>
            React.createElement(React.Fragment, null, children),
    }
})

import { PlateMarkdownPreview } from "@/components/plate/PlateMarkdownPreview"

const headings = [
    { id: "安装-mole", level: 2 },
    { id: "安全操作", level: 3 },
]

let nextFrameId = 1
let frameCallbacks = new Map<number, FrameRequestCallback>()

async function flushScheduledFrame() {
    await act(async () => {
        await Promise.resolve()
    })

    const callbacks = Array.from(frameCallbacks.values())
    frameCallbacks.clear()
    await act(async () => {
        for (const callback of callbacks) callback(0)
        await Promise.resolve()
    })
}

async function showPlateContent(version: number) {
    const setContentVersion = plateMock.setContentVersion
    expect(setContentVersion).not.toBeNull()
    await act(async () => {
        setContentVersion?.(version)
    })
}

beforeEach(() => {
    nextFrameId = 1
    frameCallbacks = new Map()
    plateMock.setContentVersion = null
    plateMock.setValue.mockClear()
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrameId
        nextFrameId += 1
        frameCallbacks.set(id, callback)
        return id
    }))
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => {
        frameCallbacks.delete(id)
    }))
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

describe("PlateMarkdownPreview 标题 ID 同步", () => {
    it("PlateContent 首次提交后延迟挂载标题时仍会同步传入 ID", async () => {
        render(<PlateMarkdownPreview markdown="## 安装 Mole\n\n### 安全操作" headings={headings} />)

        expect(screen.queryByRole("heading")).toBeNull()
        await flushScheduledFrame()

        await showPlateContent(1)
        await flushScheduledFrame()

        expect(screen.getByRole("heading", { level: 2, name: "安装 Mole" }).getAttribute("id")).toBe("安装-mole")
        expect(screen.getByRole("heading", { level: 3, name: "安全操作" }).getAttribute("id")).toBe("安全操作")
    })

    it("PlateContent 替换正文子树后会为新标题节点重新同步 ID", async () => {
        render(<PlateMarkdownPreview markdown="## 安装 Mole\n\n### 安全操作" headings={headings} />)
        await flushScheduledFrame()
        await showPlateContent(1)
        await flushScheduledFrame()

        const firstHeading = screen.getByRole("heading", { level: 2, name: "安装 Mole" })
        expect(firstHeading.getAttribute("id")).toBe("安装-mole")

        await showPlateContent(2)
        await flushScheduledFrame()

        const replacementHeading = screen.getByRole("heading", { level: 2, name: "安装 Mole" })
        expect(replacementHeading).not.toBe(firstHeading)
        expect(firstHeading.isConnected).toBe(false)
        expect(replacementHeading.getAttribute("id")).toBe("安装-mole")
        expect(screen.getByRole("heading", { level: 3, name: "安全操作" }).getAttribute("id")).toBe("安全操作")
    })
})
