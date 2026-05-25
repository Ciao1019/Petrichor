import { describe, expect, it } from "vitest"

import { isPublicLightThemePath } from "./public-theme-routes"

describe("public theme routes", () => {
  it("公开前台路由强制白天模式", () => {
    expect(isPublicLightThemePath("/")).toBe(true)
    expect(isPublicLightThemePath("/tags")).toBe(true)
    expect(isPublicLightThemePath("/tags/")).toBe(true)
    expect(isPublicLightThemePath("/about")).toBe(true)
    expect(isPublicLightThemePath("/p/shareCode123")).toBe(true)
  })

  it("后台和登录页保留普通主题切换", () => {
    expect(isPublicLightThemePath("/dashboard")).toBe(false)
    expect(isPublicLightThemePath("/dashboard/knowledge")).toBe(false)
    expect(isPublicLightThemePath("/login")).toBe(false)
    expect(isPublicLightThemePath("/auth/callback")).toBe(false)
  })
})
