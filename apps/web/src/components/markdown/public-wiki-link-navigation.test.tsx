// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react"
import type { TLinkElement } from "platejs"
import type { PlateElementProps } from "platejs/react"
import type { ComponentProps } from "react"
import { MemoryRouter, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ readOnly: true }))
vi.mock("platejs/react", () => ({
  useReadOnly: () => state.readOnly,
  PlateElement: ({ attributes, children, className }: {
    attributes: ComponentProps<"a">
    children: React.ReactNode
    className: string
  }) => <a {...attributes} className={className}>{children}</a>,
}))
vi.mock("@platejs/link", () => ({
  getLinkAttributes: (_editor: unknown, element: TLinkElement) => ({ href: element.url, target: element.target }),
}))
vi.mock("@platejs/suggestion/react", () => ({ SuggestionPlugin: {} }))

import { LinkElement } from "@/components/ui/link-node"

function Location() {
  return <output>{useLocation().pathname}</output>
}

function setup({ url = "/wiki/1/next", target, attributes = {}, router = true }: {
  url?: string
  target?: string
  attributes?: ComponentProps<"a">
  router?: boolean
} = {}) {
  const props = {
    element: { type: "a", url, target, children: [{ text: "概念" }] },
    attributes,
    editor: { getApi: () => ({ suggestion: { suggestionData: () => undefined } }) },
    children: <strong>概念</strong>,
  } as unknown as PlateElementProps<TLinkElement>
  const link = <LinkElement {...props} />
  render(router ? <MemoryRouter initialEntries={["/wiki/1/start"]}>{link}<Location /></MemoryRouter> : link)
  return screen.getByRole("link", { name: "概念" })
}

function click(link: HTMLElement, options: MouseEventInit = {}) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...options })
  let defaultPrevented = false
  // 在 React 处理完事件后记录是否接管导航，再阻止 jsdom 真正跳转。
  document.addEventListener("click", (nativeEvent) => {
    defaultPrevented = nativeEvent.defaultPrevented
    nativeEvent.preventDefault()
  }, { once: true })
  act(() => { link.querySelector("strong")!.dispatchEvent(event) })
  return { defaultPrevented }
}

beforeEach(() => { state.readOnly = true })
afterEach(cleanup)

describe("公开 Wiki 波浪线导航", () => {
  it("点击嵌套文字时使用站内导航，取消文档跳转并保留波浪线", () => {
    const link = setup()
    expect(click(link).defaultPrevented).toBe(true)
    expect(screen.getByRole("status").textContent).toBe("/wiki/1/next")
    expect(link.style.backgroundImage).toContain("svg")
  })

  it.each([
    { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 },
  ])("保留修饰键和中键的浏览器行为：%j", (options) => {
    expect(click(setup(), options).defaultPrevented).toBe(false)
    expect(screen.getByRole("status").textContent).toBe("/wiki/1/start")
  })

  it.each([
    { target: "_blank" },
    { attributes: { download: "wiki.md" } },
    { url: "https://example.com/wiki/1/next" },
    { url: "#heading" },
    { router: false },
  ])("不接管新窗口、下载、外链、锚点或独立预览：%j", (options) => {
    expect(click(setup(options)).defaultPrevented).toBe(false)
  })

  it("不接管编辑态链接", () => {
    state.readOnly = false
    expect(click(setup()).defaultPrevented).toBe(false)
  })

  it("尊重链接自身已取消的点击事件", () => {
    const link = setup({ attributes: { onClick: (event) => event.preventDefault() } })
    click(link)
    expect(screen.getByRole("status").textContent).toBe("/wiki/1/start")
  })
})
