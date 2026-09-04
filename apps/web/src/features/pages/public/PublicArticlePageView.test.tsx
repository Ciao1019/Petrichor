// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/features/pages/blog/RetypesetSiteChrome", () => ({
  RetypesetSiteHeader: () => null,
  RetypesetSiteNav: () => null,
}))

import {
  PublicArticlePageView,
  type PublicArticlePageModel,
} from "@/features/pages/public/PublicArticlePageView"

afterEach(cleanup)

function createLoadingModel(): PublicArticlePageModel {
  return {
    shareCode: undefined,
    shareUrl: "",
    hasArticleData: false,
    loading: true,
    error: null,
    needPassword: false,
    passwordId: "",
    accessPassword: "",
    onAccessPasswordChange: vi.fn(),
    onSubmitPassword: vi.fn(),
    articleRef: { current: null },
    title: "",
    tags: [],
    createdAt: null,
    updatedAt: null,
    aiSummary: null,
    coverImageUrl: null,
    repostSource: null,
    tab: "article",
    onTabChange: vi.fn(),
    contentMd: "",
    tocAll: [],
    activeHeadingId: "",
    onTocClick: vi.fn(),
    mindmapData: null,
  }
}

describe("PublicArticlePageView", () => {
  it("让文章内容层高于桌面侧栏，避免浮动目录点击被侧栏截获", () => {
    const { container } = render(<PublicArticlePageView model={createLoadingModel()} />)

    const content = container.querySelector<HTMLElement>("[data-public-article-content]")

    expect(content?.classList.contains("z-20")).toBe(true)
    expect(content?.classList.contains("lg:z-40")).toBe(true)
  })
})
