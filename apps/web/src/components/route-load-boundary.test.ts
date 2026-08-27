import { describe, expect, it } from "vitest"

import { isRouteModuleLoadError } from "./route-load-boundary"

describe("isRouteModuleLoadError", () => {
  it("识别 Vite 和浏览器的动态模块加载错误", () => {
    expect(
      isRouteModuleLoadError(
        new TypeError(
          "Failed to fetch dynamically imported module: http://localhost:3000/src/page.tsx",
        ),
      ),
    ).toBe(true)
    expect(isRouteModuleLoadError(new Error("Importing a module script failed"))).toBe(true)
    expect(isRouteModuleLoadError(new Error("ChunkLoadError: Loading chunk 42 failed"))).toBe(true)
  })

  it("不把普通页面异常误判为模块缓存问题", () => {
    expect(isRouteModuleLoadError(new Error("Cannot read properties of undefined"))).toBe(false)
  })
})
