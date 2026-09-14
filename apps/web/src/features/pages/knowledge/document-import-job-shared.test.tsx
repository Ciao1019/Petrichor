import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { DocumentImportJobResponse, DocumentImportPageResponse } from "@/lib/api"
import { DocumentImportMethods, DocumentImportPageMethod, DocumentImportProgress } from "./document-import-job-components"
import { countSuccessfulMethods, resolveJobProgress, resolvePageMethodLabel, canRetryImportPage, canRetryImportPreparation, isGeneratingArticle, isJobActive, resolveJobStage, STAGE_LABELS } from "./document-import-job-shared"

const job: DocumentImportJobResponse = {
  id: "1", knowledgeBaseId: "1", knowledgeBaseName: null, parentNodeId: null, parentFolderName: null,
  sourceType: "pdf", fileName: "test.pdf", title: "测试", totalPages: 4, processedPages: 3,
  donePages: 2, failedPages: 1, pendingPages: 1, status: "processing", modelConfigId: null,
  articleId: null, error: null, deadLetteredAt: null, replayCount: 0, createdAt: "", updatedAt: "",
  pageUnit: "page", actualMethods: ["direct", "multimodal"],
  directPages: 1, multimodalPages: 1,

}
function page(patch: Partial<DocumentImportPageResponse>): DocumentImportPageResponse {
  return {
    pageNo: 1, imageKey: null, extractedBy: "direct", status: "done",
    markdown: "", error: null, attemptCount: 0, maxAttempts: 3, nextAttemptAt: "", lastError: null, deadLetteredAt: null,
    ...patch,
  }
}

describe("文档导入任务真实进度", () => {
  it("使用成功数，不把失败数作为成功", () => {
    expect(resolveJobProgress(job)).toMatchObject({ active: true, value: 50 })
  })
  it.each(["failed", "dead_letter", "canceled"] as const)("%s 终态停止动效", (status) => {
    const progress = resolveJobProgress({ ...job, status })
    expect(progress.active).toBe(false)
    const markup = renderToStaticMarkup(<DocumentImportProgress job={{ ...job, status }} />)
    expect(markup).toContain('data-state="stopped"')
    expect(markup).toContain('aria-busy="false"')
    expect(markup).not.toContain("pointer-events-none")
  })
  it("任务完成才允许整体 100%", () => {
    expect(resolveJobProgress({ ...job, status: "completed", donePages: 4 }).value).toBe(100)
    const progress = resolveJobProgress({ ...job, donePages: 4, failedPages: 0 })
    expect(progress.value).toBeNull()
    expect(progress.label).toContain("正在生成文章")
    expect(renderToStaticMarkup(<DocumentImportProgress job={{ ...job, donePages: 4 }} />)).not.toContain('aria-valuenow="100"')
  })
  it("未知总量使用阶段，不显示伪造百分比", () => {
    const unknown = { ...job, totalPages: 0, donePages: 0, failedPages: 0 }
    expect(resolveJobProgress(unknown)).toMatchObject({ value: null, active: true })
    const markup = renderToStaticMarkup(<DocumentImportProgress job={unknown} />)
    expect(markup).toContain("总量待确认")
    expect(markup).not.toContain("aria-valuenow=")
  })
  it.each(["preparing", "parsing", "rendering", "ocr", "finalizing", "completed"] as const)("显示服务端 %s 阶段，列表 / 详情使用相同的轮询判断", (stage) => {
    const current = { ...job, stage, status: stage === "completed" ? "completed" as const : "processing" as const }
    expect(resolveJobStage(current)).toBe(stage)
    expect(resolveJobProgress(current).label).toContain(STAGE_LABELS[stage])
    expect(isJobActive(current)).toBe(stage !== "completed")
  })
  it.each([undefined, "preparing", "parsing", "finalizing", "completed"] as const)("零页 stage=%s 仍轮询，绝不视为成文或完成", (stage) => {
    const unknown = { ...job, totalPages: 0, donePages: 0, failedPages: 0, stage }
    expect(resolveJobProgress(unknown)).toMatchObject({ active: true, value: null })
    expect(isJobActive(unknown)).toBe(true)
    expect(isGeneratingArticle(unknown)).toBe(false)
    expect(["preparing", "parsing"]).toContain(resolveJobStage(unknown))
    expect(resolveJobProgress(unknown).label).not.toMatch(/生成文章|已完成/)
  })
  it("兼容缺省 stage 的历史状态与页数", () => {
    expect(resolveJobStage({ ...job, totalPages: 0, status: "pending" })).toBe("preparing")
    expect(resolveJobStage({ ...job, totalPages: 0 })).toBe("parsing")
    expect(resolveJobStage(job)).toBe("ocr")
    expect(resolveJobStage({ ...job, donePages: 4 })).toBe("finalizing")
    expect(resolveJobStage({ ...job, status: "completed" })).toBe("completed")
  })
  it.each(["failed", "dead_letter"] as const)("%s 零页解析失败开放任务重试，停止轮询 / 动效且不要求 page", (status) => {
    const failed = { ...job, status, stage: "parsing" as const, totalPages: 0, donePages: 0, failedPages: 0 }
    expect(canRetryImportPreparation(failed)).toBe(true)
    expect(isJobActive(failed)).toBe(false)
    expect(resolveJobProgress(failed)).toMatchObject({ active: false, value: null })
    expect(resolveJobProgress(failed).label).toContain("服务端解析失败")
    for (const patch of [{ status: "canceled" as const }, { status: "processing" as const }, { articleId: "1" }, { totalPages: 2 }]) {
      expect(canRetryImportPreparation({ ...failed, ...patch })).toBe(false)
    }
  })
  it("非 PDF 明确文档单元而非物理页", () => {
    expect(resolveJobProgress({ ...job, sourceType: "docx", pageUnit: "document" }).label).toContain("文档单元")
  })
})

describe("直接解析与多模态来源", () => {
  it("展示实际成功方式，不展示供应商顺序和降级信息", () => {
    const markup = renderToStaticMarkup(<DocumentImportMethods job={job} />)
    for (const label of ["直接解析 1", "多模态 1", "混合方式"]) expect(markup).toContain(label)
    for (const removed of ["Firecrawl", "降级", "OCR 顺序"]) expect(markup).not.toContain(removed)
  })
  it("失败不冒充成功来源", () => {
    const failed = { ...job, directPages: 0, multimodalPages: 0 }
    const pages = [page({ extractedBy: "ocr", status: "failed" })]
    for (const markup of [
      renderToStaticMarkup(<DocumentImportMethods job={failed} />),
      renderToStaticMarkup(<DocumentImportMethods job={failed} pages={pages} />),
    ]) {
      expect(markup).toContain("尚无成功单元")
      expect(markup).toContain("多模态 0")
      expect(markup).not.toContain("降级")
    }
  })
  it("只统计 done，待 OCR 不等于已成功使用多模态", () => {
    const pages = [page({}), page({ extractedBy: "multimodal" }), page({ extractedBy: "multimodal", status: "failed" }), page({ extractedBy: "ocr", status: "processing" })]
    expect(countSuccessfulMethods(pages)).toEqual({ direct: 1, multimodal: 1 })
    expect(resolvePageMethodLabel(pages[3]!)).toBe("待 OCR 识别")
  })
  it("逐页显示实际来源，失败图片页可以重试", () => {
    const markup = renderToStaticMarkup(<DocumentImportPageMethod page={page({ extractedBy: "multimodal" })} />)
    expect(markup).toContain("多模态")
    expect(markup).not.toContain("降级")
    for (const extractedBy of ["ocr", "multimodal"] as const) {
      expect(canRetryImportPage(page({ extractedBy, status: "failed" }))).toBe(true)
    }
    expect(canRetryImportPage(page({ status: "failed" }))).toBe(false)
    expect(canRetryImportPage(page({ extractedBy: "multimodal" }))).toBe(false)
  })
})
