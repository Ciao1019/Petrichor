// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { captureApi, type CaptureJob } from "@/lib/api-capture"
import { defaultCaptureOptions } from "./capture-utils"
import { InboxCaptureComposer } from "./InboxCaptureComposer"

vi.mock("@/lib/api-capture", () => ({ captureApi: { config: vi.fn(), list: vi.fn(), result: vi.fn() } }))
vi.mock("../InboxComposer", () => ({ InboxComposer: () => <div>手写草稿</div> }))
vi.mock("./CaptureInput", () => ({ CaptureInput: () => null }))
vi.mock("./CapturePreview", () => ({ CapturePreview: ({ job }: { job: CaptureJob }) => <output data-testid="capture-preview">{job.id}</output> }))

const jobs: CaptureJob[] = ["来源甲", "来源乙"].map((title, index) => ({
  id: String(index + 1), title, url: `https://example.com/${index + 1}`, options: defaultCaptureOptions,
  state: "ready", error: "", previousId: null, saved: true, createdAt: "2026-09-17T00:00:00Z", updatedAt: "2026-09-17T00:00:00Z",
  result: { markdown: title, note: { title, summary: "", takeaways: [], quotes: [], tags: [] }, assets: [], links: [], warnings: [], url: `https://example.com/${index + 1}`, finalUrl: `https://example.com/${index + 1}`, language: "zh", fetchedAt: "2026-09-17T00:00:00Z", statusCode: 200, inputTokens: 0, outputTokens: 0, hash: String(index) },
}))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  vi.mocked(captureApi.config).mockResolvedValue({ data: { enabled: true, screenshot: true, actions: true, aiFormats: true, modelReady: true, maxBatch: 10, dailyLimit: 50, used: 2 } } as Awaited<ReturnType<typeof captureApi.config>>)
  vi.mocked(captureApi.list).mockResolvedValue({ data: { rows: jobs, total: jobs.length } } as Awaited<ReturnType<typeof captureApi.list>>)
  vi.mocked(captureApi.result).mockImplementation(async (id) => ({ data: jobs.find((job) => job.id === id)! }) as Awaited<ReturnType<typeof captureApi.result>>)
})
afterEach(cleanup)

it("切换采集记录后，再次点击同一随笔来源仍打开正确原文", async () => {
  const onSaved = vi.fn()
  const page = render(<InboxCaptureComposer userId="alice" onSaved={onSaved} sourceRequest={{ id: "1", requestedAt: 1 }} />)
  await waitFor(() => expect(screen.getByTestId("capture-preview").textContent).toBe("1"))

  fireEvent.click(screen.getByRole("button", { name: /采集记录/ }))
  fireEvent.click(screen.getByRole("button", { name: /来源乙/ }))
  await waitFor(() => expect(screen.getByTestId("capture-preview").textContent).toBe("2"))
  fireEvent.click(screen.getByRole("tab", { name: "随手写" }))

  page.rerender(<InboxCaptureComposer userId="alice" onSaved={onSaved} sourceRequest={{ id: "1", requestedAt: 2 }} />)
  await waitFor(() => expect(screen.getByTestId("capture-preview").textContent).toBe("1"))
  expect(screen.getByRole("tab", { name: "网页采集" }).getAttribute("aria-selected")).toBe("true")

  // 同一记录已经选中时再次打开，仍须刷新结果，不能清空后一直等待下一轮轮询。
  vi.mocked(captureApi.result).mockClear()
  page.rerender(<InboxCaptureComposer userId="alice" onSaved={onSaved} sourceRequest={{ id: "1", requestedAt: 3 }} />)
  await waitFor(() => expect(captureApi.result).toHaveBeenCalledWith("1", expect.any(AbortSignal)))
  await waitFor(() => expect(screen.getByTestId("capture-preview").textContent).toBe("1"))
})
