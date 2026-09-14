// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { DocumentImportPageResponse } from "@/lib/api"
import { DocumentImportAssets } from "./document-import-assets"

const mocks = vi.hoisted(() => ({ presignGet: vi.fn() }))
vi.mock("@/lib/api", () => ({ uploadApi: mocks }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

const page: DocumentImportPageResponse = {
  pageNo: 8, imageKey: "uploads/1/page.png", status: "done", extractedBy: "direct", markdown: "# 标题",
  error: null, lastError: null, deadLetteredAt: null, attemptCount: 1, maxAttempts: 5, nextAttemptAt: "",
  assets: [{ id: "image-1", imageKey: "uploads/1/photo.png", kind: "region", bounds: [0, 0, 1, 1], placement: "anchor", status: "failed", error: "upstream_error" }],
}

it("识别失败仍能展开原图和原页，预览失败可重新加载", async () => {
  mocks.presignGet.mockRejectedValueOnce(new Error("暂不可用")).mockResolvedValue({ data: { url: "/api/upload/local/photo.png" } })
  const { container } = render(<DocumentImportAssets page={page} />)
  expect(screen.getByText(/1 张识别失败，原图仍可查看/)).toBeTruthy()
  expect(mocks.presignGet).not.toHaveBeenCalled()
  const details = container.querySelector("details")!
  details.open = true
  fireEvent(details, new Event("toggle"))
  const retry = await screen.findByRole("button", { name: "重新加载" })
  expect(screen.getByText(/已放回段落附近/)).toBeTruthy()
  fireEvent.click(retry)
  await waitFor(() => expect(screen.getByAltText("第 8 页图片 1").getAttribute("src")).toBe("/api/upload/local/photo.png"))
  expect(screen.queryByAltText("第 8 页原页预览")).toBeNull()
  expect(mocks.presignGet).not.toHaveBeenCalledWith(page.imageKey)
  const preview = screen.getByText("查看原页对照（不插入正文）").closest("details")!
  preview.open = true
  fireEvent(preview, new Event("toggle"))
  expect(await screen.findByAltText("第 8 页原页预览")).toBeTruthy()
})

it("仅文字模式只显示识别状态，不加载图片或原页预览", () => {
  const { container } = render(<DocumentImportAssets page={page} imagePolicy="text_only" />)
  const details = container.querySelector("details")!
  details.open = true
  fireEvent(details, new Event("toggle"))
  expect(screen.getByText(/图片文字识别 · 1 个区域/)).toBeTruthy()
  expect(screen.getByText(/文章不保留图片/)).toBeTruthy()
  expect(screen.queryByRole("img")).toBeNull()
  expect(mocks.presignGet).not.toHaveBeenCalled()
})

it("仅图片模式明确显示跳过识别", () => {
  const { container } = render(<DocumentImportAssets page={{ ...page, assets: page.assets?.map((asset) => ({ ...asset, status: "skipped", error: undefined })) }} imagePolicy="images_only" />)
  mocks.presignGet.mockResolvedValue({ data: { url: "/photo.png" } })
  const details = container.querySelector("details")!
  details.open = true
  fireEvent(details, new Event("toggle"))
  expect(screen.getByText(/按策略跳过识别/)).toBeTruthy()
})
