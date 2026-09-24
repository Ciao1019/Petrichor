// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { captureApi, type CaptureJob } from "@/lib/api-capture"
import { CaptureWorkspace } from "./CaptureWorkspace"
import { defaultCaptureOptions } from "./capture-utils"

vi.mock("@/lib/api-capture", () => ({ captureApi: { config: vi.fn(), list: vi.fn(), result: vi.fn(), delete: vi.fn(), lookup: vi.fn() } }))
const job: CaptureJob = {
  id: "discard-1", url: "https://example.com/article", title: "待丢弃记录", state: "failed", error: "抓取失败", saved: false,
  options: defaultCaptureOptions, previousId: null, createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z",
}
const props = { userId: "alice", active: true, sourceRequest: { id: job.id, requestedAt: 1 }, onSaved: vi.fn(), onAppend: vi.fn() }
beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  vi.mocked(captureApi.config).mockResolvedValue({ data: { enabled: true, maxBatch: 10, modelReady: true, dailyLimit: 50, used: 1 } } as Awaited<ReturnType<typeof captureApi.config>>)
  vi.mocked(captureApi.list).mockResolvedValue({ data: { rows: [job], total: 1 } } as Awaited<ReturnType<typeof captureApi.list>>)
  vi.mocked(captureApi.result).mockResolvedValue({ data: job } as Awaited<ReturnType<typeof captureApi.result>>)
  vi.mocked(captureApi.delete).mockResolvedValue({ data: { success: true } } as Awaited<ReturnType<typeof captureApi.delete>>)
})
afterEach(cleanup)

it("取消确认不删除；确认后清理当前内容和草稿，迟到列表也不能恢复记录", async () => {
  const key = `petrichor:capture-preview:alice:${job.id}`
  localStorage.setItem(key, "待保存草稿")
  render(<CaptureWorkspace {...props} />)
  fireEvent.click(await screen.findByRole("button", { name: "删除记录" }))
  fireEvent.click(screen.getByRole("button", { name: "取消" }))
  expect(captureApi.delete).not.toHaveBeenCalled()
  expect(localStorage.getItem(key)).toBe("待保存草稿")
  fireEvent.click(screen.getByRole("button", { name: "删除记录" }))
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  await waitFor(() => expect(vi.mocked(captureApi.list).mock.calls.length).toBeGreaterThan(1))
  expect(captureApi.delete).toHaveBeenCalledExactlyOnceWith(job.id)
  expect(localStorage.getItem(key)).toBeNull()
  expect(screen.queryByText("待丢弃记录")).toBeNull()
  expect(screen.queryByRole("button", { name: /采集记录/ })).toBeNull()
  expect(screen.queryByRole("button", { name: "继续采集" })).toBeNull()
})

it("删除失败保留内容和草稿，弹窗支持重试", async () => {
  vi.mocked(captureApi.delete).mockRejectedValueOnce(new Error("网络连接中断"))
  localStorage.setItem(`petrichor:capture-preview:alice:${job.id}`, "保留草稿")
  render(<CaptureWorkspace {...props} />)
  fireEvent.click(await screen.findByRole("button", { name: "删除记录" }))
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }))
  await screen.findByText("网络连接中断")
  expect(localStorage.getItem(`petrichor:capture-preview:alice:${job.id}`)).toBe("保留草稿")
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(captureApi.delete).toHaveBeenCalledTimes(2)
})

it("采集历史中的已保存来源没有删除入口", async () => {
  vi.mocked(captureApi.list).mockResolvedValue({ data: { rows: [{ ...job, state: "ready", saved: true }], total: 1 } } as Awaited<ReturnType<typeof captureApi.list>>)
  render(<CaptureWorkspace {...props} sourceRequest={undefined} />)
  fireEvent.click(await screen.findByRole("button", { name: /采集记录/ }))
  expect(screen.getByText("已保存")).toBeTruthy()
  expect(screen.queryByRole("button", { name: /删除采集/ })).toBeNull()
})
