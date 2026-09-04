// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react"
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

import { SiteSetupGate } from "@/components/site-setup-gate"

beforeEach(() => {
  setupStatus.mockReset()
})

afterEach(cleanup)

function renderGate(silentChecking = false) {
  return render(
    <MemoryRouter>
      <SiteSetupGate silentChecking={silentChecking}>
        <main>前台正文</main>
      </SiteSetupGate>
    </MemoryRouter>,
  )
}

describe("SiteSetupGate", () => {
  it("公开前台检查期间保持静默，完成后再挂载正文", async () => {
    setupStatus.mockResolvedValue({ data: { required: false } })

    const { container } = renderGate(true)

    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.queryByText("正在检查站点状态…")).toBeNull()
    expect(screen.queryByText("前台正文")).toBeNull()
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull()

    await waitFor(() => expect(screen.getByText("前台正文")).toBeTruthy())
    expect(setupStatus).toHaveBeenCalledTimes(1)
  })

  it("后台检查期间继续显示状态提示", () => {
    setupStatus.mockReturnValue(new Promise(() => {}))

    renderGate()

    expect(screen.getByRole("status").textContent).toContain("正在检查站点状态…")
    expect(screen.queryByText("前台正文")).toBeNull()
  })
})
