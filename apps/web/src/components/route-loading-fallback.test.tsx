// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { RouteLoadingFallback } from "@/components/route-loading-fallback"

afterEach(cleanup)

describe("RouteLoadingFallback", () => {
  it("公开前台使用静默占位，避免懒加载文案瞬时闪现", () => {
    const { container } = render(<RouteLoadingFallback silent />)

    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.queryByText("页面加载中…")).toBeNull()
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true")
  })

  it("后台慢加载时仍提供可访问的状态提示", () => {
    render(<RouteLoadingFallback />)

    expect(screen.getByRole("status").textContent).toContain("页面加载中…")
  })
})
