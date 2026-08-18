// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { HugeiconsIcon, Loader2, Search, Search01Icon } from "./index"

afterEach(() => cleanup())

describe("Iconimate 图标层", () => {
  it("渲染本地 Phosphor 字形并兼容尺寸与样式属性", () => {
    const { container } = render(
      <Search aria-label="搜索" className="size-5 text-primary" size={20} />,
    )
    const svg = container.querySelector("svg")

    expect(svg?.getAttribute("width")).toBe("20")
    expect(svg?.getAttribute("height")).toBe("20")
    expect(svg?.getAttribute("viewBox")).toBe("0 0 256 256")
    expect(svg?.getAttribute("data-iconimate")).toBe("Search")
    expect(svg?.classList.contains("size-5")).toBe(true)
    expect(svg?.querySelector("path")).toBeTruthy()

    fireEvent.mouseEnter(svg!)
    fireEvent.mouseLeave(svg!)
  })

  it("保留 Hugeicons 的 icon 属性调用方式", () => {
    const { container } = render(
      <HugeiconsIcon icon={Search01Icon} aria-label="查找文档" className="size-4" />,
    )

    expect(container.querySelector("svg")?.getAttribute("data-iconimate")).toBe("Search")
  })

  it("加载图标默认带有 reduced-motion 友好的旋转类", () => {
    const { container } = render(<Loader2 role="status" aria-label="加载中" />)

    expect(container.querySelector("svg")?.classList.contains("motion-safe:animate-spin")).toBe(true)
  })
})
