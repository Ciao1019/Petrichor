// @vitest-environment jsdom

import { StrictMode } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const apiMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock("@/lib/api-client", () => ({ api: apiMocks }))

import { PublicSiteAuthor } from "@/components/public-site-author"
import { adminAboutProfileApi, publicAboutProfileApi, type AboutProfileResponse } from "@/lib/api-core"

const profile: AboutProfileResponse = {
  displayName: "CiZai",
  roleTitle: "开发者",
  intro: "关于作者",
  expertise: [],
  toolkit: [],
  quote: "Code is just another medium for painting dreams.",
  accents: [],
  contactText: "",
  contactLabel: "",
  contactHref: "",
}

function renderAuthor() {
  return render(<StrictMode><MemoryRouter><PublicSiteAuthor /></MemoryRouter></StrictMode>)
}

beforeEach(() => {
  vi.resetAllMocks()
  window.sessionStorage.clear()
  publicAboutProfileApi.invalidateClientCache()
})

afterEach(cleanup)

describe("前台作者资料", () => {
  it("切换页面重新挂载时立即展示原资料与头像，不再次请求或显示骨架", async () => {
    apiMocks.get.mockResolvedValueOnce({ data: profile })
    const first = renderAuthor()
    expect(screen.getByRole("status", { name: "加载作者信息" })).toBeTruthy()
    await screen.findByRole("link", { name: "关于作者：CiZai" })
    first.unmount()

    const second = renderAuthor()
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.getByText(profile.quote)).toBeTruthy()
    expect(second.container.querySelector("img")?.getAttribute("src")).toBe("/about-avatar.avif")
    expect(apiMocks.get).toHaveBeenCalledTimes(1)
  })

  it("加载中的页面切换复用同一个请求", async () => {
    let resolve!: (response: { data: AboutProfileResponse }) => void
    apiMocks.get.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const first = renderAuthor()
    first.unmount()
    renderAuthor()
    expect(apiMocks.get).toHaveBeenCalledTimes(1)
    await act(async () => { resolve({ data: profile }) })
    expect(screen.getByText(profile.quote)).toBeTruthy()
  })

  it("保存新签名后，较早发出的读取不能覆盖新缓存", async () => {
    let resolve!: (response: { data: AboutProfileResponse }) => void
    apiMocks.get.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const pending = publicAboutProfileApi.detail()
    const updated = { ...profile, quote: "新的个性签名" }
    apiMocks.post.mockResolvedValueOnce({ data: updated })
    await adminAboutProfileApi.update(updated)
    resolve({ data: profile })
    await pending

    renderAuthor()
    expect(screen.getByText(updated.quote)).toBeTruthy()
    expect(screen.queryByRole("status")).toBeNull()
    expect(publicAboutProfileApi.getCachedDetail()).toEqual(updated)
    expect(apiMocks.get).toHaveBeenCalledTimes(1)
  })

  it("真实站点和演示模式分别缓存作者资料", async () => {
    const demo = { ...profile, displayName: "演示作者" }
    apiMocks.get.mockResolvedValueOnce({ data: profile }).mockResolvedValueOnce({ data: demo })
    await publicAboutProfileApi.detail()
    window.sessionStorage.setItem("petrichor-demo-mode", "1")
    expect(publicAboutProfileApi.getCachedDetail()).toBeNull()
    await publicAboutProfileApi.detail()
    expect(publicAboutProfileApi.getCachedDetail()).toEqual(demo)
    window.sessionStorage.removeItem("petrichor-demo-mode")
    expect(publicAboutProfileApi.getCachedDetail()).toEqual(profile)
  })

  it("资料请求失败后可以重试，损坏的头像显示文字回退", async () => {
    apiMocks.get.mockRejectedValueOnce(new Error("暂时不可用")).mockResolvedValueOnce({ data: profile })
    await expect(publicAboutProfileApi.detail()).rejects.toThrow("暂时不可用")
    await publicAboutProfileApi.detail()
    const { container } = renderAuthor()
    const image = container.querySelector("img")!
    fireEvent.error(image)
    expect(image.hidden).toBe(true)
    expect(screen.getByText("CI")).toBeTruthy()
    expect(screen.getByRole("link", { name: "关于作者：CiZai" })).toBeTruthy()
  })
})
