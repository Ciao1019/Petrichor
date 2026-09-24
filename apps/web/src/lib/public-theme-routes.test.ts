import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"

import { isPublicSitePath, isPublicSitePathByExclusion } from "./public-theme-routes"

const bootScript = readFileSync(new URL("../../index.html", import.meta.url), "utf8")
  .match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ""

function runThemeBoot(pathname: string, storedTheme: string | null, systemDark: boolean) {
  const classes: string[] = []
  const attributes = new Map<string, boolean>()
  runInNewContext(bootScript, {
    location: { pathname },
    localStorage: { getItem: () => storedTheme },
    matchMedia: () => ({ matches: systemDark }),
    document: {
      documentElement: {
        classList: { add: (value: string) => classes.push(value) },
        toggleAttribute: (name: string, enabled: boolean) => attributes.set(name, enabled),
        style: {},
      },
    },
  })
  return { theme: classes[0], publicSite: attributes.get("data-public-site") }
}

describe("public theme routes", () => {
  it("防闪脚本在前后台都恢复用户选择，同时只给前台设置视觉作用域", () => {
    expect(runThemeBoot("/", "light", true)).toEqual({ theme: "light", publicSite: true })
    expect(runThemeBoot("/wiki/12/page", "dark", false)).toEqual({ theme: "dark", publicSite: true })
    expect(runThemeBoot("/dashboard", "light", true)).toEqual({ theme: "light", publicSite: false })
    expect(runThemeBoot("/login", "dark", false)).toEqual({ theme: "dark", publicSite: false })
  })

  it("防闪脚本在无有效偏好时跟随系统", () => {
    expect(runThemeBoot("/", null, false).theme).toBe("light")
    expect(runThemeBoot("/", "system", true).theme).toBe("dark")
    expect(runThemeBoot("/", "invalid", false).theme).toBe("light")
  })

  it("公开前台路由使用独立的视觉作用域", () => {
    expect(isPublicSitePath("/")).toBe(true)
    expect(isPublicSitePath("/tags")).toBe(true)
    expect(isPublicSitePath("/tags/")).toBe(true)
    expect(isPublicSitePath("/graph")).toBe(true)
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
  // 否则会出现公开页主题作用域在首屏和 React 加载后不一致的闪烁回归
  it("防闪脚本的排除式判定与正向判定结论一致", () => {
    const appRoutes = [
      "/", "/tags", "/tags/", "/graph", "/ask", "/about", "/projects", "/petrichor",
      "/p/shareCode123", "/b/burnCode123",
      "/dashboard", "/dashboard/knowledge", "/dashboard/admin/site-graph",
      "/login", "/auth/callback", "/demo",
    ]
    for (const route of appRoutes) {
      expect([route, isPublicSitePathByExclusion(route)])
        .toEqual([route, isPublicSitePath(route)])
    }
  })
})
