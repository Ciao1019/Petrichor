import { describe, expect, it } from "vitest"

import { detectFileType, parseDocument, pickPagesNeedingVision, type ParsedDocument } from "./parse"

// 分块已经移到 Go 侧（apps/api/internal/chunker，移植自 WeKnora，
// 连带上游 139 个用例一起跑）。这里只覆盖浏览器还负责的部分：
// 把文件解析成正文，并给出页 / 工作表边界。

describe("detectFileType", () => {
    it("按扩展名识别支持的类型", () => {
        const cases: Array<[string, string | null]> = [
            ["a.md", "md"], ["a.markdown", "md"], ["a.PDF", "pdf"], ["a.docx", "docx"],
            ["a.xlsx", "xlsx"], ["a.xls", "xlsx"], ["a.csv", "csv"], ["a.tsv", "csv"],
            ["a.txt", null], ["a", null],
        ]
        for (const [name, expected] of cases) {
            expect(detectFileType(new File([""], name))).toBe(expected)
        }
    })
})

describe("parseDocument(md)", () => {
    it("返回完整正文，不再返回分片", async () => {
        const source = `# 知识库\n\n${"正文内容。".repeat(80)}`
        const parsed = await parseDocument(new File([source], "a.md", { type: "text/markdown" }), "md")

        expect(parsed.extractedText).toBe(source)
        expect(parsed.pageCount).toBeNull()
        expect(parsed.blocks).toEqual([])
        expect("chunks" in parsed).toBe(false)
    })

    it("归一化换行，避免 CRLF 影响服务端切分偏移", async () => {
        const parsed = await parseDocument(new File(["a\r\nb\rc"], "a.md"), "md")

        expect(parsed.extractedText).toBe("a\nb\nc")
    })

    it("给出单个 Markdown 分段，供服务端补定位信息", async () => {
        const parsed = await parseDocument(new File(["# 标题"], "a.md"), "md")

        expect(parsed.segments).toEqual([{ startOffset: 0, page: null, locator: "Markdown" }])
    })
})

describe("parseDocument(不支持的类型)", () => {
    it("返回空结果而不是抛错", async () => {
        const parsed = await parseDocument(new File(["x"], "a.bin"), "txt" as never)

        expect(parsed.extractedText).toBe("")
        expect(parsed.segments).toEqual([])
        expect(parsed.blocks).toEqual([])
    })
})

describe("pickPagesNeedingVision", () => {
    function parsed(pageTexts: string[]): ParsedDocument {
        return {
            pageCount: pageTexts.length,
            extractedText: pageTexts.join("\f"),
            segments: [],
            blocks: [],
        }
    }

    it("只挑出文本层几乎为空的页", () => {
        const doc = parsed(["这一页有足够多的正文内容，可以直接抽取出来使用，不需要走多模态识别。", "", "  \n ", "第四页同样有充足的正文内容，本地抽取即可，不需要模型识别。"])

        expect(pickPagesNeedingVision(doc, "auto")).toEqual([2, 3])
    })

    it("按扫描件解析时整份都要识别", () => {
        const doc = parsed(["这一页有足够多的正文内容，可以直接抽取出来使用，不需要走多模态识别。", "另一页也有充足的正文内容，本地抽取即可，不需要模型识别。"])

        expect(pickPagesNeedingVision(doc, "scan")).toEqual([1, 2])
    })

    it("非 PDF（没有页数）不产出待识别页", () => {
        const doc: ParsedDocument = { pageCount: null, extractedText: "markdown 正文", segments: [], blocks: [] }

        expect(pickPagesNeedingVision(doc, "scan")).toEqual([])
    })
})
