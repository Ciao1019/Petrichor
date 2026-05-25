import { describe, expect, it } from "vitest"

import {
  shouldRenderPublicArticleBody,
  shouldShowPublicArticleLoadingCard,
  type PublicArticleRenderState,
} from "@/features/pages/public/public-article-render-state"

const baseState: PublicArticleRenderState = {
  hasArticleData: false,
  loading: false,
  error: null,
  needPassword: false,
}

describe("public article render state", () => {
  it("无密码文章初次加载时显示正文骨架", () => {
    expect(shouldShowPublicArticleLoadingCard({
      ...baseState,
      loading: true,
    })).toBe(true)
  })

  it("密码校验过程中不显示正文区域加载态", () => {
    const state: PublicArticleRenderState = {
      ...baseState,
      loading: true,
      needPassword: true,
    }

    expect(shouldShowPublicArticleLoadingCard(state)).toBe(false)
    expect(shouldRenderPublicArticleBody(state)).toBe(false)
  })

  it("密码校验成功并拿到文章数据后渲染正文", () => {
    expect(shouldRenderPublicArticleBody({
      ...baseState,
      hasArticleData: true,
    })).toBe(true)
  })

  it("没有文章数据时不渲染正文标题和标签页兜底内容", () => {
    expect(shouldRenderPublicArticleBody(baseState)).toBe(false)
  })
})
