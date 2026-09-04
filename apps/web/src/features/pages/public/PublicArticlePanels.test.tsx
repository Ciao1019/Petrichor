// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { MobileTocDrawer } from "@/features/pages/public/PublicArticlePanels"

afterEach(cleanup)

describe("MobileTocDrawer", () => {
  it("点击目录项时使用即时滚动，避免关闭抽屉打断移动端平滑滚动", () => {
    const calls: string[] = []
    const onClose = vi.fn(() => calls.push("close"))
    const onTocClick = vi.fn(() => calls.push("scroll"))

    render(
      <MobileTocDrawer
        open
        onClose={onClose}
        navToc={[{ id: "准备工作", level: 2, text: "准备工作" }]}
        activeHeadingId=""
        onTocClick={onTocClick}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "准备工作" }))

    expect(onTocClick).toHaveBeenCalledWith("准备工作", "auto")
    expect(onClose).toHaveBeenCalledOnce()
    expect(calls).toEqual(["scroll", "close"])
  })
})
