// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { WikiLinkClickProvider } from "@/components/markdown/wiki-link-context"
import { QaMarkdownScope, QaStreamingMarkdown } from "./QaMarkdown"

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}))

globalThis.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as never
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never

afterEach(cleanup)

describe("QaMarkdown 主题范围", () => {
  it("不注入 CSP 禁止的外部字体与 KaTeX 样式", () => {
    render(
      <QaMarkdownScope>
        <QaStreamingMarkdown text="正文" />
      </QaMarkdownScope>,
    )

    const externalStyles = Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
    ).filter((link) => new URL(link.href).origin !== window.location.origin)
    expect(externalStyles).toEqual([])
  })
})

describe("QaStreamingMarkdown Wiki 表格", () => {
  it("表格内链和正文内链使用同一波浪线样式与点击行为", () => {
    const onOpenWikiPage = vi.fn()
    render(
      <WikiLinkClickProvider onOpenWikiPage={onOpenWikiPage}>
        <QaStreamingMarkdown
          text={[
            "| 功能 | 说明 |",
            "| --- | --- |",
            "| [[concept-deep-clean|深度清理]] | 清理缓存 |",
            "",
            "正文提到 [[entity-homebrew|Homebrew]]，以及 [普通链接](https://example.com)。",
          ].join("\n")}
        />
      </WikiLinkClickProvider>,
    )

    const tableLink = screen.getByRole("link", { name: "深度清理" })
    const paragraphLink = screen.getByRole("link", { name: "Homebrew" })
    const externalLink = screen.getByRole("link", { name: "普通链接" })

    expect(tableLink.closest("td")).toBeTruthy()
    expect(tableLink.style.backgroundImage).toContain("data:image/svg+xml")
    expect(paragraphLink.style.backgroundImage).toContain("data:image/svg+xml")
    expect(externalLink.style.backgroundImage).toBe("")

    fireEvent.click(tableLink)
    expect(onOpenWikiPage).toHaveBeenCalledWith("concept-deep-clean")
  })
})
