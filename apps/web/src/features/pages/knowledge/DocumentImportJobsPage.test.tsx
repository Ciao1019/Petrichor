// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Link, MemoryRouter, Route, Routes } from "react-router-dom"
import type { DocumentImportJobResponse } from "@/lib/api"
import { dashboardRoutes } from "@/lib/dashboard-routes"
import { DocumentImportJobsPage } from "./DocumentImportJobsPage"
import { DocumentImportJobDetailPage } from "./DocumentImportJobDetailPage"

const mocks = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), retryFailedPages: vi.fn(), deleteMany: vi.fn() }))
vi.mock("@/lib/api", () => ({ documentImportApi: mocks }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function makeJob(index: number): DocumentImportJobResponse {
  return {
    id: `job-${index}`, knowledgeBaseId: "kb-1", knowledgeBaseName: null, parentNodeId: null, parentFolderName: null,
    sourceType: "pdf", fileName: `file-${index}.pdf`, title: `任务 ${index}`, totalPages: 0, processedPages: 0,
    donePages: 0, failedPages: 0, pendingPages: 0, status: "failed", stage: "parsing", modelConfigId: null,
    articleId: null, error: "解析失败", deadLetteredAt: null, replayCount: 0, createdAt: "", updatedAt: "",
    pageUnit: "page", actualMethods: [], directPages: 0,
    multimodalPages: 0,
  }
}
let jobs: DocumentImportJobResponse[]
function mount() {
  return render(<MemoryRouter initialEntries={["/kb/kb-1/imports"]}>
    <Link to="/kb/kb-2/imports">另一知识库</Link>
    <Routes>
      <Route path="/kb/:knowledgeBaseId/imports" element={<DocumentImportJobsPage />} />
      <Route path={`${dashboardRoutes.imports}/:jobId`} element={<DocumentImportJobDetailPage />} />
    </Routes>
  </MemoryRouter>)
}
beforeEach(() => {
  vi.resetAllMocks()
  jobs = Array.from({ length: 105 }, (_, index) => makeJob(index + 1))
  mocks.list.mockImplementation(async ({ pageNum, pageSize }) => ({ data: { rows: jobs.slice((pageNum - 1) * pageSize, pageNum * pageSize), total: jobs.length } }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe("服务端导入任务列表分页", () => {
  it("正确展示服务端 total，可访问第 100 条后的任务并进入详情重试", async () => {
    mount()
    await screen.findByText("第 1–10 条，共 105 条")
    expect(screen.getAllByTitle("查看详情")).toHaveLength(10)
    expect(mocks.list).toHaveBeenLastCalledWith({ knowledgeBaseId: "kb-1", pageNum: 1, pageSize: 10 })
    fireEvent.click(screen.getByRole("button", { name: "最后一页" }))
    await screen.findByText("任务 105")
    expect(screen.getByText("第 101–105 条，共 105 条")).toBeTruthy()
    expect(screen.getAllByTitle("查看详情")).toHaveLength(5)
    expect(mocks.list).toHaveBeenLastCalledWith({ knowledgeBaseId: "kb-1", pageNum: 11, pageSize: 10 })
    mocks.detail.mockResolvedValueOnce({ data: { job: jobs[100], pages: [] } })
    fireEvent.click(screen.getAllByTitle("查看详情")[0]!)
    const retry = await screen.findByRole("button", { name: "重试服务端解析" })
    expect(mocks.detail).toHaveBeenCalledWith({ jobId: "job-101" })
    mocks.retryFailedPages.mockResolvedValueOnce({ data: { reset: 1, retried: 0, status: "pending" } })
    mocks.detail.mockResolvedValueOnce({ data: { job: { ...jobs[100], status: "pending", stage: "preparing", error: null }, pages: [] } })
    fireEvent.click(retry)
    await screen.findByText("服务端准备中")
    expect(mocks.retryFailedPages).toHaveBeenCalledWith({ jobId: "job-101" })
  })

  it("明确当前页筛选，不改变全量 total，零匹配仍能翻页查找且清空隐藏选择", async () => {
    mount()
    await screen.findByText("任务 1")
    fireEvent.click(screen.getAllByRole("checkbox", { name: "选择该行" })[0]!)
    expect(screen.getByRole("button", { name: "删除所选（1）" })).toBeTruthy()
    fireEvent.change(screen.getByRole("textbox", { name: "筛选当前页标题或文件名" }), { target: { value: "file-105" } })
    expect(screen.getByText("当前页无匹配任务，可清除筛选或翻页查找")).toBeTruthy()
    expect(screen.getByText(/筛选与排序仅作用于当前页（匹配 0 \/ 10 条）/)).toBeTruthy()
    expect(screen.getByText("第 1–10 条，共 105 条")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "删除所选（1）" })).toBeNull()
    expect(mocks.list).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "最后一页" }))
    await screen.findByText("任务 105")
    expect(screen.getAllByTitle("查看详情")).toHaveLength(1)
    expect(screen.getByText("第 101–105 条，共 105 条")).toBeTruthy()
  })

  it("翻页清空选择，total 缩小时回到有效页，切换知识库重置分页", async () => {
    mount()
    await screen.findByText("任务 1")
    fireEvent.click(screen.getAllByRole("checkbox", { name: "选择该行" })[0]!)
    fireEvent.click(screen.getByRole("button", { name: "最后一页" }))
    await screen.findByText("任务 105")
    expect(screen.queryByRole("button", { name: "删除所选（1）" })).toBeNull()
    jobs = jobs.slice(0, 95)
    fireEvent.click(screen.getByRole("button", { name: "刷新" }))
    await screen.findByText("任务 95")
    expect(screen.getByText("第 91–95 条，共 95 条")).toBeTruthy()
    expect(mocks.list).toHaveBeenLastCalledWith({ knowledgeBaseId: "kb-1", pageNum: 10, pageSize: 10 })
    fireEvent.click(screen.getByRole("link", { name: "另一知识库" }))
    await screen.findByText("任务 1")
    expect(mocks.list).toHaveBeenLastCalledWith({ knowledgeBaseId: "kb-2", pageNum: 1, pageSize: 10 })
  })

  it("旧知识库的迟到响应不能覆盖当前页或 total", async () => {
    let resolve!: (value: unknown) => void
    mocks.list.mockReturnValueOnce(new Promise((yes) => { resolve = yes }))
    mount()
    fireEvent.click(screen.getByRole("link", { name: "另一知识库" }))
    await screen.findByText("任务 1")
    await act(async () => resolve({ data: { rows: [makeJob(999)], total: 1 } }))
    expect(screen.queryByText("任务 999")).toBeNull()
    await waitFor(() => expect(screen.getByText("第 1–10 条，共 105 条")).toBeTruthy())
  })
})
