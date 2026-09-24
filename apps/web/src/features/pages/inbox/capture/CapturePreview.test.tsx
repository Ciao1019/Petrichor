// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { inboxApi } from "@/lib/api-inbox"
import type { CaptureJob } from "@/lib/api-capture"
import { CapturePreview } from "./CapturePreview"
import { defaultCaptureOptions } from "./capture-utils"

vi.mock("@/lib/api-inbox", () => ({ inboxApi: { create: vi.fn() } }))
vi.mock("../InboxMarkdown", () => ({ InboxMarkdown: ({ content }: { content: string }) => <div>{content}</div> }))
const job: CaptureJob = {
  id: "source-1", url: "https://example.com/article", options: defaultCaptureOptions, state: "ready", title: "文章", error: "", previousId: null, saved: false,
  createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z",
  result: { markdown: "# 文章\n\n完整正文不能丢失。", note: { title: "文章", summary: "", takeaways: [], quotes: [], tags: [] }, assets: [], links: [], warnings: [], url: "https://example.com/article", finalUrl: "https://example.com/article", language: "zh", fetchedAt: "2026-09-22T00:00:00Z", statusCode: 200, inputTokens: 0, outputTokens: 0, hash: "article" },
}
const props = { userId: "alice", job, onSaved: vi.fn(), onAppend: vi.fn(), onRegenerate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(), actionBusy: false, modelReady: true }
beforeEach(() => { vi.clearAllMocks(); localStorage.clear() })
afterEach(cleanup)

it("收藏原文无需配置模块，保存失败后重试仍保留来源和同一请求标识", async () => {
  vi.mocked(inboxApi.create).mockRejectedValueOnce(new Error("暂时离线"))
  render(<CapturePreview {...props} />)
  fireEvent.click(screen.getByRole("button", { name: "保存到随笔" }))
  await screen.findByRole("alert")
  const first = vi.mocked(inboxApi.create).mock.calls[0]![0]
  expect(first.contentMd).toContain("完整正文不能丢失")
  expect(first.captureIds).toEqual([job.id])
  expect(props.onSaved).not.toHaveBeenCalled()
  vi.mocked(inboxApi.create).mockResolvedValueOnce({ data: { id: "note-1" } } as Awaited<ReturnType<typeof inboxApi.create>>)
  fireEvent.click(screen.getByRole("button", { name: "保存到随笔" }))
  await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce())
  expect(vi.mocked(inboxApi.create).mock.calls[1]![0].clientId).toBe(first.clientId)
  expect(screen.getByRole("button", { name: "已保存" }).hasAttribute("disabled")).toBe(true)
})

it("查看完整原文不会把 AI 笔记替换为原文保存", async () => {
  vi.mocked(inboxApi.create).mockResolvedValueOnce({ data: { id: "note-2" } } as Awaited<ReturnType<typeof inboxApi.create>>)
  render(<CapturePreview {...props} job={{ ...job, result: { ...job.result!, note: { ...job.result!.note, summary: "文章摘要", takeaways: ["关键观点"] } } }} />)
  fireEvent.click(screen.getByRole("button", { name: "完整原文" }))
  expect(screen.getByText(/完整正文不能丢失/)).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "保存到随笔" }))
  await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce())
  const input = vi.mocked(inboxApi.create).mock.calls[0]![0]
  expect(input.contentMd).toContain("文章摘要")
  expect(input.contentMd).not.toContain("完整正文不能丢失")
  expect(input.captureIds).toEqual([job.id])
})

it("超长文章明确说明只保存来源，并仍可阅读完整原文", () => {
  render(<CapturePreview {...props} job={{ ...job, result: { ...job.result!, markdown: "长".repeat(21000) } }} />)
  expect(screen.getByRole("button", { name: "保存来源到随笔" })).toBeTruthy()
  expect(screen.getByText(/这篇文章较长/)).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "完整原文" }))
  expect(screen.getByText("长".repeat(21000))).toBeTruthy()
})


it("未保存的结果提供删除入口，保存后不再允许删除来源", async () => {
  vi.mocked(inboxApi.create).mockResolvedValueOnce({ data: { id: "note-3" } } as Awaited<ReturnType<typeof inboxApi.create>>)
  render(<CapturePreview {...props} />)
  fireEvent.click(screen.getByRole("button", { name: "删除" }))
  expect(props.onDelete).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole("button", { name: "保存到随笔" }))
  await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce())
  expect(screen.queryByRole("button", { name: "删除" })).toBeNull()
})
