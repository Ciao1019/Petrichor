// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { DocumentImportFileRow } from "./document-import-file-row"
import type { ImportItem } from "./use-document-import"

vi.mock("@/lib/api", () => ({ documentImportApi: {} }))
afterEach(cleanup)
const item: ImportItem = { id: "file-1", file: new File(["pdf"], "test.pdf"), title: "初始标题", status: "pending" }

describe("导入文件行", () => {
  it("首次 create 前可改标题，冻结后失败项不能改标题复用 key", () => {
    const onTitleChange = vi.fn()
    const props = { item, busy: false, onTitleChange, onRemove: vi.fn() }
    const view = render(<DocumentImportFileRow {...props} />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "新的标题" } })
    expect(onTitleChange).toHaveBeenCalledWith("新的标题")
    const request = Object.freeze({ idempotencyKey: "5c7c4f8d-7d99-4a28-859a-9150780b604f", knowledgeBaseId: "1", fileName: "test.pdf", title: item.title, sourceKey: "stable" })
    view.rerender(<DocumentImportFileRow {...props} item={{ ...item, status: "failed", request, error: "提交超时" }} />)
    expect(screen.getByRole("textbox").hasAttribute("disabled")).toBe(true)
    expect(screen.getByText(/重试沿用已锁定/)).toBeTruthy()
    expect(screen.queryByText(/浏览器补图/)).toBeNull()
  })
  it("提交成功即可关闭，停止浏览器进度且不假报 100%", () => {
    render(<DocumentImportFileRow item={{ ...item, status: "submitted", jobId: "job-1" }} busy={false} onTitleChange={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByText(/任务已提交，可关闭页面/)).toBeTruthy()
    expect(screen.getByRole("progressbar").getAttribute("aria-busy")).toBe("false")
    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false)
    expect(screen.queryByRole("textbox")).toBeNull()
  })
})
