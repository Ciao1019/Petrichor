import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { authApi } from "./api-core"
import { getAuthSessionGeneration, resetAuthSession, subscribeAuthSessionReset } from "./auth-session-events"

const mocks = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }))
vi.mock("@/lib/api-client", () => ({ api: mocks }))

const credentials = { email: "user@example.test", password: "test-password" }
const entryPoints = [
  { name: "setup", url: "/auth/setup", data: { ...credentials, username: "测试" }, invoke: () => authApi.setup({ ...credentials, username: "测试" }) },
  { name: "login", url: "/auth/login", data: credentials, invoke: () => authApi.login(credentials) },
  { name: "register", url: "/auth/register", data: { ...credentials, name: "测试" }, invoke: () => authApi.register({ ...credentials, name: "测试" }) },
  { name: "linuxDoCallback", url: "/auth/linuxdo/callback", data: { code: "test-code", state: "test-state" }, invoke: () => authApi.linuxDoCallback("test-code", "test-state") },
]
const unsubscribes: Array<() => void> = []
function listen(listener = vi.fn()) {
  unsubscribes.push(subscribeAuthSessionReset(listener))
  return listener
}
beforeEach(() => vi.resetAllMocks())
afterEach(() => unsubscribes.splice(0).forEach((unsubscribe) => unsubscribe()))

describe("认证会话轻量事件", () => {
  it("浏览器外安全，同步递增围栏并允许取消订阅", () => {
    expect(typeof window).toBe("undefined")
    const generation = getAuthSessionGeneration()
    const listener = listen()
    resetAuthSession()
    expect(getAuthSessionGeneration()).toBe(generation + 1)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribes.splice(0).forEach((unsubscribe) => unsubscribe())
    resetAuthSession()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it.each(entryPoints)("$name 成功交还调用方之前触发清理，保留请求和原响应", async ({ invoke, url, data }) => {
    const listener = listen()
    const generation = getAuthSessionGeneration()
    const response = { data: { mode: "login" }, status: 200 }
    let resolve!: (value: typeof response) => void
    mocks.post.mockReturnValueOnce(new Promise<typeof response>((yes) => { resolve = yes }))
    const pending = invoke().then((value) => {
      expect(listener).toHaveBeenCalledTimes(1)
      expect(getAuthSessionGeneration()).toBe(generation + 1)
      return value
    })
    expect(listener).not.toHaveBeenCalled()
    expect(getAuthSessionGeneration()).toBe(generation)
    resolve(response)
    expect(await pending).toBe(response)
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(url, data)
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it.each(entryPoints)("$name 失败保留会话及原错误", async ({ invoke }) => {
    const listener = listen()
    const generation = getAuthSessionGeneration()
    const error = new Error("认证失败")
    mocks.post.mockRejectedValueOnce(error)
    await expect(invoke()).rejects.toBe(error)
    expect(listener).not.toHaveBeenCalled()
    expect(getAuthSessionGeneration()).toBe(generation)
  })

  it.each([false, true])("logout 失败=%s 时 finally 都清理，保留返回值或错误", async (failed) => {
    const listener = listen()
    const response = { data: { success: true } }
    const error = new Error("退出失败")
    if (failed) mocks.post.mockRejectedValueOnce(error)
    else mocks.post.mockResolvedValueOnce(response)
    if (failed) await expect(authApi.logout()).rejects.toBe(error)
    else expect(await authApi.logout()).toBe(response)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/auth/logout")
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it("订阅者异常不阻断其他清理，也不覆盖认证结果或退出错误", async () => {
    listen(vi.fn(() => { throw new Error("订阅者异常") }))
    const listener = listen()
    const response = { data: { mode: "bind" } }
    mocks.post.mockResolvedValueOnce(response)
    expect(await authApi.linuxDoCallback("test-code")).toBe(response)
    const error = new Error("退出请求异常")
    mocks.post.mockImplementationOnce(() => { throw error })
    await expect(authApi.logout()).rejects.toBe(error)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("普通身份读取不清理恢复状态，不额外请求 me", async () => {
    const listener = listen()
    mocks.get.mockResolvedValue({ data: {} })
    await authApi.me()
    await authApi.profile()
    await authApi.setupStatus()
    expect(listener).not.toHaveBeenCalled()
    expect(mocks.get).toHaveBeenCalledTimes(3)
    expect(mocks.post).not.toHaveBeenCalled()
  })
})
