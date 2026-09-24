import { beforeEach, describe, expect, it, vi } from "vitest"

const { load } = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock("@fingerprintjs/fingerprintjs", () => ({ load }))

async function freshModule() {
  vi.resetModules()
  return import("./visitor-fingerprint")
}

describe("getVisitorFingerprint", () => {
  beforeEach(() => {
    load.mockReset()
  })

  it("关闭第三方统计上报，并在多次调用间复用同一次采集", async () => {
    const get = vi.fn().mockResolvedValue({ visitorId: "0123456789abcdef0123456789abcdef" })
    load.mockResolvedValue({ get })
    const { getVisitorFingerprint } = await freshModule()

    await expect(getVisitorFingerprint()).resolves.toBe("0123456789abcdef0123456789abcdef")
    await expect(getVisitorFingerprint()).resolves.toBe("0123456789abcdef0123456789abcdef")
    expect(load).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledWith({ monitoring: false })
    expect(get).toHaveBeenCalledTimes(1)
  })

  it("采集失败时返回空串，下次调用重新尝试", async () => {
    load.mockRejectedValueOnce(new Error("blocked"))
    load.mockResolvedValueOnce({ get: vi.fn().mockResolvedValue({ visitorId: "ffffffffffffffffffffffffffffffff" }) })
    const { getVisitorFingerprint } = await freshModule()

    await expect(getVisitorFingerprint()).resolves.toBe("")
    await expect(getVisitorFingerprint()).resolves.toBe("ffffffffffffffffffffffffffffffff")
    expect(load).toHaveBeenCalledTimes(2)
  })
})
