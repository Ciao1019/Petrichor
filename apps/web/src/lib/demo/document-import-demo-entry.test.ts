// @vitest-environment jsdom
import axios from "axios"
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { documentImportApi, uploadApi, type DocumentImportFinalizeResponse, type DocumentImportJobResponse } from "@/lib/api"
import { resetAuthSession } from "@/lib/auth-session-events"
import { uploadFileToObjectStorage } from "@/lib/object-storage-upload"
import { useDocumentImport } from "@/components/knowledge/use-document-import"
import { completeDemoUpload } from "./demo-adapter"
import { enterDemoMode } from "./demo-mode"

beforeEach(() => {
  resetAuthSession()
  enterDemoMode()
  vi.spyOn(console, "info").mockImplementation(() => {})
  // 若演示上传漏出适配层，立即失败，测试本身也绝不发出真实请求。
  vi.spyOn(axios, "getAdapter").mockImplementation(() => { throw new Error("禁止真实 Axios 网络") })
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("禁止真实 fetch") }))
  vi.stubGlobal("XMLHttpRequest", vi.fn(function () { throw new Error("禁止真实 PUT") }))
})
afterEach(() => {
  cleanup()
  resetAuthSession()
  window.sessionStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("真实导入 hook + 演示上传适配入口", () => {
  it.each([
    ["demo-import-office", null], ["demo-import-1", "demo-a-fastfetch"],
  ] as const)("finalize API 返回 HTTP 200 的 job + 可空 articleId，无 nodeId：%s", async (jobId, articleId) => {
    const response = await documentImportApi.finalize({ jobId })
    expectTypeOf(response.data).toEqualTypeOf<DocumentImportFinalizeResponse>()
    expectTypeOf(response.data).toEqualTypeOf<{ job: DocumentImportJobResponse; articleId: string | null }>()
    expect(response.status).toBe(200)
    expect(response.data.articleId).toBe(articleId)
    expect(response.data.job.id).toBe(jobId)
    expect(response.data.job.status).toBe(articleId ? "completed" : "pending")
    expect(Object.keys(response.data).sort()).toEqual(["articleId", "job"])
    expect(axios.getAdapter).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(XMLHttpRequest).not.toHaveBeenCalled()
  })

  it("选择文件后内存上传获得 sourceKey，create 丢响应也沿冻结 UUID 重试且不重复上传", async () => {
    const file = new File(["不会被读取或上传的原件"], "demo.pdf", { type: "application/pdf" })
    const slice = vi.spyOn(file, "slice")
    const presign = vi.spyOn(uploadApi, "presignPut")
    const createJob = documentImportApi.createJob
    const create = vi.spyOn(documentImportApi, "createJob").mockImplementationOnce(async (...args) => {
      await createJob(...args)
      throw new Error("模拟已创建但响应丢失")
    })
    const onJobCreated = vi.fn()
    const { result, rerender } = renderHook(({ concurrency }) => useDocumentImport({
      knowledgeBaseId: "demo-kb-product", parentId: null, concurrency, onJobCreated,
    }), { initialProps: { concurrency: 4 } })
    act(() => result.current.setItems([{ id: "picked-demo", file, title: "演示入口文档", status: "pending" }]))
    await act(async () => {
      expect(await result.current.runImport(result.current.items)).toEqual({ completed: 0, submitted: 0, failed: 1 })
    })
    const first = result.current.items[0]!
    expect(first.sourceKey).toMatch(/^demo\/uploads\/[^/]+\/demo.pdf$/)
    expect(first.uploadPercent).toBe(100)
    expect(Object.isFrozen(first.request)).toBe(true)
    expect(first.request).toMatchObject({ sourceKey: first.sourceKey, title: "演示入口文档", concurrency: 4 })
    expect(first.request?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.request).not.toHaveProperty("pages")
    rerender({ concurrency: 8 })
    act(() => result.current.updateItem(first.id, { title: "重试时修改标题" }))
    await act(async () => {
      expect(await result.current.runImport(result.current.items)).toEqual({ completed: 0, submitted: 1, failed: 0 })
    })
    const submitted = result.current.items[0]!
    expect(submitted.status).toBe("submitted")
    expect(create.mock.calls[1]![0]).toBe(create.mock.calls[0]![0])
    expect(presign).toHaveBeenCalledTimes(1)
    expect(onJobCreated).toHaveBeenCalledWith(submitted.jobId)
    const detail = await documentImportApi.detail({ jobId: submitted.jobId! })
    expect(detail.data).toMatchObject({ job: { stage: "preparing", totalPages: 0, status: "pending", title: "演示入口文档" }, pages: [] })
    const list = await documentImportApi.list({ knowledgeBaseId: "demo-kb-product", pageNum: 1, pageSize: 1 })
    expect(list.data.rows).toHaveLength(1)
    expect(list.data.rows[0]!.id).toBe(submitted.jobId)
    expect(list.data.total).toBeGreaterThan(1)
    const second = await documentImportApi.list({ knowledgeBaseId: "demo-kb-product", pageNum: 2, pageSize: 1 })
    expect(second.data.rows[0]!.id).not.toBe(submitted.jobId)
    expect(second.data.total).toBe(list.data.total)
    expect(slice).not.toHaveBeenCalled()
    expect(axios.getAdapter).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(XMLHttpRequest).not.toHaveBeenCalled()
  })

  it("演示模式不接受真实 PUT 地址，未知凭据或退出演示后也不会回退联网", async () => {
    const file = new File(["private"], "demo.pdf")
    vi.spyOn(uploadApi, "presignPut").mockResolvedValueOnce({ data: { objectKey: "real-key", presignedUrl: "https://storage.invalid/upload" } } as Awaited<ReturnType<typeof uploadApi.presignPut>>)
    await expect(uploadFileToObjectStorage(file)).rejects.toThrow("演示上传凭据无效")
    expect(() => completeDemoUpload("demo-upload:unknown", "wrong-key")).toThrow("演示上传凭据无效")
    const { data } = await uploadApi.presignPut({ filename: file.name })
    window.sessionStorage.clear()
    expect(() => completeDemoUpload(data.presignedUrl, data.objectKey)).toThrow("演示上传凭据无效")
    expect(XMLHttpRequest).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(axios.getAdapter).not.toHaveBeenCalled()
  })

  it("演示预签名返回后中止，保留上传中止语义而不发出 PUT", async () => {
    const controller = new AbortController()
    const presignPut = uploadApi.presignPut
    vi.spyOn(uploadApi, "presignPut").mockImplementationOnce(async (...args) => {
      const response = await presignPut(...args)
      controller.abort()
      return response
    })
    await expect(uploadFileToObjectStorage(new File(["private"], "demo.pdf"), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
    expect(XMLHttpRequest).not.toHaveBeenCalled()
    expect(axios.getAdapter).not.toHaveBeenCalled()
  })
})
