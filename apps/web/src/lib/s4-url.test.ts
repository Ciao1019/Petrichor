import { describe, expect, it } from "vitest"

import { isS4ObjectUrl, normalizeS4ObjectKey, normalizeS4ObjectUrl } from "./s4-url"

describe("s4-url", () => {
  it("规范化 s4key 和裸 uploads 对象路径", () => {
    expect(normalizeS4ObjectKey("s4key:uploads/2/a.webp")).toBe("uploads/2/a.webp")
    expect(normalizeS4ObjectKey("/uploads/2/a.webp")).toBe("uploads/2/a.webp")
    expect(normalizeS4ObjectUrl("uploads/2/a.webp")).toBe("s4key:uploads/2/a.webp")
  })

  it("拒绝非对象存储路径", () => {
    expect(isS4ObjectUrl("https://example.com/a.webp")).toBe(false)
    expect(normalizeS4ObjectKey("assets/a.webp")).toBeNull()
  })
})
