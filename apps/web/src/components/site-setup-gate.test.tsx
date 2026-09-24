// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"

const setupStatus = vi.fn()

vi.mock("@/lib/api", () => ({
  authApi: {
    setup: vi.fn(),
    setupStatus: (...args: unknown[]) => setupStatus(...args),
  },
}))

vi.mock("@/lib/demo/demo-mode", () => ({
  isDemoMode: () => false,
  isDemoOnlyBuild: () => false,
}))

vi.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => null }))
vi.mock("@/components/site-logo", () => ({ SiteLogo: () => null }))

import { SiteSetupGate } from "@/components/site-setup-gate"

beforeEach(() => {
  setupStatus.mockReset()
})

afterEach(cleanup)

function renderGate() {
  return render(
    <MemoryRouter>
      <SiteSetupGate>
        <main>前台正文</main>
      </SiteSetupGate>
    </MemoryRouter>,
  )
}

describe("SiteSetupGate", () => {
  it("站点检查与页面并行，检查完成不会重新挂载正文", async () => {
    let finish!: (value: { data: { required: boolean } }) => void
    setupStatus.mockReturnValue(new Promise((resolve) => { finish = resolve }))

    renderGate()
    const content = screen.getByText("前台正文")

    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.queryByText("正在检查站点状态…")).toBeNull()

    await act(async () => { finish({ data: { required: false } }) })
    expect(screen.getByText("前台正文")).toBe(content)
    expect(setupStatus).toHaveBeenCalledTimes(1)
  })

  it("未初始化站点仍进入管理员设置表单", async () => {
    setupStatus.mockResolvedValue({ data: { required: true } })

    renderGate()

    await screen.findByRole("button", { name: "创建管理员并进入后台" })
    expect(screen.queryByText("前台正文")).toBeNull()
  })

  it("检查失败仍可重试，重试期间直接恢复页面", async () => {
    setupStatus.mockRejectedValueOnce(new Error("offline"))
    setupStatus.mockResolvedValueOnce({ data: { required: false } })
    renderGate()

    fireEvent.click(await screen.findByRole("button", { name: "重新检查" }))
    expect(screen.getByText("前台正文")).toBeTruthy()
    expect(screen.queryByText("正在检查站点状态…")).toBeNull()
    await waitFor(() => expect(setupStatus).toHaveBeenCalledTimes(2))
  })
})
