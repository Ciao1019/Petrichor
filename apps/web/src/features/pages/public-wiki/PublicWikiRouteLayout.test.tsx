// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { lazy } from "react"
import { Link, MemoryRouter, Route, Routes, useNavigate } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PublicWikiPageDetail } from "@/lib/api"

const api = vi.hoisted(() => ({ detail: vi.fn() }))
vi.mock("@/lib/api", () => ({ publicWikiApi: api }))
vi.mock("@/features/pages/blog/RetypesetSiteChrome", () => ({
  RetypesetSiteHeader: () => <header>站点标题</header>,
  RetypesetSiteNav: () => <nav aria-label="站点导航"><Link to="/wiki/1/second">下一页</Link></nav>,
  RetypesetSiteFooter: () => <footer>页脚</footer>,
}))
vi.mock("@/components/iconimate", () => {
  const Dummy = () => null
  return {
    ArrowRight: Dummy,
    BookOpen: Dummy,
    CheckCircle2: Dummy,
    ChevronLeft: Dummy,
    ChevronRight: Dummy,
    Clock: Dummy,
    FileStack: Dummy,
    GitForkIcon: Dummy,
    List: Dummy,
    RefreshCw: Dummy,
    Search: Dummy,
    Sparkles: Dummy,
    Tags: Dummy,
    X: Dummy,
  }
})
vi.mock("@/components/plate/PlateMarkdownPreview", () => ({
  PlateMarkdownPreview: ({ markdown }: { markdown: string }) => <p>{markdown}</p>,
}))

import { PublicWikiPage } from "./PublicWikiPage"
import { PublicWikiRouteLayout } from "./PublicWikiRouteLayout"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function page(pageKey: string): PublicWikiPageDetail {
  return {
    knowledgeBaseId: "1", knowledgeBaseName: "知识库", pageKey, title: pageKey,
    kind: "concept", summary: "", aliases: [], categoryPath: [], href: `/wiki/1/${pageKey}`,
    updatedAt: "2026-09-10", contentMd: `正文 ${pageKey}`, links: [], inLinks: [], sourceArticles: [],
  }
}

function HistoryControls() {
  const navigate = useNavigate()
  return <><button onClick={() => navigate(-1)}>后退</button><button onClick={() => navigate(1)}>前进</button></>
}

beforeEach(() => {
  api.detail.mockReset()
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function renderDetail() {
  render(
    <MemoryRouter initialEntries={["/wiki/1/first"]}>
      <Routes>
        <Route path="/wiki" element={<PublicWikiRouteLayout />}>
          <Route path=":knowledgeBaseId/:pageKey" element={<PublicWikiPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe("Wiki 详情页渲染", () => {
  it("渲染标题和正文，不显示重复的导航与分享按钮", async () => {
    api.detail.mockResolvedValue({ data: page("first") })
    renderDetail()
    expect(await screen.findByText("正文 first")).toBeTruthy()
    expect(screen.getByRole("heading", { name: "first" })).toBeTruthy()
    expect(screen.queryByRole("navigation", { name: "面包屑" })).toBeNull()
    expect(screen.queryByRole("button", { name: "复制链接" })).toBeNull()
    expect(screen.queryByRole("link", { name: "返回 Wiki" })).toBeNull()
  })
})

describe("Wiki 左侧切换", () => {
  it("列表进入尚未下载的详情模块时只展示左侧骨架，标题和导航持续挂载", async () => {
    const module = deferred<{ default: () => React.ReactNode }>()
    const Detail = lazy(() => module.promise)
    render(
      <MemoryRouter initialEntries={["/wiki"]}>
        <HistoryControls />
        <Routes>
          <Route path="/wiki" element={<PublicWikiRouteLayout />}>
            <Route index element={<Link to="/wiki/1/first">打开知识页</Link>} />
            <Route path=":knowledgeBaseId/:pageKey" element={<Detail />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    const header = screen.getByRole("banner")
    const nav = screen.getByRole("navigation", { name: "站点导航" })
    fireEvent.click(screen.getByRole("link", { name: "打开知识页" }))
    expect(screen.getByRole("status", { name: "Wiki 页面加载中" }).closest("main")).toBeTruthy()
    expect(screen.getByRole("banner")).toBe(header)
    expect(screen.getByRole("navigation", { name: "站点导航" })).toBe(nav)
    await act(async () => module.resolve({ default: () => <h1>知识正文</h1> }))
    expect(screen.getByRole("heading", { name: "知识正文" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "后退" }))
    expect(screen.getByRole("link", { name: "打开知识页" })).toBeTruthy()
    expect(screen.getByRole("navigation", { name: "站点导航" })).toBe(nav)
    fireEvent.click(screen.getByRole("button", { name: "前进" }))
    expect(screen.getByRole("heading", { name: "知识正文" })).toBeTruthy()
    expect(screen.getByRole("banner")).toBe(header)
  })

  it("连续切换时丢弃旧响应，后退与重试期间不闪现上一篇正文", async () => {
    const first = deferred<{ data: PublicWikiPageDetail }>()
    const second = deferred<{ data: PublicWikiPageDetail }>()
    api.detail.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    render(
      <MemoryRouter initialEntries={["/wiki/1/first"]}>
        <HistoryControls />
        <Routes>
          <Route path="/wiki" element={<PublicWikiRouteLayout />}>
            <Route path=":knowledgeBaseId/:pageKey" element={<PublicWikiPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    const nav = screen.getByRole("navigation", { name: "站点导航" })
    fireEvent.click(screen.getByRole("link", { name: "下一页" }))
    expect(screen.getByRole("status", { name: "Wiki 页面加载中" })).toBeTruthy()
    await act(async () => second.resolve({ data: page("second") }))
    expect(screen.getByText("正文 second")).toBeTruthy()
    await act(async () => first.resolve({ data: page("first") }))
    expect(screen.queryByText("正文 first")).toBeNull()
    expect(screen.getByText("正文 second")).toBeTruthy()
    const back = deferred<{ data: PublicWikiPageDetail }>()
    api.detail.mockReturnValueOnce(back.promise)
    fireEvent.click(screen.getByRole("button", { name: "后退" }))
    expect(screen.queryByText("正文 second")).toBeNull()
    expect(screen.getByRole("status", { name: "Wiki 页面加载中" })).toBeTruthy()
    await act(async () => back.reject(new Error("请求失败")))
    expect(screen.getByText("无法打开这个 Wiki 页面")).toBeTruthy()
    api.detail.mockResolvedValueOnce({ data: page("first") })
    fireEvent.click(screen.getByRole("button", { name: "重试" }))
    expect(await screen.findByText("正文 first")).toBeTruthy()
    expect(screen.getByRole("navigation", { name: "站点导航" })).toBe(nav)
  })
})
