// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AxiosRequestConfig } from "axios"
import { uploadFileToObjectStorage } from "./object-storage-upload"
import { uploadApi } from "./api-public"

const mocks = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock("@/lib/api-client", () => ({ api: { post: mocks.post } }))
vi.mock("@/lib/api", async () => ({ uploadApi: (await import("@/lib/api-public")).uploadApi }))

type Handler = ((event: ProgressEvent<EventTarget>) => void) | null
class MockXhr {
  static instances: MockXhr[] = []
  status = 200
  readyState = 4
  statusText = "OK"
  responseText = ""
  timeout = 0
  upload: { onprogress: Handler } = { onprogress: null }
  onload: Handler = null
  onerror: Handler = null
  onabort: Handler = null
  ontimeout: Handler = null
  open = vi.fn()
  send = vi.fn()
  abort = vi.fn(() => this.onabort?.(new ProgressEvent("abort")))
  constructor() { MockXhr.instances.push(this) }
}
const file = new File(["pdf"], "scan.pdf", { type: "application/pdf" })
function xhr() {
  const latest = MockXhr.instances.at(-1)
  if (!latest) throw new Error("未创建 XHR")
  return latest
}
function expectCleaned(request: MockXhr) {
  expect(request.upload.onprogress).toBeNull()
  for (const key of ["onload", "onerror", "onabort", "ontimeout"] as const) expect(request[key]).toBeNull()
}
beforeEach(() => {
  mocks.post.mockReset().mockResolvedValue({ data: { presignedUrl: "/api/upload/object/uploads/7/scan.pdf", objectKey: "source-key" } })
  MockXhr.instances = []
  vi.stubGlobal("XMLHttpRequest", MockXhr)
  for (const method of ["info", "debug", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("对象存储上传取消与超时", () => {
  it("对象存储错误通过 Go JSON 契约展示，不再笼统显示网络错误", async () => {
    const upload = uploadFileToObjectStorage(file)
    const outcome = expect(upload).rejects.toThrow("对象存储保存失败（HTTP 403），请稍后重试上传")
    await Promise.resolve()
    xhr().status = 502
    xhr().responseText = JSON.stringify({ code: 502, msg: "对象存储保存失败（HTTP 403），请稍后重试上传" })
    xhr().onload?.(new ProgressEvent("load"))
    await outcome
    expect(xhr().open).toHaveBeenCalledWith("PUT", "/api/upload/object/uploads/7/scan.pdf", true)
  })
  it("本地上传使用同源路径，日志可以解析相对地址", async () => {
    const localURL = "/api/upload/local/uploads/7/scan.pdf"
    mocks.post.mockResolvedValueOnce({ data: { presignedUrl: localURL, objectKey: "uploads/7/scan.pdf" } })
    const upload = uploadFileToObjectStorage(file)
    await Promise.resolve()
    expect(xhr().open).toHaveBeenCalledWith("PUT", localURL, true)
    expect(console.info).toHaveBeenCalledWith("[S4 upload]", "获取服务端上传地址成功", expect.objectContaining({
      target: expect.objectContaining({ origin: window.location.origin, pathname: localURL }),
    }))
    xhr().onload?.(new ProgressEvent("load"))
    await expect(upload).resolves.toMatchObject({ key: "uploads/7/scan.pdf" })
  })
  it("已取消不获取预签名、不发 PUT", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(uploadFileToObjectStorage(file, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
    expect(mocks.post).not.toHaveBeenCalled()
    expect(MockXhr.instances).toHaveLength(0)
  })
  it("预签名透传 signal / 30 秒超时，取消期间不发 PUT", async () => {
    const controller = new AbortController()
    mocks.post.mockImplementationOnce((_url: string, _body: unknown, config: AxiosRequestConfig) => new Promise<never>((_resolve, reject) => {
      config.signal?.addEventListener?.("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true })
    }))
    const upload = uploadFileToObjectStorage(file, { signal: controller.signal })
    const outcome = expect(upload).rejects.toMatchObject({ name: "AbortError" })
    expect(mocks.post).toHaveBeenCalledWith("/upload/presign-put", { filename: file.name }, { signal: controller.signal, timeout: 30_000 })
    controller.abort()
    await outcome
    expect(MockXhr.instances).toHaveLength(0)
  })
  it("预签名响应与取消同时发生时不再创建 PUT", async () => {
    const controller = new AbortController()
    mocks.post.mockImplementationOnce(async () => {
      controller.abort()
      return { data: { presignedUrl: "/api/upload/object/uploads/7/scan.pdf", objectKey: "source-key" } }
    })
    await expect(uploadFileToObjectStorage(file, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
    expect(MockXhr.instances).toHaveLength(0)
  })
  it("预签名超时拒绝，流程不会继续或永久等待", async () => {
    vi.useFakeTimers()
    mocks.post.mockImplementationOnce((_url: string, _body: unknown, config: AxiosRequestConfig) => new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("预签名超时")), config.timeout)
    }))
    const outcome = expect(uploadFileToObjectStorage(file)).rejects.toThrow("预签名超时")
    await vi.advanceTimersByTimeAsync(30_000)
    await outcome
    expect(MockXhr.instances).toHaveLength(0)
  })
  it("PUT 默认 5 分钟，signal 中止 XHR 并移除所有监听器", async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, "removeEventListener")
    const upload = uploadFileToObjectStorage(file, { signal: controller.signal })
    const outcome = expect(upload).rejects.toMatchObject({ name: "AbortError" })
    await Promise.resolve()
    const request = xhr()
    expect(request.timeout).toBe(300_000)
    expect(request.send).toHaveBeenCalledWith(expect.any(Blob))
    controller.abort()
    await outcome
    expect(request.abort).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
    expectCleaned(request)
  })
  it.each([
    ["ontimeout", "上传超时"], ["onerror", "网络错误"], ["onabort", "上传已中止"],
  ] as const)("%s 拒绝并清理，超时支持自定义", async (event, message) => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, "removeEventListener")
    const onProgress = vi.fn()
    const upload = uploadFileToObjectStorage(file, { signal: controller.signal, timeoutMs: 1_234, onProgress })
    const outcome = expect(upload).rejects.toThrow(message)
    await Promise.resolve()
    const request = xhr()
    expect(request.timeout).toBe(1_234)
    expect(mocks.post).toHaveBeenCalledWith("/upload/presign-put", { filename: file.name }, { signal: controller.signal, timeout: 1_234 })
    request[event]?.(new ProgressEvent(event.slice(2)))
    await outcome
    expectCleaned(request)
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
    controller.abort()
    expect(request.abort).not.toHaveBeenCalled()
    expect(onProgress).not.toHaveBeenCalledWith(100)
  })
  it.each([200, 403])("HTTP %s 清理全部监听器，只有 2xx 才进度 100", async (status) => {
    const controller = new AbortController()
    const onProgress = vi.fn()
    const upload = uploadFileToObjectStorage(file, { signal: controller.signal, onProgress })
    const outcome = status === 200 ? expect(upload).resolves.toMatchObject({ key: "source-key", url: "s4key:source-key" }) : expect(upload).rejects.toThrow("HTTP 403")
    await Promise.resolve()
    const request = xhr()
    request.upload.onprogress?.(new ProgressEvent("progress", { loaded: 3, total: 3, lengthComputable: true }))
    expect(onProgress).toHaveBeenLastCalledWith(99)
    request.status = status
    request.onload?.(new ProgressEvent("load"))
    await outcome
    expectCleaned(request)
    controller.abort()
    expect(request.abort).not.toHaveBeenCalled()
    if (status === 200) expect(onProgress).toHaveBeenLastCalledWith(100)
    else expect(onProgress).not.toHaveBeenCalledWith(100)
  })
  it.each([0, Number.NaN, Number.POSITIVE_INFINITY])("无效 timeoutMs=%s 不会禁用超时", async (timeoutMs) => {
    const upload = uploadFileToObjectStorage(file, { timeoutMs })
    await Promise.resolve()
    expect(xhr().timeout).toBe(300_000)
    xhr().onload?.(new ProgressEvent("load"))
    await upload
  })
  it("send 同步异常也释放取消监听器", async () => {
    class ThrowingXhr extends MockXhr {
      override send = vi.fn(() => { throw new Error("send 失败") })
    }
    vi.stubGlobal("XMLHttpRequest", ThrowingXhr)
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, "removeEventListener")
    await expect(uploadFileToObjectStorage(file, { signal: controller.signal })).rejects.toThrow("send 失败")
    expectCleaned(xhr())
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
  })
  it("预签名 API 的旧单参数调用保持兼容", async () => {
    await expect(uploadApi.presignPut({ filename: file.name })).resolves.toHaveProperty("data.objectKey", "source-key")
    expect(mocks.post).toHaveBeenCalledWith("/upload/presign-put", { filename: file.name }, undefined)
  })
})
