// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { RouteLoadingFallback } from "@/components/route-loading-fallback"

afterEach(cleanup)

describe("RouteLoadingFallback", () => {
  it("所有页面都使用静默占位，避免懒加载提示反复闪现", () => {
    const { container } = render(<RouteLoadingFallback />)

    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.queryByText("页面加载中…")).toBeNull()
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true")
  })

})
