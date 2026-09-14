// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import type { DocumentImportFinalizeResponse, DocumentImportJobResponse, DocumentImportPageResponse } from "@/lib/api"
import { knowledgeBaseArticlePath } from "@/lib/dashboard-routes"
import { DocumentImportJobDetailPage } from "./DocumentImportJobDetailPage"

const mocks = vi.hoisted(() => ({ detail: vi.fn(), retryFailedPages: vi.fn(), retryPage: vi.fn(), cancel: vi.fn(), finalize: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock("@/lib/api", () => ({ documentImportApi: mocks }))
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const job: DocumentImportJobResponse = {
  id: "job-1", knowledgeBaseId: "kb-1", knowledgeBaseName: null, parentNodeId: null, parentFolderName: null,
  sourceType: "pdf", fileName: "scan.pdf", title: "服务端任务", totalPages: 0, processedPages: 0,
  donePages: 0, failedPages: 0, pendingPages: 0, status: "failed", stage: "parsing", modelConfigId: null,
  articleId: null, error: "解析失败", deadLetteredAt: null, replayCount: 0, createdAt: "", updatedAt: "",
  pageUnit: "page", actualMethods: [], directPages: 0,
  multimodalPages: 0,
}
const readyJob: DocumentImportJobResponse = { ...job, totalPages: 1, donePages: 1, processedPages: 1, stage: "finalizing", error: "生成失败" }
function CurrentPath() {
  return <output data-testid="current-path">{useLocation().pathname}</output>
}
function mount() {
  return render(<MemoryRouter initialEntries={["/imports/job-1"]}><CurrentPath /><Link to="/imports/job-2">切换任务</Link><Routes><Route path="/imports/:jobId" element={<DocumentImportJobDetailPage />} /><Route path="*" element={<div>文章页面</div>} /></Routes></MemoryRouter>)
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.detail.mockResolvedValue({ data: { job, pages: [] } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe("服务端任务详情", () => {
  it.each([false, true])("finalize 排队后留在详情并轮询，旧 failed 不能覆盖返回 job（后续刷新失败：%s）", async (refreshFails) => {
    const failed = { data: { job: readyJob, pages: [] } }
    const pending = { data: { job: { ...readyJob, status: "pending" as const, error: null }, pages: [] } }
    const old = deferred<typeof failed>()
    const refresh = deferred<typeof pending>()
    const finalize = deferred<{ data: DocumentImportFinalizeResponse }>()
    const intervals = vi.spyOn(window, "setInterval")
    const clear = vi.spyOn(window, "clearInterval")
    mocks.detail.mockResolvedValueOnce(failed).mockReturnValueOnce(old.promise).mockReturnValueOnce(refresh.promise)
    mocks.finalize.mockReturnValueOnce(finalize.promise)
    mount()
    const button = await screen.findByRole("button", { name: "重试生成文章" })
    fireEvent.click(screen.getByRole("button", { name: "刷新" }))
    fireEvent.click(button)
    fireEvent.click(button)
    expect(mocks.finalize).toHaveBeenCalledTimes(1)
    expect(mocks.finalize).toHaveBeenCalledWith({ jobId: "job-1" })
    expect(button.hasAttribute("disabled")).toBe(true)
    await act(async () => finalize.resolve({ data: { job: pending.data.job, articleId: null } }))
    expect(mocks.success).toHaveBeenCalledWith("已提交生成文章任务，可关闭页面")
    expect(mocks.success).not.toHaveBeenCalledWith("文章已生成")
    expect(screen.getByTestId("current-path").textContent).toBe("/imports/job-1")
    expect(screen.getByText("生成文章中")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "打开文章" })).toBeNull()
    expect(screen.getByRole("button", { name: "提交生成文章" }).hasAttribute("disabled")).toBe(true)
    await act(async () => {
      if (refreshFails) refresh.reject(new Error("详情暂不可用"))
      else refresh.resolve(pending)
    })
    await act(async () => old.resolve(failed))
    expect(screen.queryByText("生成失败")).toBeNull()
    expect(screen.getByText("生成文章中")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "提交生成文章" }))
    expect(mocks.finalize).toHaveBeenCalledTimes(1)
    const pollIndex = intervals.mock.calls.map(([, delay]) => delay).lastIndexOf(4000)
    const poll = intervals.mock.calls[pollIndex]?.[0]
    expect(typeof poll).toBe("function")
    mocks.detail.mockResolvedValueOnce({ data: { job: { ...pending.data.job, status: "completed", stage: "completed", articleId: "article-1" }, pages: [] } })
    await act(async () => { if (typeof poll === "function") poll() })
    const open = await screen.findByRole("button", { name: "打开文章" })
    expect(mocks.detail).toHaveBeenCalledTimes(4)
    expect(clear).toHaveBeenCalledWith(intervals.mock.results[pollIndex]?.value)
    expect(screen.getByTestId("current-path").textContent).toBe("/imports/job-1")
    fireEvent.click(open)
    expect(screen.getByTestId("current-path").textContent).toBe(knowledgeBaseArticlePath("kb-1", "article-1"))
    if (refreshFails) expect(mocks.error).toHaveBeenCalledWith("详情暂不可用")
    else expect(mocks.error).not.toHaveBeenCalled()
  })

  it("finalize 返回已有 articleId 才提示完成并导航文章", async () => {
    mocks.detail.mockResolvedValue({ data: { job: readyJob, pages: [] } })
    const completed: DocumentImportFinalizeResponse = { job: { ...readyJob, status: "completed", stage: "completed", articleId: "existing-article", error: null }, articleId: "existing-article" }
    mocks.finalize.mockResolvedValueOnce({ data: completed })
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "重试生成文章" }))
    await screen.findByText("文章页面")
    expect(screen.getByTestId("current-path").textContent).toBe(knowledgeBaseArticlePath("kb-1", "existing-article"))
    expect(mocks.success).toHaveBeenCalledWith("文章已生成")
    expect(mocks.success).not.toHaveBeenCalledWith("已提交生成文章任务，可关闭页面")
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it("finalize 锁忙 409 不误报已提交或导航，刷新后仍可重试", async () => {
    mocks.detail.mockResolvedValue({ data: { job: readyJob, pages: [] } })
    mocks.finalize.mockRejectedValueOnce({ response: { status: 409, data: { msg: "任务正在处理中，请稍后重试" } } })
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "重试生成文章" }))
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("任务正在处理中，请稍后重试"))
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.detail).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId("current-path").textContent).toBe("/imports/job-1")
    expect(screen.getByRole("button", { name: "重试生成文章" }).hasAttribute("disabled")).toBe(false)
  })

  it.each(["pending", "processing"] as const)("%s / finalizing 即使全页成功也禁止重复提交", async (status) => {
    mocks.detail.mockResolvedValueOnce({ data: { job: { ...readyJob, status, error: null }, pages: [] } })
    mount()
    const button = await screen.findByRole("button", { name: "提交生成文章" })
    expect(button.hasAttribute("disabled")).toBe(true)
    fireEvent.click(button)
    expect(mocks.finalize).not.toHaveBeenCalled()
  })

  it.each(["retryFailedPages", "retryPage"] as const)("%s 后逆序返回的旧 failed 刷新不能覆盖 pending 或停止轮询", async (method) => {
    const failedPage: DocumentImportPageResponse = {
      pageNo: 1, imageKey: null, extractedBy: "ocr", status: "failed", markdown: null,
      error: null, attemptCount: 1, maxAttempts: 3, nextAttemptAt: "", lastError: null, deadLetteredAt: null,
    }
    const failed = { data: { job: method === "retryPage" ? { ...job, totalPages: 1, failedPages: 1, stage: "ocr" as const } : job, pages: method === "retryPage" ? [failedPage] : [] } }
    const pending = { data: { job: { ...failed.data.job, status: "pending" as const, stage: "preparing" as const, error: null }, pages: failed.data.pages.map((page) => ({ ...page, status: "pending" as const })) } }
    const old = deferred<typeof failed>()
    const retry = deferred<{ data: { retried: number; reset: number; status: string } }>()
    const intervals = vi.spyOn(window, "setInterval")
    mocks.detail.mockResolvedValueOnce(failed).mockReturnValueOnce(old.promise).mockResolvedValue(pending)
    mocks[method].mockReturnValueOnce(retry.promise)
    mount()
    const retryButton = await screen.findByRole("button", { name: method === "retryPage" ? "重试" : "重试服务端解析" })
    fireEvent.click(screen.getByRole("button", { name: "刷新" }))
    fireEvent.click(retryButton)
    fireEvent.click(screen.getByRole("button", { name: "刷新" }))
    expect(mocks.detail).toHaveBeenCalledTimes(2)
    await act(async () => retry.resolve({ data: { retried: 1, reset: 1, status: "pending" } }))
    await screen.findByText("服务端准备中")
    await act(async () => old.resolve(failed))
    expect(screen.queryByText("解析失败")).toBeNull()
    expect(screen.queryByRole("button", { name: "重试服务端解析" })).toBeNull()
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull()
    const poll = intervals.mock.calls.find(([, delay]) => delay === 4000)?.[0]
    expect(typeof poll).toBe("function")
    await act(async () => { if (typeof poll === "function") poll() })
    expect(mocks.detail).toHaveBeenCalledTimes(4)
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it("旧轮询晚于刷新完成返回时不覆盖新快照", async () => {
    const old = deferred<{ data: { job: DocumentImportJobResponse; pages: [] } }>()
    const intervals = vi.spyOn(window, "setInterval")
    mocks.detail.mockResolvedValueOnce({ data: { job: { ...job, status: "processing" }, pages: [] } }).mockReturnValueOnce(old.promise)
    mount()
    await screen.findByText("服务端解析中")
    const poll = intervals.mock.calls.find(([, delay]) => delay === 4000)?.[0]
    act(() => { if (typeof poll === "function") poll() })
    mocks.detail.mockResolvedValueOnce({ data: { job: { ...job, status: "completed", articleId: "article-1" }, pages: [] } })
    fireEvent.click(screen.getByRole("button", { name: "刷新" }))
    await screen.findByRole("button", { name: "打开文章" })
    await act(async () => old.resolve({ data: { job, pages: [] } }))
    expect(screen.getByRole("button", { name: "打开文章" })).toBeTruthy()
    expect(intervals.mock.calls.filter(([, delay]) => delay === 4000)).toHaveLength(1)
  })

  it("路由切换时清空旧任务，拒绝旧详情回调", async () => {
    const old = deferred<{ data: { job: DocumentImportJobResponse; pages: [] } }>()
    const next = deferred<unknown>()
    mocks.detail.mockResolvedValueOnce({ data: { job, pages: [] } }).mockReturnValueOnce(old.promise)
    mount()
    await screen.findByText("服务端任务")
    fireEvent.click(screen.getByRole("button", { name: "刷新" }))
    mocks.detail.mockReturnValueOnce(next.promise)
    fireEvent.click(screen.getByRole("link", { name: "切换任务" }))
    expect(screen.queryByText("服务端任务")).toBeNull()
    await act(async () => next.resolve({ data: { job: { ...job, id: "job-2", title: "第二个任务" }, pages: [] } }))
    await screen.findByText("第二个任务")
    await act(async () => old.resolve({ data: { job, pages: [] } }))
    expect(screen.queryByText("服务端任务")).toBeNull()
  })

  it.each([
    ["retryFailedPages", "重试服务端解析"], ["cancel", "取消任务"], ["finalize", "重试生成文章"],
  ] as const)("切换 job 后忽略 %s 的迟到成功，不刷新旧 job 或跳转", async (method, label) => {
    const mutation = deferred<unknown>()
    mocks[method].mockReturnValueOnce(mutation.promise)
    mocks.detail.mockResolvedValueOnce({ data: { job: method === "finalize" ? { ...job, totalPages: 1, donePages: 1 } : job, pages: [] } })
    mount()
    fireEvent.click(await screen.findByRole("button", { name: label }))
    mocks.detail.mockResolvedValueOnce({ data: { job: { ...job, id: "job-2", title: "第二个任务" }, pages: [] } })
    fireEvent.click(screen.getByRole("link", { name: "切换任务" }))
    await screen.findByText("第二个任务")
    await act(async () => mutation.resolve({ data: { reset: 1, articleId: "old-article" } }))
    expect(screen.getByText("第二个任务")).toBeTruthy()
    expect(mocks.detail).toHaveBeenCalledTimes(2)
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it.each(["resolve", "reject"] as const)("卸载后忽略详情及重试的迟到 %s", async (settle) => {
    const old = deferred<unknown>()
    const retry = deferred<unknown>()
    mocks.detail.mockResolvedValueOnce({ data: { job, pages: [] } }).mockReturnValueOnce(old.promise)
    mocks.retryFailedPages.mockReturnValueOnce(retry.promise)
    const view = mount()
    const button = await screen.findByRole("button", { name: "重试服务端解析" })
    fireEvent.click(screen.getByRole("button", { name: "刷新" }))
    fireEvent.click(button)
    view.unmount()
    await act(async () => {
      if (settle === "resolve") { old.resolve({ data: { job, pages: [] } }); retry.resolve({ data: { reset: 1 } }) }
      else { old.reject(new Error("旧详情失败")); retry.reject(new Error("旧重试失败")) }
    })
    expect(mocks.detail).toHaveBeenCalledTimes(2)
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
  })
  it("无 page 的解析失败可直接重试，沿原 jobId 重置服务端准备", async () => {
    mount()
    const button = await screen.findByRole("button", { name: "重试服务端解析" })
    expect(screen.getByText("服务端解析失败 · 总量待确认")).toBeTruthy()
    expect(screen.getByRole("button", { name: "提交生成文章" }).hasAttribute("disabled")).toBe(true)
    mocks.retryFailedPages.mockResolvedValueOnce({ data: { retried: 0, reset: 1, status: "pending" } })
    mocks.detail.mockResolvedValueOnce({ data: { job: { ...job, status: "pending", stage: "preparing", error: null }, pages: [] } })
    fireEvent.click(button)
    await waitFor(() => expect(mocks.retryFailedPages).toHaveBeenCalledWith({ jobId: "job-1" }))
    await screen.findByText("服务端准备中 · 总量待确认")
    expect(mocks.success).toHaveBeenCalledWith("已重新提交服务端解析，无需重新上传原件")
    expect(mocks.retryPage).not.toHaveBeenCalled()
    expect(mocks.cancel).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "重试服务端解析" })).toBeNull()
  })
  it("解析中即使总量为零也轮询，completed 后停止轮询，不提示浏览器补图", async () => {
    const intervals = vi.spyOn(window, "setInterval")
    const clear = vi.spyOn(window, "clearInterval")
    mocks.detail.mockResolvedValueOnce({ data: { job: { ...job, status: "processing", error: null }, pages: [] } })
    mount()
    await screen.findByText("服务端解析中 · 总量待确认")
    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false)
    expect(screen.queryByText(/等待浏览器|浏览器补图/)).toBeNull()
    const poll = intervals.mock.calls.find(([, delay]) => delay === 4000)?.[0]
    expect(typeof poll).toBe("function")
    mocks.detail.mockResolvedValueOnce({ data: { job: { ...job, totalPages: 1, donePages: 1, status: "completed", stage: "completed", articleId: "article-1", error: null }, pages: [] } })
    await act(async () => { if (typeof poll === "function") poll() })
    await screen.findByRole("button", { name: "打开文章" })
    expect(clear).toHaveBeenCalled()
    expect(intervals.mock.calls.filter(([, delay]) => delay === 4000)).toHaveLength(1)
    expect(mocks.detail).toHaveBeenCalledTimes(2)
  })
})
