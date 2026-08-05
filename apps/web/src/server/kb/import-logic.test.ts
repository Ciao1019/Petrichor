import { describe, expect, it } from "vitest"
import {
    countProcessedPages,
    deriveJobStatus,
    mergePageMarkdown,
    parseImportSourceType,
    type ImportPageStatus,
} from "./import-logic"

describe("document import logic", () => {
    it("解析受支持的来源类型", () => {
        expect(parseImportSourceType("pdf")).toBe("pdf")
        expect(parseImportSourceType("PDF")).toBe("pdf")
        expect(parseImportSourceType("docx")).toBeNull()
        expect(parseImportSourceType("doc")).toBeNull()
        expect(parseImportSourceType(undefined)).toBeNull()
    })

    it("按页码顺序合并并跳过空白页", () => {
        const merged = mergePageMarkdown([
            { pageNo: 3, markdown: "# 第三页" },
            { pageNo: 1, markdown: "# 第一页" },
            { pageNo: 2, markdown: "   " },
            { pageNo: 4, markdown: null },
        ])
        expect(merged).toBe("# 第一页\n\n# 第三页")
    })

    it("根据页状态推导任务整体状态", () => {
        const pending: ImportPageStatus[] = ["done", "pending", "failed"]
        expect(deriveJobStatus(pending)).toBe("processing")
        expect(deriveJobStatus(["done", "failed"])).toBe("failed")
        expect(deriveJobStatus(["done", "done"])).toBe("completed")
        expect(deriveJobStatus([])).toBe("pending")
    })

    it("统计已处理页数（done + failed 都算已处理）", () => {
        expect(countProcessedPages(["done", "failed", "pending"])).toBe(2)
        expect(countProcessedPages(["pending", "pending"])).toBe(0)
    })
})
