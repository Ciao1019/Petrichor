import { describe, expect, it } from "vitest"
import type { CaptureResult } from "@/lib/api-capture"
import { buildCaptureMarkdown, initialSelection, parseCaptureURLs, simpleCaptureOptions } from "./capture-utils"
const result: CaptureResult = { markdown: "原文", note: { title: "网页", summary: "摘要", takeaways: ["要点"], tags: [], quotes: [{ text: "原文", line: 1 }, { text: "无法核验的引用", line: 0 }] }, assets: [{ id: "image-1", sourceUrl: "https://example.com/a.png", key: "uploads/1/a.png", kind: "image" }], links: [], warnings: [], url: "https://example.com/post", finalUrl: "https://example.com/post", language: "zh", fetchedAt: "2026-09-17T00:00:00Z", statusCode: 200, inputTokens: 0, outputTokens: 0, hash: "sample" }
describe("网页采集", () => {
 it("旧草稿只保留整理意图，素材与选择器等参数不再参与新采集", () => {
   expect(simpleCaptureOptions({ mode: "assets", engine: "model", screenshot: true, includeTags: [".old"] })).toMatchObject({ mode: "read", engine: "model", screenshot: false, includeTags: [] })
   expect(simpleCaptureOptions().engine).toBe("none")
 })
 it("收藏原文直接保留文章排版，避免重复套标题", () => {
   const article = { ...result, markdown: "# 网页标题\n\n正文", note: { ...result.note, summary: "", takeaways: [], quotes: [] } }
   const markdown = buildCaptureMarkdown(article, initialSelection(article), "")
   expect(markdown.startsWith("# 网页标题\n\n正文")).toBe(true)
   expect(markdown).not.toContain("### 原文")
   expect(markdown).toContain("来源：")
 })
 it("去重并保留查询参数，移除片段", () => expect(parseCaptureURLs("https://example.com/a?q=1#x\nhttps://example.com/a?q=1#y", 10)).toEqual(["https://example.com/a?q=1"]))
 it("拒绝危险协议、凭据及超限批次", () => { for (const input of ["javascript:alert(1)", "https://me:secret@example.com", "invalid", "https://one.example https://two.example"]) expect(() => parseCaptureURLs(input, 1)).toThrow() })
 it("保存真实来源和引用定位，不把未匹配引用标成原文行号", () => { const md = buildCaptureMarkdown(result, { ...initialSelection(result), assets: ["image-1"] }, "我的观点"); expect(md).toContain("原文第 1 行"); expect(md).toContain("未匹配到原文"); expect(md).toContain("s4key:uploads/1/a.png"); expect(md).toContain("我的观点"); expect(md).toContain("https://example.com/post") })
 it("超长原文不自动塞进随笔，但保留完整来源", () => { const long = { ...result, markdown: "长".repeat(21000), note: { ...result.note, summary: "", quotes: [] } }; expect(initialSelection(long).original).toBe(false); expect(buildCaptureMarkdown(long, initialSelection(long), "").length).toBeLessThan(20000); expect(long.markdown.length).toBe(21000) })
})
