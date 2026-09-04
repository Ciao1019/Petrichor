// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"

import { scrollToHeading } from "@/features/pages/public/public-article-utils"

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
  window.history.replaceState(null, "", "/")
})

describe("scrollToHeading", () => {
  it("允许移动目录显式使用即时滚动并保留标题偏移", () => {
    const heading = document.createElement("h2")
    heading.id = "准备工作"
    heading.style.scrollMarginTop = "48px"
    document.body.append(heading)

    vi.spyOn(heading, "getBoundingClientRect").mockReturnValue({
      bottom: 672,
      height: 32,
      left: 0,
      right: 300,
      top: 640,
      width: 300,
      x: 0,
      y: 640,
      toJSON: () => ({}),
    })
    vi.spyOn(window, "scrollY", "get").mockReturnValue(120)
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined)

    expect(scrollToHeading("准备工作", "auto")).toBe(true)
    expect(scrollTo).toHaveBeenCalledWith({ top: 712, behavior: "auto" })
    expect(decodeURIComponent(window.location.hash.slice(1))).toBe("准备工作")
  })
})
