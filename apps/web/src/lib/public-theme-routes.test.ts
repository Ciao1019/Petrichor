import { describe, expect, it } from "vitest"

import { isPublicSitePath, isPublicSitePathByExclusion } from "./public-theme-routes"

describe("public theme routes", () => {
  it("公开前台路由强制暗色主题", () => {
    expect(isPublicSitePath("/")).toBe(true)
    expect(isPublicSitePath("/tags")).toBe(true)
    expect(isPublicSitePath("/tags/")).toBe(true)
    expect(isPublicSitePath("/about")).toBe(true)
    expect(isPublicSitePath("/ask")).toBe(true)
    expect(isPublicSitePath("/projects")).toBe(true)
    expect(isPublicSitePath("/petrichor")).toBe(true)
    expect(isPublicSitePath("/p/shareCode123")).toBe(true)
    expect(isPublicSitePath("/b/burnCode123")).toBe(true)
  })

  it("后台和登录页保留普通主题切换", () => {
    expect(isPublicSitePath("/dashboard")).toBe(false)
    expect(isPublicSitePath("/dashboard/knowledge")).toBe(false)
    expect(isPublicSitePath("/login")).toBe(false)
    expect(isPublicSitePath("/auth/callback")).toBe(false)
  })

  // 首屏防闪脚本用的是反向排除规则，不能与本模块的正向判定分叉，
  // 否则会出现「脚本判为暗、React 判为亮」的闪烁回归
  it("防闪脚本的排除式判定与正向判定结论一致", () => {
    const appRoutes = [
      "/", "/tags", "/tags/", "/ask", "/about", "/projects", "/petrichor",
      "/p/shareCode123", "/b/burnCode123",
      "/dashboard", "/dashboard/knowledge",
      "/login", "/auth/callback", "/demo",
    ]
    for (const route of appRoutes) {
      expect([route, isPublicSitePathByExclusion(route)])
        .toEqual([route, isPublicSitePath(route)])
    }
  })
})
