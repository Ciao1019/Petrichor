// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AssistantRunControls } from "./assistant-run-controls"
import { AssistantResumeContext } from "./assistant-run-control-context"

const state = vi.hoisted(() => ({ running: true, recovery: vi.fn(), send: vi.fn() }))
vi.mock("@assistant-ui/react", () => ({ useAuiState: () => state.running }))
vi.mock("@/lib/demo/demo-mode", () => ({ isDemoMode: () => false }))
vi.mock("@/lib/api-assistant-control", () => ({ assistantControlApi: { recovery: state.recovery, send: state.send } }))
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }))

beforeEach(() => {
  state.running = true
  state.recovery.mockResolvedValue({ data: { running: true, available: false } })
  state.send.mockResolvedValue({ data: { accepted: true } })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe("运行控制", () => {
  it("提交补充要求及处理时机", async () => {
    render(<AssistantRunControls threadId="42" />)
    fireEvent.click(screen.getByRole("button", { name: "补充要求" }))
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "保留引用" } })
    fireEvent.change(screen.getByLabelText("处理时机"), { target: { value: "follow_up" } })
    fireEvent.click(screen.getByRole("button", { name: "追加要求" }))
    await waitFor(() => expect(state.send).toHaveBeenCalledWith("42", "follow_up", "保留引用"))
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull())
  })

  it("失败后保留输入", async () => {
    state.send.mockRejectedValue(new Error("offline"))
    render(<AssistantRunControls threadId="42" />)
    fireEvent.click(screen.getByRole("button", { name: "补充要求" }))
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "不要遗漏来源" } })
    fireEvent.click(screen.getByRole("button", { name: "追加要求" }))
    await screen.findByRole("alert")
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("不要遗漏来源")
  })

  it("从保存进度恢复，未知写操作不显示恢复按钮", async () => {
    state.running = false
    state.recovery.mockResolvedValue({ data: { running: false, available: true } })
    const resume = vi.fn()
    render(<AssistantResumeContext.Provider value={resume}><AssistantRunControls threadId="42" /></AssistantResumeContext.Provider>)
    fireEvent.click(await screen.findByRole("button", { name: "从检查点继续" }))
    expect(resume).toHaveBeenCalledOnce()
    cleanup()
    state.recovery.mockResolvedValue({ data: { running: false, available: false, needsReview: true } })
    render(<AssistantRunControls threadId="42" />)
    await screen.findByRole("status")
    expect(screen.queryByRole("button", { name: "从检查点继续" })).toBeNull()
  })
})
