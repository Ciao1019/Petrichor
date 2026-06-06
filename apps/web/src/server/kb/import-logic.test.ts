import { describe, expect, it } from "vitest"
import { parseImportSourceType, rewriteImageRefs } from "./import-logic"

describe("document import logic", () => {
    it("解析受支持的来源类型", () => {
        expect(parseImportSourceType("pdf")).toBe("pdf")
        expect(parseImportSourceType("PDF")).toBe("pdf")
        expect(parseImportSourceType("docx")).toBe("docx")
        expect(parseImportSourceType("doc")).toBeNull()
        expect(parseImportSourceType(undefined)).toBeNull()
    })

    it("把相对图片路径改写为转存后的地址", () => {
        const markdown = "前言\n\n![](images/a.jpg)\n\n![图](images/b.png)"
        const result = rewriteImageRefs(markdown, [
            { ref: "images/a.jpg", url: "s4key:uploads/1/x.jpg" },
            { ref: "images/b.png", url: "s4key:uploads/1/y.png" },
        ])
        expect(result).toBe("前言\n\n![](s4key:uploads/1/x.jpg)\n\n![图](s4key:uploads/1/y.png)")
    })

    it("先替换较长的引用，避免短路径误伤", () => {
        const markdown = "![](images/a.jpg) ![](images/a.jpg.thumb.jpg)"
        const result = rewriteImageRefs(markdown, [
            { ref: "images/a.jpg", url: "URL_A" },
            { ref: "images/a.jpg.thumb.jpg", url: "URL_B" },
        ])
        expect(result).toBe("![](URL_A) ![](URL_B)")
    })
})
