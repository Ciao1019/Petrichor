// @vitest-environment jsdom
import * as React from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { QaChatPanel } from "./AssistantChatPanel"
import { AssistantChatPage } from "./AssistantChatPage"

const api = vi.hoisted(() => ({
  threadList: vi.fn(), threadDetail: vi.fn(),
  knowledgeBaseList: vi.fn(), listLibraries: vi.fn(), modelInfo: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  assistantApi: api,
  knowledgeBaseQaApi: api,
  docLibraryApi: api,
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))
vi.mock("@/features/agent-runs/hydrate", () => ({ hydrateRunsFromMessages: vi.fn() }))
vi.mock("@/lib/gsap", () => ({ gsap: { set: vi.fn(), to: () => ({ kill: vi.fn() }) } }))
vi.mock("./assistant-tool-renders", () => ({
  EmptyHint: ({ message }: { message: string }) => <p>{message}</p>,
  LoadingRows: () => <p>加载列表中</p>,
}))
vi.mock("./AssistantChatPanel", () => ({
  QaChatPanel: function Panel({ threadId, focusSelection, selectedConfigId, onConfigChange }: React.ComponentProps<typeof QaChatPanel>) {
    const [draft, setDraft] = React.useState("")
    return (
      <div data-testid="chat-panel">
        <output data-testid="thread">{threadId ?? "draft"}</output>
        <output data-testid="scope">{JSON.stringify(focusSelection)}</output>
        <output data-testid="model">{selectedConfigId}</output>
        <button onClick={() => onConfigChange("model-2")}>选择模型二</button>
        <textarea aria-label="消息" value={draft} onChange={(event) => setDraft(event.target.value)} />
      </div>
    )
  },
}))

const thread = {
  id: "thread-1", title: "已保存的对话", focus: { kind: "knowledge", knowledgeBaseId: "kb-1" },
  createdAt: "2026-09-11T00:00:00Z", updatedAt: "2026-09-11T00:00:00Z",
}
const detail = { data: { thread, messages: [], plans: [] } }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query.includes("prefers-reduced-motion"), media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })))
  api.threadList.mockResolvedValue({ data: { items: [thread], nextCursor: null } })
  api.threadDetail.mockResolvedValue(detail)
  api.knowledgeBaseList.mockResolvedValue({ data: { knowledgeBases: [] } })
  api.listLibraries.mockResolvedValue({ data: { libraries: [] } })
  api.modelInfo.mockResolvedValue({ data: { configId: "model-1", modelId: "test", availableModels: [] } })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderPage() {
  return render(<TooltipProvider><AssistantChatPage /></TooltipProvider>)
}

function newThreadButton() {
  return within(screen.getByLabelText("对话操作")).getByRole("button", { name: "新建对话" })
}

describe("助手新建对话", () => {
  it("隐藏历史后仍可新建，清空草稿并保留模型、范围及历史", async () => {
    const { container } = renderPage()
    fireEvent.click(await screen.findByRole("button", { name: /已保存的对话/ }))
    await waitFor(() => expect(screen.getByTestId("thread").textContent).toBe("thread-1"))
    fireEvent.click(screen.getByRole("button", { name: "选择模型二" }))
    const scope = screen.getByTestId("scope").textContent
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "未发送草稿" } })
    fireEvent.pointerDown(screen.getByTestId("chat-panel"))

    expect(container.querySelector("aside")?.hasAttribute("inert")).toBe(true)
    fireEvent.click(newThreadButton())

    expect(screen.getByTestId("thread").textContent).toBe("draft")
    expect((screen.getByRole("textbox", { name: "消息" }) as HTMLTextAreaElement).value).toBe("")
    expect(screen.getByTestId("model").textContent).toBe("model-2")
    expect(screen.getByTestId("scope").textContent).toBe(scope)
    expect(container.querySelector("aside")?.hasAttribute("inert")).toBe(true)

    fireEvent.click(screen.getByRole("button", { name: "展开对话列表" }))
    fireEvent.click(screen.getByRole("button", { name: /已保存的对话/ }))
    await waitFor(() => expect(screen.getByTestId("thread").textContent).toBe("thread-1"))
  })

  it("新建后忽略迟到的历史响应", async () => {
    let resolveDetail!: (value: typeof detail) => void
    api.threadDetail.mockReturnValueOnce(new Promise((resolve) => { resolveDetail = resolve }))
    renderPage()
    fireEvent.click(await screen.findByRole("button", { name: /已保存的对话/ }))
    expect(within(screen.getByLabelText("对话操作")).getByRole("status")).toBeTruthy()
    fireEvent.click(newThreadButton())
    await act(async () => { resolveDetail(detail) })

    expect(screen.getByTestId("thread").textContent).toBe("draft")
    expect(within(screen.getByLabelText("对话操作")).queryByRole("status")).toBeNull()
  })

  it("连续选择历史时，以最后一次选择为准", async () => {
    const secondThread = { ...thread, id: "thread-2", title: "另一段对话" }
    api.threadList.mockResolvedValue({ data: { items: [thread, secondThread], nextCursor: null } })
    let resolveFirst!: (value: typeof detail) => void
    api.threadDetail
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ data: { ...detail.data, thread: secondThread } })
    renderPage()
    fireEvent.click(await screen.findByRole("button", { name: /已保存的对话/ }))
    fireEvent.click(screen.getByRole("button", { name: /另一段对话/ }))
    await waitFor(() => expect(screen.getByTestId("thread").textContent).toBe("thread-2"))
    await act(async () => { resolveFirst(detail) })
    expect(screen.getByTestId("thread").textContent).toBe("thread-2")
  })
})
