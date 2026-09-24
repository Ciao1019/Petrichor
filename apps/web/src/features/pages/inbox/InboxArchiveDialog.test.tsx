// @vitest-environment jsdom
import * as React from "react"
import { AxiosHeaders, type AxiosResponse } from "axios"
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { inboxApi, knowledgeBaseApi, knowledgeBaseNodeApi, type InboxArchiveRecommendation, type InboxNote, type KnowledgeBaseTreeResponse } from "@/lib/api"
import { InboxArchiveDialog } from "./InboxArchiveDialog"

configure({ asyncUtilTimeout: 5000 })

vi.mock("@/lib/api", () => ({ inboxApi: { recommendationConfig: vi.fn(), recommend: vi.fn(), archive: vi.fn() }, knowledgeBaseApi: { list: vi.fn() }, knowledgeBaseNodeApi: { tree: vi.fn() } }))
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }))
// 原生 select 用于验证异步表单接线；真实 Radix 键盘与弹层由浏览器验收。
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, disabled, onValueChange, children }: { value: string; disabled?: boolean; onValueChange: (value: string) => void; children: React.ReactNode }) => <select value={value} disabled={disabled} onChange={(event) => onValueChange(event.target.value)}>{children}</select>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => <option value={value}>{React.Children.toArray(children).filter((child) => typeof child === "string")}</option>,
  SelectTrigger: () => null, SelectValue: () => null,
}))

const note: InboxNote = { id: "11", contentMd: "PostgreSQL 索引笔记", tags: ["随手记"], pinned: false, version: 2, createdAt: "2026-09-21", updatedAt: "2026-09-21", archivedAt: null, articleId: null, articleTitle: null, knowledgeBaseId: null, knowledgeBaseName: null }
const recommendation: InboxArchiveRecommendation = { status: "recommended", destination: { knowledgeBaseId: "2", knowledgeBaseName: "数据库", parentId: "22", folderPath: "后端 / PostgreSQL" }, alternatives: [], tags: ["PostgreSQL"], warnings: [], confidence: .95, model: "jev", usage: { input_tokens: 100, output_tokens: 0 }, feedbackToken: "signed-test" }
const response = <T,>(data: T): AxiosResponse<T> => ({ data, status: 200, statusText: "OK", headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } })
const folderTree: KnowledgeBaseTreeResponse = { knowledgeBaseId: "2", roots: [{ id: "22", parentId: null, name: "PostgreSQL", type: "FOLDER", sortOrder: 0, children: [] }], totalRootNodes: 1 }

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(knowledgeBaseApi.list).mockResolvedValue(response({ rows: [{ id: "1", name: "阅读" }, { id: "2", name: "数据库" }].map((base) => ({ ...base, description: "", createdAt: "2026-09-21", updatedAt: "2026-09-21" })), total: 2, code: 200, msg: "" }))
  vi.mocked(knowledgeBaseNodeApi.tree).mockImplementation(async (baseId) => response<KnowledgeBaseTreeResponse>(baseId === "2" ? folderTree : { knowledgeBaseId: baseId, roots: [], totalRootNodes: 0 }))
  vi.mocked(inboxApi.recommendationConfig).mockResolvedValue(response({ enabled: true }))
  vi.mocked(inboxApi.recommend).mockResolvedValue(response(recommendation))
  vi.mocked(inboxApi.archive).mockResolvedValue(response({ ...note, articleId: "99", archivedAt: "2026-09-21" }))
})
afterEach(cleanup)
const mount = () => render(<MemoryRouter><InboxArchiveDialog note={note} onClose={vi.fn()} onArchived={vi.fn()} /></MemoryRouter>)

describe("随笔归档推荐", () => {
  it("点击后才调用，采纳时等待目标文件夹，确认后带入标签且保留原随笔", async () => {
    mount()
    fireEvent.change(await screen.findByLabelText("文章标题"), { target: { value: "我修改的标题" } })
    await screen.findByRole("button", { name: "获取推荐" })
    expect(inboxApi.recommend).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "获取推荐" }))
    await screen.findByRole("button", { name: "一键采纳" })
    expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).value).toBe("1")
    let finish!: (data: Awaited<ReturnType<typeof knowledgeBaseNodeApi.tree>>) => void
    vi.mocked(knowledgeBaseNodeApi.tree).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    fireEvent.click(screen.getByRole("button", { name: "一键采纳" }))
    await waitFor(() => expect(knowledgeBaseNodeApi.tree).toHaveBeenCalledWith("2", expect.anything()))
    expect((screen.getByRole("button", { name: "确认归档" }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { finish(response(folderTree)) })
    expect((screen.getAllByRole("combobox")[1] as HTMLSelectElement).value).toBe("22")
    expect(inboxApi.archive).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }))
    await waitFor(() => expect(inboxApi.archive).toHaveBeenCalledWith(expect.objectContaining({ title: "我修改的标题", knowledgeBaseId: "2", parentId: "22", tags: ["随手记", "PostgreSQL"], recommendationToken: "signed-test", recommendationApplied: true })))
    expect(note.tags).toEqual(["随手记"])
  })

  it("推荐失败可以重试，仍能按当前输入手动归档", async () => {
    vi.mocked(inboxApi.recommend).mockRejectedValueOnce(new Error("timeout"))
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "获取推荐" }))
    await screen.findByRole("alert")
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }))
    await waitFor(() => expect(inboxApi.archive).toHaveBeenCalledWith(expect.objectContaining({ knowledgeBaseId: "1", tags: ["随手记"] })))
  })

  it("未启用或没有匹配时，不会强制修改归档位置", async () => {
    vi.mocked(inboxApi.recommendationConfig).mockResolvedValueOnce(response({ enabled: false }))
    const first = mount()
    await screen.findByText("智能推荐尚未启用，可以手动选择归档位置。")
    expect(screen.queryByRole("button", { name: "获取推荐" })).toBeNull()
    first.unmount()
    vi.mocked(inboxApi.recommend).mockResolvedValueOnce(response<InboxArchiveRecommendation>({ ...recommendation, status: "no_match", destination: null, tags: [] }))
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "获取推荐" }))
    await screen.findByText(/暂未找到合适的知识库/)
    expect(screen.queryByRole("button", { name: "一键采纳" })).toBeNull()
    expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).value).toBe("1")
  })

  it("不确定结果展示候选，选择后可继续调整并移除推荐标签", async () => {
    vi.mocked(inboxApi.recommend).mockResolvedValueOnce(response<InboxArchiveRecommendation>({ ...recommendation, status: "uncertain", destination: null, alternatives: [{ ...recommendation.destination!, parentId: null, folderPath: "知识库根目录" }] }))
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "获取推荐" }))
    fireEvent.click(await screen.findByRole("button", { name: "数据库" }))
    await waitFor(() => expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).value).toBe("2"))
    // 选择候选位置不应把尚未采纳的标签标成已采纳。
    await waitFor(() => expect((screen.getByRole("button", { name: "确认归档" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "采纳推荐标签" }))
    fireEvent.click(await screen.findByRole("button", { name: "移除标签 PostgreSQL" }))
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }))
    await waitFor(() => expect(inboxApi.archive).toHaveBeenCalledWith(expect.objectContaining({ knowledgeBaseId: "2", parentId: null, tags: ["随手记"] })))
  })

  it("关闭后取消未完成推荐，不再应用迟到结果", async () => {
    let signal: AbortSignal | undefined
    let finish!: (data: Awaited<ReturnType<typeof inboxApi.recommend>>) => void
    vi.mocked(inboxApi.recommend).mockImplementation((_id, _version, inputSignal) => { signal = inputSignal; return new Promise((resolve) => { finish = resolve }) })
    const view = mount()
    fireEvent.click(await screen.findByRole("button", { name: "获取推荐" }))
    expect((screen.getByRole("button", { name: "正在分析…" }) as HTMLButtonElement).disabled).toBe(true)
    view.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => { finish(response(recommendation)) })
    expect(inboxApi.archive).not.toHaveBeenCalled()
  })
})
