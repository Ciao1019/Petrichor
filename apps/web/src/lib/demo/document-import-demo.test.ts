import { describe, expect, it } from "vitest"
import type { DocumentImportCreateResponse, DocumentImportFinalizeResponse, DocumentImportJobResponse, DocumentImportPageResponse } from "@/lib/api"
import { resolveLatestDemoHandler } from "./demo-latest-handlers"
import { demoStore } from "./demo-store"
import { isJobActive, resolveJobProgress } from "@/features/pages/knowledge/document-import-job-shared"

function detail(jobId: string) {
  return resolveLatestDemoHandler("POST /kb/import/detail")!({ jobId }).data as { job: DocumentImportJobResponse; pages: DocumentImportPageResponse[] }
}

describe("服务端文档导入演示", () => {
  it("finalize 只进入 finalizing，重复提交不创建文章或节点", () => {
    const finalize = resolveLatestDemoHandler("POST /kb/import/finalize")!
    const before = structuredClone({ articles: demoStore.articles, nodes: demoStore.nodes })
    const jobId = "demo-import-office"
    const pages = detail(jobId).pages
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = finalize({ jobId })
      const data = result.data as DocumentImportFinalizeResponse
      expect(result.status ?? 200).toBe(200)
      expect(Object.keys(data).sort()).toEqual(["articleId", "job"])
      expect(data).toMatchObject({ job: { id: jobId, status: "pending", stage: "finalizing", articleId: null }, articleId: null })
      expect(detail(jobId)).toEqual({ job: data.job, pages })
      expect(isJobActive(data.job)).toBe(true)
    }
    expect({ articles: demoStore.articles, nodes: demoStore.nodes }).toEqual(before)
  })
  it("completed finalize 只读返回已有文章，不重置任务或新增内容", () => {
    const finalize = resolveLatestDemoHandler("POST /kb/import/finalize")!
    const jobId = "demo-import-1"
    const before = structuredClone({ detail: detail(jobId), articles: demoStore.articles, nodes: demoStore.nodes })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(finalize({ jobId }).data).toEqual({ job: before.detail.job, articleId: "demo-a-fastfetch" })
    }
    expect({ detail: detail(jobId), articles: demoStore.articles, nodes: demoStore.nodes }).toEqual(before)
  })
  it("finalize 拒绝不存在或未完成解析的任务", () => {
    const finalize = resolveLatestDemoHandler("POST /kb/import/finalize")!
    expect(finalize({ jobId: "missing-job" }).status).toBe(404)
    const before = structuredClone(detail("demo-import-parsing"))
    expect(finalize({ jobId: "demo-import-parsing" }).status).toBe(400)
    expect(detail("demo-import-parsing")).toEqual(before)
  })
  it("零页解析中样例继续轮询，不显示百分比", () => {
    const { job, pages } = detail("demo-import-parsing")
    expect(job).toMatchObject({ stage: "parsing", totalPages: 0, status: "processing" })
    expect(pages).toEqual([])
    expect(isJobActive(job)).toBe(true)
    expect(resolveJobProgress(job)).toMatchObject({ active: true, value: null })
  })
  it("零页解析失败经现有 retry-failed 重置准备任务", () => {
    expect(detail("demo-import-parse-failed").job.status).toBe("failed")
    const result = resolveLatestDemoHandler("POST /kb/import/retry-failed")!({ jobId: "demo-import-parse-failed" })
    expect(result.data).toEqual({ retried: 0, reset: 1, status: "pending" })
    expect(detail("demo-import-parse-failed")).toMatchObject({ job: { status: "pending", stage: "preparing", totalPages: 0, error: null }, pages: [] })
  })
  it("create 仅内存模拟，同 key 重复提交不新增，改参数返回冲突且不接受页计划", () => {
    const create = resolveLatestDemoHandler("POST /kb/import/create")!
    const body = { idempotencyKey: "357dd66d-dd71-4a09-b365-3321f8559cf4", knowledgeBaseId: "demo-kb-product", fileName: "test.pdf", sourceKey: "demo/source.pdf", title: "演示原件" }
    const first = create(body).data as DocumentImportCreateResponse
    expect(first).toMatchObject({ job: { stage: "preparing", totalPages: 0, status: "pending" }, articleId: null })
    expect(Object.keys(first).sort()).toEqual(["articleId", "job"])
    expect(create({ ...body }).data).toEqual(first)
    expect(create({ ...body, imagePolicy: "keep_and_recognize" }).data).toEqual(first)
    expect(create({ ...body, imagePolicy: "images_only" }).status).toBe(409)
    expect(create({ ...body, imagePolicy: "invalid" }).status).toBe(400)
    expect(create({ ...body, title: "不同标题" }).status).toBe(409)
    expect(create({ ...body, pages: [] }).status).toBe(400)
    expect(detail(first.job.id).pages).toEqual([])
  })
})
