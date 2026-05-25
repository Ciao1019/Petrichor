import { describe, expect, it } from "vitest"
import {
    buildArticleAiSummaryExcerpt,
    buildArticleAiSummaryContentHash,
    buildArticleSummaryUserMessage,
    isArticleAiSummaryCacheHit,
    normalizeArticleSummaryModelOutput,
    resolveDisplayArticleAiSummary,
    resolveUsableArticleAiSummary,
    validateArticleSummaryGenerateInput,
} from "./article-summary-logic"
import { buildPublicArticleContentHash } from "./share-logic"

describe("article summary logic", () => {
    it("校验文章总结生成输入", () => {
        expect(validateArticleSummaryGenerateInput({ articleId: " 12 ", forceRebuild: true })).toEqual({
            articleId: 12,
            forceRebuild: true,
        })
        expect(validateArticleSummaryGenerateInput({ articleId: 9 })).toEqual({
            articleId: 9,
            forceRebuild: false,
        })
        expect(() => validateArticleSummaryGenerateInput({ articleId: "" })).toThrow("文章ID不能为空")
        expect(() => validateArticleSummaryGenerateInput({ articleId: "abc" })).toThrow("文章ID非法")
    })

    it("生成与公开内容一致的摘要内容哈希", () => {
        const markdown = "# 标题\n\n正文"
        expect(buildArticleAiSummaryContentHash(markdown)).toBe(buildPublicArticleContentHash(markdown))
    })

    it("构造摘要用户消息并限制模型输入长度", () => {
        const message = buildArticleSummaryUserMessage({
            title: "标题",
            contentMd: "a".repeat(12002),
        })

        expect(message).toContain("文章标题：标题")
        expect(message).toContain("[内容已截断]")
        expect(message.length).toBeLessThan(12100)
    })

    it("规范化模型摘要输出", () => {
        expect(normalizeArticleSummaryModelOutput("```text\n摘要：  这是一段 总结。\n```")).toBe("这是一段 总结。")
        expect(normalizeArticleSummaryModelOutput("x".repeat(430))).toHaveLength(423)
        expect(() => normalizeArticleSummaryModelOutput("   ")).toThrow("模型未返回有效摘要")
    })

    it("只使用与当前正文哈希匹配的 AI 总结", () => {
        const currentHash = buildArticleAiSummaryContentHash("正文")

        expect(isArticleAiSummaryCacheHit({
            currentHash,
            storedHash: currentHash,
            summary: "总结",
        })).toBe(true)
        expect(isArticleAiSummaryCacheHit({
            currentHash,
            storedHash: "old",
            summary: "总结",
        })).toBe(false)

        expect(resolveUsableArticleAiSummary({
            currentContentHash: currentHash,
            summaryContentHash: currentHash,
            summary: "  总结  ",
        })).toBe("总结")
        expect(resolveUsableArticleAiSummary({
            currentContentHash: currentHash,
            summaryContentHash: "old",
            summary: "总结",
        })).toBeNull()

        expect(resolveDisplayArticleAiSummary({
            summary: "  旧总结仍可展示  ",
        })).toBe("旧总结仍可展示")

        expect(buildArticleAiSummaryExcerpt({
            summary: "这是一段用于列表展示的 AI 总结",
        }, 8)).toBe("这是一段用于列表...")
    })
})
