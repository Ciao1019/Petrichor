// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { createElement, StrictMode } from "react"
import type { DocumentImportCreateRequest, DocumentImportCreateResponse } from "@/lib/api"
import type { UploadFileToObjectStorageOptions } from "@/lib/object-storage-upload"
import { authApi } from "@/lib/api-core"
import { resetAuthSession } from "@/lib/auth-session-events"
import { executeDocumentImport, resolveItemProgress, resolveSubmissionStatus, useDocumentImport, type ImportItem, type ImportOptions } from "./use-document-import"

const mocks = vi.hoisted(() => ({ post: vi.fn(), upload: vi.fn(), worker: vi.fn() }))
vi.mock("@/lib/api-client", () => ({ api: { post: mocks.post } }))
vi.mock("@/lib/api", async () => ({ documentImportApi: (await import("@/lib/api-public")).documentImportApi }))
vi.mock("@/lib/object-storage-upload", () => ({ uploadFileToObjectStorage: mocks.upload }))

const response: DocumentImportCreateResponse = {
  job: {
    id: "job-1", knowledgeBaseId: "kb-1", knowledgeBaseName: null, parentNodeId: null, parentFolderName: null,
    sourceType: "pdf", fileName: "test.pdf", title: "测试", totalPages: 0, processedPages: 0,
    donePages: 0, failedPages: 0, pendingPages: 0, status: "pending", stage: "preparing", modelConfigId: null,
    articleId: null, error: null, deadLetteredAt: null, replayCount: 0, createdAt: "", updatedAt: "",
    pageUnit: "page", actualMethods: [], directPages: 0,
    multimodalPages: 0,
  },
  articleId: null,
}
const options: ImportOptions = { knowledgeBaseId: "kb-1", parentId: null, modelConfigId: null, concurrency: 2, imagePolicy: "images_only" }
function item(patch: Partial<ImportItem> = {}): ImportItem {
  return { id: "file-1", file: new File(["文档"], "test.pdf", { type: "application/pdf" }), title: "测试", status: "pending", ...patch }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function mount(importOptions = options) {
  return renderHook(({ config }) => useDocumentImport(config), {
    initialProps: { config: importOptions },
    wrapper: ({ children }) => createElement(StrictMode, null, children),
  })
}
function unloadIsBlocked() {
  const event = new Event("beforeunload", { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}
function requests(): DocumentImportCreateRequest[] {
  return mocks.post.mock.calls.filter(([url]) => url === "/kb/import/create").map(([, body]) => body)
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal("Worker", mocks.worker)
  mocks.upload.mockImplementation(async (file: File, opts?: UploadFileToObjectStorageOptions) => {
    opts?.onProgress?.(37)
    return { key: file.name, url: "", name: file.name, type: file.type, size: file.size }
  })
  mocks.post.mockResolvedValue({ data: response })
})
afterEach(() => {
  cleanup()
  resetAuthSession()
  expect(mocks.worker).not.toHaveBeenCalled()
  expect(mocks.post.mock.calls.some(([url]) => /attach-ocr|page-convert|cancel/.test(url))).toBe(false)
  vi.unstubAllGlobals()
})

describe("只上传原件并提交 Go / Asynq 的契约", () => {
  it.each(["keep_and_recognize", "text_only", "images_only", undefined] as const)("图片策略 %s 进入创建请求，缺省保持原行为", async (imagePolicy) => {
    await executeDocumentImport(item(), { ...options, imagePolicy }, vi.fn(), new AbortController().signal)
    expect(requests()[0]?.imagePolicy).toBe(imagePolicy ?? "keep_and_recognize")
  })
  it("真实 API client 不再提交 OCR 顺序；无 pages、无 Worker、模型可选", async () => {
    const update = vi.fn()
    const signal = new AbortController().signal
    expect(await executeDocumentImport(item(), { ...options, modelConfigId: undefined }, update, signal)).toBe("submitted")
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.post).toHaveBeenCalledWith("/kb/import/create", {
      idempotencyKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
      knowledgeBaseId: "kb-1", parentId: null, fileName: "test.pdf", title: "测试",
      sourceKey: "test.pdf", modelConfigId: undefined, concurrency: 2, imagePolicy: "images_only",
    }, { signal, timeout: 30_000 })
    expect(requests()[0]).not.toHaveProperty("pages")
    expect(requests()[0]).not.toHaveProperty("ocrPriority")
    expect(mocks.upload).toHaveBeenCalledWith(expect.any(File), expect.objectContaining({ signal, timeoutMs: 300_000 }))
    expect(update).toHaveBeenCalledWith("file-1", { uploadPercent: 37 })
    expect(update).toHaveBeenLastCalledWith("file-1", expect.objectContaining({ jobId: "job-1", status: "submitted" }))
  })
  it.each(["test.docx", "test.xlsx", "test.md", "scan.PDF "])("%s 保留原文件，不读取正文、不转换 PDF 或图片", async (fileName) => {
    const original = item({ file: new File(["原文"], fileName) })
    const read = vi.fn(() => { throw new Error("浏览器不得解析") })
    Object.assign(original.file, { text: read, arrayBuffer: read })
    await executeDocumentImport(original, options, vi.fn(), new AbortController().signal)
    expect(mocks.upload).toHaveBeenCalledTimes(1)
    expect(mocks.upload.mock.calls[0]?.[0]).toBe(original.file)
    expect(read).not.toHaveBeenCalled()
    expect(requests()[0]?.fileName).toBe(fileName)
  })
  it("首次请求前冻结完整请求，网络超时 / 失败后同 key 同参数且不重新上传", async () => {
    let current = item({ title: "  原始标题  " })
    const update = (_id: string, patch: Partial<ImportItem>) => { current = { ...current, ...patch } }
    mocks.post.mockImplementationOnce(async (_url, body) => {
      expect(current.request).toBe(body)
      expect(Object.isFrozen(body)).toBe(true)
      throw new Error("创建超时")
    }).mockRejectedValueOnce(new Error("网络断开"))
    await expect(executeDocumentImport(current, options, update, new AbortController().signal)).rejects.toThrow("创建超时")
    const frozen = current.request
    current = { ...current, title: "改名不能更改已冻结请求", sourceKey: "其他源" }
    const changed = { ...options, knowledgeBaseId: "other", parentId: "folder-2", modelConfigId: "model-2", concurrency: 8, imagePolicy: "text_only" as const }
    await expect(executeDocumentImport(current, changed, update, new AbortController().signal)).rejects.toThrow("网络断开")
    expect(await executeDocumentImport(current, changed, update, new AbortController().signal)).toBe("submitted")
    expect(requests()).toHaveLength(3)
    for (const body of requests()) expect(body).toBe(frozen)
    expect(frozen).toMatchObject({ title: "原始标题", sourceKey: "test.pdf", ...options })
    expect(mocks.upload).toHaveBeenCalledTimes(1)
  })
  it("不同文件独立 UUID，已有 sourceKey 不重传", async () => {
    for (const id of ["one", "two"]) await executeDocumentImport(item({ id, sourceKey: "stable-source" }), options, vi.fn(), new AbortController().signal)
    expect(requests()[0]?.idempotencyKey).not.toBe(requests()[1]?.idempotencyKey)
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it("已确认任务不再调用 create、detail 或 cancel；通知异常不改变成功提交", async () => {
    expect(await executeDocumentImport(item({ jobId: "job-1", status: "failed" }), options, vi.fn(), new AbortController().signal)).toBe("submitted")
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(await executeDocumentImport(item(), { ...options, onJobCreated: () => { throw new Error("通知失败") } }, vi.fn(), new AbortController().signal)).toBe("submitted")
  })
  it("开始前已中止不请求；上传成功但中止时保留 sourceKey 且不 create", async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(executeDocumentImport(item(), options, vi.fn(), abort.signal)).rejects.toThrow()
    expect(mocks.upload).not.toHaveBeenCalled()
    const duringUpload = new AbortController()
    const update = vi.fn()
    mocks.upload.mockImplementationOnce(async () => { duringUpload.abort(); return { key: "uploaded" } })
    await expect(executeDocumentImport(item(), options, update, duringUpload.signal)).rejects.toThrow()
    expect(update).toHaveBeenCalledWith("file-1", { sourceKey: "uploaded" })
    expect(mocks.post).not.toHaveBeenCalled()
  })
  it("零页提交不等于完成；未知进度不伪造百分比", () => {
    expect(resolveSubmissionStatus(response)).toBe("submitted")
    expect(resolveSubmissionStatus({ ...response, articleId: "article-1" })).toBe("done")
    expect(resolveSubmissionStatus({ ...response, job: { ...response.job, status: "completed" } })).toBe("done")
    for (const status of ["uploading", "creating", "submitted"] as const) expect(resolveItemProgress(item({ status })).value).toBeNull()
    expect(resolveItemProgress(item({ status: "uploading", uploadPercent: 37 })).value).toBe(37)
    for (const status of ["failed", "submitted", "done"] as const) expect(resolveItemProgress(item({ status })).active).toBe(false)
  })
})

describe("上传 / 提交生命周期与缓存", () => {
  it("只有上传 / 提交中阻止关闭；失败、待选文件和已提交不阻止", async () => {
    const pending = deferred<{ data: DocumentImportCreateResponse }>()
    const hook = mount()
    act(() => hook.result.current.setItems([item()]))
    expect(unloadIsBlocked()).toBe(false)
    mocks.post.mockReturnValueOnce(pending.promise)
    let running!: ReturnType<typeof hook.result.current.runImport>
    act(() => { running = hook.result.current.runImport(hook.result.current.items) })
    expect(unloadIsBlocked()).toBe(true)
    await waitFor(() => expect(mocks.post).toHaveBeenCalled())
    expect(hook.result.current.running).toBe(true)
    expect(await hook.result.current.runImport(hook.result.current.items)).toBeNull()
    await act(async () => { pending.reject(new Error("超时")); await running })
    expect(hook.result.current.running).toBe(false)
    expect(unloadIsBlocked()).toBe(false)
    const frozen = hook.result.current.items[0]?.request
    act(() => hook.result.current.updateItem("file-1", { title: "新标题" }))
    expect(hook.result.current.items[0]?.title).toBe("测试")
    hook.rerender({ config: { ...options, concurrency: 8, parentId: "other" } })
    await act(async () => { expect(await hook.result.current.runImport(hook.result.current.items)).toEqual({ completed: 0, submitted: 1, failed: 0 }) })
    expect(requests()[1]).toBe(frozen)
    expect(mocks.upload).toHaveBeenCalledTimes(1)
    expect(unloadIsBlocked()).toBe(false)
    hook.unmount()
    expect(mount().result.current.items).toEqual([])
  })
  it.each(["upload", "create"] as const)("%s 中卸载会 abort，重挂载重试，不取消后端", async (phase) => {
    const original = item()
    const hook = mount()
    act(() => hook.result.current.setItems([original]))
    const waitForAbort = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }))
    if (phase === "upload") mocks.upload.mockImplementationOnce((_file: File, config: UploadFileToObjectStorageOptions) => waitForAbort(config.signal))
    else mocks.post.mockImplementationOnce((_url, _body, config: { signal: AbortSignal }) => waitForAbort(config.signal))
    let running!: ReturnType<typeof hook.result.current.runImport>
    act(() => { running = hook.result.current.runImport(hook.result.current.items) })
    await waitFor(() => expect(hook.result.current.items[0]?.status).toBe(phase === "upload" ? "uploading" : "creating"))
    const frozen = hook.result.current.items[0]?.request
    hook.unmount()
    await act(async () => { expect(await running).toBeNull() })
    expect(unloadIsBlocked()).toBe(false)
    const resumed = mount({ ...options, parentId: "new-folder" })
    expect(resumed.result.current.items[0]).toMatchObject({ file: original.file, status: "failed" })
    await act(async () => { await resumed.result.current.runImport(resumed.result.current.items) })
    expect(mocks.upload).toHaveBeenCalledTimes(phase === "create" ? 1 : 2)
    if (phase === "create") expect(requests()[1]).toBe(frozen)
    expect(resumed.result.current.items[0]?.status).toBe("submitted")
  })
  it.each([true, false])("卸载后的迟到 create 成功，重挂载=%s：保留确认或释放 File，不重建", async (remount) => {
    const created = deferred<{ data: DocumentImportCreateResponse }>()
    mocks.post.mockReturnValueOnce(created.promise)
    const hook = mount()
    act(() => hook.result.current.setItems([item()]))
    let running!: ReturnType<typeof hook.result.current.runImport>
    act(() => { running = hook.result.current.runImport(hook.result.current.items) })
    await waitFor(() => expect(mocks.post).toHaveBeenCalled())
    hook.unmount()
    const resumed = remount ? mount() : null
    if (resumed) {
      expect(resumed.result.current.running).toBe(true)
      expect(await resumed.result.current.runImport(resumed.result.current.items)).toBeNull()
    }
    await act(async () => { created.resolve({ data: response }); expect(await running).toBeNull() })
    if (resumed) {
      expect(resumed.result.current.items[0]).toMatchObject({ jobId: "job-1", status: "submitted" })
      expect(resumed.result.current.running).toBe(false)
      resumed.unmount()
    }
    expect(mount().result.current.items).toEqual([])
    expect(unloadIsBlocked()).toBe(false)
    expect(requests()).toHaveLength(1)
  })
  it("迟到的上传成功仍保留 key，重试不重传", async () => {
    const uploaded = deferred<{ key: string }>()
    mocks.upload.mockReturnValueOnce(uploaded.promise)
    const hook = mount()
    act(() => hook.result.current.setItems([item()]))
    let running!: ReturnType<typeof hook.result.current.runImport>
    act(() => { running = hook.result.current.runImport(hook.result.current.items) })
    hook.unmount()
    await act(async () => { uploaded.resolve({ key: "late-source" }); await running })
    const resumed = mount()
    expect(resumed.result.current.items[0]?.sourceKey).toBe("late-source")
    await act(async () => { await resumed.result.current.runImport(resumed.result.current.items) })
    expect(mocks.upload).toHaveBeenCalledTimes(1)
    expect(requests()[0]?.sourceKey).toBe("late-source")
  })
  it.each(["presign", "put", "create"])("%s 超时后 busy 最终释放", async (phase) => {
    const hook = mount()
    act(() => hook.result.current.setItems([item()]))
    if (phase === "create") mocks.post.mockRejectedValueOnce(new Error("create 超时"))
    else mocks.upload.mockRejectedValueOnce(new Error(`${phase} 超时`))
    await act(async () => { expect(await hook.result.current.runImport(hook.result.current.items)).toEqual({ completed: 0, submitted: 0, failed: 1 }) })
    expect(hook.result.current.running).toBe(false)
    expect(hook.result.current.items[0]?.status).toBe("failed")
    expect(unloadIsBlocked()).toBe(false)
  })
  it("跨知识库最多 50 个 / 500MB，移除或已确认后卸载释放缓存", () => {
    const hook = mount()
    act(() => hook.result.current.setItems(Array.from({ length: 50 }, (_, index) => item({ id: String(index) }))))
    hook.rerender({ config: { ...options, knowledgeBaseId: "kb-other" } })
    expect(hook.result.current.items).toEqual([])
    act(() => hook.result.current.setItems([item()]))
    expect(hook.result.current.items).toEqual([])
    expect(hook.result.current.capacityError).toContain("50 个 / 500MB")
    hook.rerender({ config: options })
    expect(hook.result.current.items).toHaveLength(50)
    act(() => hook.result.current.setItems([]))
    const large = item()
    Object.defineProperty(large.file, "size", { value: 501 * 1024 * 1024 })
    act(() => hook.result.current.setItems([large]))
    expect(hook.result.current.items).toEqual([])
    expect(hook.result.current.capacityError).toContain("500MB")
    hook.unmount()
    expect(mount().result.current.items).toEqual([])
  })
})

describe("认证代次隔离", () => {
  it.each(["login", "logout", "logout-failed"])("%s 清空挂载与卸载缓存，旧回调不能恢复私有状态", async (event) => {
    const cached = mount()
    act(() => cached.result.current.setItems([item({ sourceKey: "private-source" })]))
    cached.unmount()
    const active = mount({ ...options, knowledgeBaseId: "kb-other" })
    act(() => active.result.current.setItems([item()]))
    const stale = active.result.current
    const completed = mount({ ...options, knowledgeBaseId: "kb-completed" })
    act(() => completed.result.current.setItems([item({ status: "done", articleId: "private-article" })]))
    await act(async () => {
      if (event === "login") await authApi.login({ email: "user@example.test", password: "test-password" })
      else if (event === "logout") await authApi.logout()
      else {
        mocks.post.mockRejectedValueOnce(new Error("退出失败"))
        await expect(authApi.logout()).rejects.toThrow("退出失败")
      }
    })
    for (const hook of [active, completed]) {
      expect(hook.result.current.items).toEqual([])
      expect(hook.result.current.running).toBe(false)
    }
    act(() => { stale.setItems([item()]); stale.updateItem("file-1", { jobId: "late-job" }) })
    expect(await stale.runImport(stale.items)).toBeNull()
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(mount().result.current.items).toEqual([])
    expect(unloadIsBlocked()).toBe(false)
  })
  it("登录失败保留原件，普通 SPA 重挂仍可恢复", async () => {
    const hook = mount()
    const original = item({ sourceKey: "retained-source" })
    act(() => hook.result.current.setItems([original]))
    hook.unmount()
    mocks.post.mockRejectedValueOnce(new Error("登录失败"))
    await expect(authApi.login({ email: "user@example.test", password: "test-password" })).rejects.toThrow("登录失败")
    expect(mount().result.current.items).toEqual([original])
  })
  it.each(["upload", "create"] as const)("%s 期间 reset：迟到响应和 finally 不复活旧文件，也不覆盖新会话", async (phase) => {
    const uploaded = deferred<{ key: string }>()
    const created = deferred<{ data: DocumentImportCreateResponse }>()
    if (phase === "upload") mocks.upload.mockReturnValueOnce(uploaded.promise)
    else mocks.post.mockReturnValueOnce(created.promise)
    const onJobCreated = vi.fn()
    const hook = mount({ ...options, onJobCreated })
    act(() => hook.result.current.setItems([item()]))
    let running!: ReturnType<typeof hook.result.current.runImport>
    act(() => { running = hook.result.current.runImport(hook.result.current.items) })
    await waitFor(() => expect(hook.result.current.items[0]?.status).toBe(phase === "upload" ? "uploading" : "creating"))
    const oldSignal = (mocks.upload.mock.calls[0]?.[1] as UploadFileToObjectStorageOptions).signal
    act(() => resetAuthSession())
    expect(oldSignal?.aborted).toBe(true)
    expect(hook.result.current.items).toEqual([])
    expect(unloadIsBlocked()).toBe(false)
    const newFile = item({ file: new File(["新会话"], "new.pdf") })
    const newUpload = deferred<{ key: string }>()
    mocks.upload.mockReturnValueOnce(newUpload.promise)
    act(() => hook.result.current.setItems([newFile]))
    let newRunning!: ReturnType<typeof hook.result.current.runImport>
    act(() => { newRunning = hook.result.current.runImport(hook.result.current.items) })
    await act(async () => {
      if (phase === "upload") uploaded.resolve({ key: "late-private-key" })
      else created.resolve({ data: { ...response, articleId: "late-private-article" } })
      expect(await running).toBeNull()
    })
    expect(onJobCreated).not.toHaveBeenCalled()
    expect(hook.result.current.running).toBe(true)
    expect(hook.result.current.items[0]).toMatchObject({ file: newFile.file, status: "uploading" })
    expect(hook.result.current.items[0]?.sourceKey).toBeUndefined()
    expect(hook.result.current.items[0]?.request).toBeUndefined()
    await act(async () => { newUpload.resolve({ key: "new-source" }); await newRunning })
    expect(hook.result.current.items[0]).toMatchObject({ sourceKey: "new-source", status: "submitted" })
    hook.unmount()
    expect(mount().result.current.items).toEqual([])
    expect(unloadIsBlocked()).toBe(false)
  })
  it("reset 中止多个知识库；异步失败不重新注册关闭拦截", async () => {
    const pending = deferred<{ key: string }>()
    mocks.upload.mockReturnValue(pending.promise)
    const hooks = [mount(), mount({ ...options, knowledgeBaseId: "kb-other" })]
    const running = hooks.map((hook) => {
      act(() => hook.result.current.setItems([item()]))
      let promise!: ReturnType<typeof hook.result.current.runImport>
      act(() => { promise = hook.result.current.runImport(hook.result.current.items) })
      return promise
    })
    const signals = mocks.upload.mock.calls.map(([, config]) => (config as UploadFileToObjectStorageOptions).signal)
    act(() => resetAuthSession())
    expect(signals.every((signal) => signal?.aborted)).toBe(true)
    await act(async () => { pending.reject(new Error("迟到失败")); expect(await Promise.all(running)).toEqual([null, null]) })
    for (const hook of hooks) expect(hook.result.current.items).toEqual([])
    expect(unloadIsBlocked()).toBe(false)
    expect(mocks.post).not.toHaveBeenCalled()
  })
})
