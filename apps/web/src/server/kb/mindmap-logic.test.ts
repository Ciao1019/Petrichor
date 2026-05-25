import { describe, expect, it } from "vitest"
import {
    buildMindmapContentHash,
    buildSimpleMindmapData,
    buildMindmapUserMessage,
    extractJsonObjectText,
    isMindmapCacheHit,
    normalizeMindmapModelOutput,
    validateMindmapGenerateInput,
} from "./mindmap-logic"

describe("kb mindmap logic", () => {
    it("校验生成请求并默认使用 MINDMAP 模式", () => {
        expect(validateMindmapGenerateInput({ articleId: " 1 " })).toEqual({
            articleId: 1,
            forceRebuild: false,
            mode: "MINDMAP",
        })
        expect(validateMindmapGenerateInput({ articleId: "2", forceRebuild: true, mode: "KNOWLEDGE_GRAPH" }).mode).toBe("KNOWLEDGE_GRAPH")
        expect(() => validateMindmapGenerateInput({ articleId: "" })).toThrow("不能为空")
        expect(() => validateMindmapGenerateInput({ articleId: "abc" })).toThrow("需要匹配正则表达式\"\\d+\"")
    })

    it("计算内容哈希并判断缓存命中", () => {
        const hash = buildMindmapContentHash("标题", "内容")

        expect(hash).toHaveLength(64)
        expect(isMindmapCacheHit({ currentHash: hash, storedHash: hash, storedJson: "{\"nodeData\":{}}" })).toBe(true)
        expect(isMindmapCacheHit({ currentHash: hash, storedHash: "x", storedJson: "{\"nodeData\":{}}" })).toBe(false)
        expect(isMindmapCacheHit({ currentHash: hash, storedHash: hash, storedJson: "" })).toBe(false)
    })

    it("从 Markdown 标题生成 MindElixir 基础结构", () => {
        const data = buildSimpleMindmapData("文章", "# 一级\n## 二级\n正文", "MINDMAP")

        expect(data).toMatchObject({
            nodeData: {
                expanded: true,
                root: true,
                topic: "文章",
            },
        })
        expect((data.nodeData.children ?? [])[0]).toMatchObject({ topic: "一级" })
    })

    it("提取并规范化模型输出的 MindElixir JSON", () => {
        const raw = "```json\n{\"nodeData\":{\"topic\":\"根\",\"children\":[{\"topic\":\"子\"}]}}\n```"
        const normalized = normalizeMindmapModelOutput(JSON.parse(extractJsonObjectText(raw)), "文章", "MINDMAP")

        expect(normalized).toMatchObject({
            nodeData: {
                id: "root",
                root: true,
                topic: "根",
                children: [{ id: "n1", topic: "子" }],
            },
        })
    })

    it("构建模型用户消息并限制输入长度", () => {
        const message = buildMindmapUserMessage({
            knowledgeBaseName: "知识库",
            title: "标题",
            contentMd: "a".repeat(13000),
        })

        expect(message).toContain("知识库：知识库")
        expect(message.length).toBeLessThan(12500)
    })
})
