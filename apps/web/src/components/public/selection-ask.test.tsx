// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { streamPublicSelectionAsk } = vi.hoisted(() => ({ streamPublicSelectionAsk: vi.fn() }))

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  streamPublicSelectionAsk,
}))
vi.mock("@/features/pages/ask/visitor-fingerprint", () => ({
  getVisitorFingerprint: () => Promise.resolve("0123456789abcdef0123456789abcdef"),
}))
vi.mock("@/components/theme-provider", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }))
// 回答渲染器是 LobeHub Markdown，这里只关心传进去的文字。
vi.mock("@/features/pages/knowledge/QaMarkdown", () => ({
  QaMarkdownScope: ({ children }: { children: React.ReactNode }) => children,
  QaStreamingMarkdown: ({ text }: { text: string }) => <p>{text}</p>,
}))

import { PublicSelectionAskError, type PublicSelectionAskSource } from "@/lib/api"
import { computeSelectionAnchor, selectionPanelWidth } from "./selection-ask"
import { SelectionAskToolbar } from "./selection-ask-toolbar"

const source: PublicSelectionAskSource = { kind: "wiki", knowledgeBaseId: "3", pageKey: "cache-breakdown" }

describe("computeSelectionAnchor", () => {
  const origin = { top: 100, left: 40 }

  it("以选区中点为锚，换算成相对容器的坐标，空间足够时放在上方", () => {
    const anchor = computeSelectionAnchor({
      box: { top: 500, bottom: 520, left: 400, width: 200 },
      origin,
      viewportWidth: 1280,
      coarsePointer: false,
    })
    expect(anchor).toEqual({ x: 460, y: 400, placement: "above" })
  })

  it("按展开后的面板宽度夹在视口内，避免贴边溢出", () => {
    const half = selectionPanelWidth(1280) / 2
    const left = computeSelectionAnchor({
      box: { top: 500, bottom: 520, left: 0, width: 10 },
      origin,
      viewportWidth: 1280,
      coarsePointer: false,
    })
    expect(left.x + origin.left).toBe(16 + half)
    const right = computeSelectionAnchor({
      box: { top: 500, bottom: 520, left: 1270, width: 10 },
      origin,
      viewportWidth: 1280,
      coarsePointer: false,
    })
    expect(right.x + origin.left).toBe(1280 - 16 - half)
  })

  it("视口上方空间不足或触屏时改到选区下方", () => {
    const box = { top: 120, bottom: 140, left: 400, width: 100 }
    expect(computeSelectionAnchor({ box, origin, viewportWidth: 1280, coarsePointer: false }))
      .toMatchObject({ placement: "below", y: 40 })
    expect(computeSelectionAnchor({ box: { ...box, top: 600, bottom: 620 }, origin, viewportWidth: 1280, coarsePointer: true }))
      .toMatchObject({ placement: "below", y: 520 })
  })

  it("窄屏面板宽度随视口收窄，两侧各留 16px", () => {
    expect(selectionPanelWidth(1280)).toBe(352)
    expect(selectionPanelWidth(375)).toBe(343)
  })
})

describe("SelectionAskToolbar", () => {
  beforeEach(() => {
    streamPublicSelectionAsk.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  function renderToolbar() {
    const onAsk = vi.fn()
    const view = render(
      <SelectionAskToolbar source={source} text="缓存击穿" askMode={false} panelWidth={352} onAsk={onAsk} />,
    )
    // 父组件收到 onAsk 后切换到提问态。
    onAsk.mockImplementation(() => {
      view.rerender(<SelectionAskToolbar source={source} text="缓存击穿" askMode panelWidth={352} onAsk={onAsk} />)
    })
    return { onAsk }
  }

  it("点「解释」直接发问，流式展示回答并提示剩余额度", async () => {
    streamPublicSelectionAsk.mockImplementation(async (_request, options: { onDelta: (delta: string) => void }) => {
      options.onDelta("热点键过期瞬间")
      options.onDelta("被大量请求同时击穿。")
      return { remaining: 17, limit: 20 }
    })
    const { onAsk } = renderToolbar()

    fireEvent.click(screen.getByRole("button", { name: "解释" }))

    expect(onAsk).toHaveBeenCalledTimes(1)
    expect(await screen.findByText("热点键过期瞬间被大量请求同时击穿。")).toBeTruthy()
    expect(screen.getByText(/本小时还可问 17 次/)).toBeTruthy()
    expect(streamPublicSelectionAsk.mock.calls[0]?.[0]).toEqual({ source, selection: "缓存击穿", question: "解释这段内容" })
  })

  it("点「问 AI」聚焦输入框；输入法组词时的回车不发送，空问题回落为解释", async () => {
    streamPublicSelectionAsk.mockResolvedValue({ remaining: 19, limit: 20 })
    // jsdom 不实现 inert 的聚焦拦截，这里记录每次聚焦时输入框是否仍在 inert 子树里。
    const originalFocus = HTMLElement.prototype.focus
    const focusedInsideInert: boolean[] = []
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options) {
      focusedInsideInert.push(Boolean(this.closest("[inert]")))
      originalFocus.call(this, options)
    })
    renderToolbar()
    fireEvent.click(screen.getByRole("button", { name: "问 AI" }))
    const input = screen.getByRole("textbox", { name: "就选中的内容提问" })
    expect(document.activeElement).toBe(input)
    expect(focusedInsideInert).toEqual([false])
    focusSpy.mockRestore()

    fireEvent.keyDown(input, { key: "Enter", isComposing: true })
    expect(streamPublicSelectionAsk).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(streamPublicSelectionAsk).toHaveBeenCalledTimes(1))
    expect(streamPublicSelectionAsk.mock.calls[0]?.[0]).toMatchObject({ question: "解释这段内容" })
  })

  it("限流时展示服务端文案，只给换问题的出口", async () => {
    streamPublicSelectionAsk.mockRejectedValue(
      new PublicSelectionAskError("划词提问次数已达每小时 20 次的上限，请 5 分钟后再试", 429),
    )
    renderToolbar()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "翻译" }))
    })

    expect((await screen.findByRole("alert")).textContent).toContain("每小时 20 次的上限")
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull()
    expect(screen.getByRole("button", { name: "换个问题" })).toBeTruthy()
  })

  it("服务端异常可以重试同一个问题", async () => {
    streamPublicSelectionAsk
      .mockRejectedValueOnce(new PublicSelectionAskError("AI 回答失败，请稍后再试", 500))
      .mockResolvedValueOnce({ remaining: 18, limit: 20 })
    renderToolbar()

    fireEvent.click(screen.getByRole("button", { name: "解释" }))
    fireEvent.click(await screen.findByRole("button", { name: "重试" }))

    await waitFor(() => expect(streamPublicSelectionAsk).toHaveBeenCalledTimes(2))
    expect(streamPublicSelectionAsk.mock.calls[1]?.[0]).toMatchObject({ question: "解释这段内容" })
  })
})
