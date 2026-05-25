import { describe, expect, it } from "vitest"

import { resolveSignedUrlPublicAccess } from "./use-signed-url"

describe("resolveSignedUrlPublicAccess", () => {
  it("未显式指定时继承公开访问上下文", () => {
    expect(resolveSignedUrlPublicAccess(undefined, true)).toBe(true)
    expect(resolveSignedUrlPublicAccess(undefined, false)).toBe(false)
  })

  it("显式参数优先于上下文，保留编辑器私有下载行为", () => {
    expect(resolveSignedUrlPublicAccess(false, true)).toBe(false)
    expect(resolveSignedUrlPublicAccess(true, false)).toBe(true)
  })
})
