// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  MobileTocDrawer,
  PublicArticleFloatingToc,
} from "@/features/pages/public/PublicArticlePanels"

afterEach(cleanup)

describe("PublicArticleFloatingToc", () => {
  it("点击桌面目录时保留正文平滑滚动，且不并发滚动目录容器", () => {
    const onTocClick = vi.fn()

    render(
      <PublicArticleFloatingToc
        navToc={[{ id: "准备工作", level: 2, text: "准备工作" }]}
        activeHeadingId=""
        onTocClick={onTocClick}
      />,
    )

    const toc = screen.getByRole("navigation", { name: "目录" })
    const scrollTo = vi.fn()
    Object.defineProperty(toc, "scrollTo", { configurable: true, value: scrollTo })

    fireEvent.click(screen.getByRole("button", { name: "准备工作" }))

    expect(onTocClick).toHaveBeenCalledWith("准备工作")
    expect(scrollTo).not.toHaveBeenCalled()
  })
})

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
