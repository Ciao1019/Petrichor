import { describe, expect, it } from "vitest"
import {
    isPdfFileName,
    removeDocumentImportFileExtension,
    resolveDocumentImportKind,
    validateDocumentImportFile,
    DOCUMENT_IMPORT_MAX_FILE_BYTES,
} from "./article-editor-utils"

describe("document import file helpers", () => {
    it("只识别 pdf 文件类型", () => {
        expect(isPdfFileName("report.PDF")).toBe(true)
        expect(resolveDocumentImportKind("a.pdf")).toBe("pdf")
        expect(resolveDocumentImportKind("a.docx")).toBeNull()
        expect(resolveDocumentImportKind("a.txt")).toBeNull()
    })

    it("校验文件类型与大小", () => {
        expect(validateDocumentImportFile({ name: "a.txt", size: 100 })).toMatch(/pdf/)
        expect(validateDocumentImportFile({ name: "a.pdf", size: 0 })).toMatch(/为空/)
        expect(validateDocumentImportFile({ name: "a.pdf", size: DOCUMENT_IMPORT_MAX_FILE_BYTES + 1 })).toMatch(/过大/)
        expect(validateDocumentImportFile({ name: "a.pdf", size: 1024 })).toBeNull()
    })

    it("去除文档扩展名", () => {
        expect(removeDocumentImportFileExtension("/path/年度报告.pdf")).toBe("年度报告")
        expect(removeDocumentImportFileExtension("notes.docx")).toBe("notes.docx")
    })
})
