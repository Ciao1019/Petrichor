import { describe, expect, it } from "vitest"
import { extractMessageText, normalizeMarkdown } from "./vision"

describe("vision response helpers", () => {
    it("从字符串或多模态数组中提取文本", () => {
        expect(extractMessageText("# 标题")).toBe("# 标题")
        expect(extractMessageText([
            { type: "text", text: "第一段" },
            { type: "text", text: "第二段" },
        ])).toBe("第一段第二段")
        expect(extractMessageText(null)).toBe("")
        expect(extractMessageText(undefined)).toBe("")
    })

    it("去除模型包裹的 markdown 围栏", () => {
        expect(normalizeMarkdown("```markdown\n# 标题\n正文\n```")).toBe("# 标题\n正文")
        expect(normalizeMarkdown("```md\n内容\n```")).toBe("内容")
        expect(normalizeMarkdown("  # 普通标题  ")).toBe("# 普通标题")
        expect(normalizeMarkdown("")).toBe("")
    })
})
