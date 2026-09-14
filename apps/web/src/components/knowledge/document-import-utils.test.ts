import { describe, expect, it } from "vitest"
import {
  DOCUMENT_IMPORT_ACCEPT,
  DOCUMENT_IMPORT_DESCRIPTION,
  DOCUMENT_IMPORT_EXTENSIONS,
  DOCUMENT_IMPORT_FORMAT_DESCRIPTION,
  DOCUMENT_IMPORT_MAX_FILE_BYTES,
  DOCUMENT_IMPORT_MAX_PAGES,
  isPdfFileName,
  removeDocumentImportFileExtension,
  resolveDocumentImportKind,
  validateDocumentImportFile,
} from "./article-editor-utils"

const extensions = [
  "doc", "docx", "docm", "ppt", "pps", "pot", "pptx", "pptm", "ppsx", "ppsm",
  "xls", "xlsx", "xlsm", "xlsb", "odt", "ods", "odp", "rtf", "epub", "csv", "pdf",
  "md", "markdown",
]

describe("document import file helpers", () => {
  it("选择器、说明和白名单保持完整一致", () => {
    expect(DOCUMENT_IMPORT_EXTENSIONS).toEqual(extensions)
    expect(DOCUMENT_IMPORT_ACCEPT.split(",")).toEqual(extensions.map((ext) => `.${ext}`))
    for (const ext of extensions) expect(DOCUMENT_IMPORT_FORMAT_DESCRIPTION).toContain(`.${ext}`)
    expect(DOCUMENT_IMPORT_DESCRIPTION).toContain("100 MB")
    expect(DOCUMENT_IMPORT_DESCRIPTION).toContain(`${DOCUMENT_IMPORT_MAX_PAGES} 页`)
    expect(DOCUMENT_IMPORT_DESCRIPTION).toContain("Go 服务端")
    expect(DOCUMENT_IMPORT_DESCRIPTION).toContain("可关闭页面")
    expect(DOCUMENT_IMPORT_DESCRIPTION).not.toContain("浏览器本地解析")
  })

  it.each(extensions)("识别并校验 %s，来源类型保留原扩展名", (extension) => {
    expect(resolveDocumentImportKind(`a.${extension}`)).toBe(extension)
    expect(resolveDocumentImportKind(`C:\\dir\\年度报告.${extension.toUpperCase()}  `)).toBe(extension)
    expect(validateDocumentImportFile({ name: `a.${extension}`, size: 1024 })).toBeNull()
    expect(removeDocumentImportFileExtension(`/path/年度报告.${extension.toUpperCase()}  `)).toBe("年度报告")
  })

  it.each(["a.txt", "a.html", "a.zip", "a.doc.exe", "pdf", "md", "a.pdf/README", "a.pdf."])(
    "拒绝不支持的文件名 %s", (fileName) => {
      expect(resolveDocumentImportKind(fileName)).toBeNull()
      expect(validateDocumentImportFile({ name: fileName, size: 100 })).toContain(DOCUMENT_IMPORT_FORMAT_DESCRIPTION)
    },
  )

  it("保留 PDF 判定与未知扩展名的语义", () => {
    expect(isPdfFileName("report.PDF")).toBe(true)
    expect(isPdfFileName("report.docx")).toBe(false)
    expect(removeDocumentImportFileExtension("notes.txt")).toBe("notes.txt")
    expect(removeDocumentImportFileExtension("C:\\path\\年度.报告.docm")).toBe("年度.报告")
  })

  it("校验空文件、非法大小和 100 MB 边界", () => {
    expect(validateDocumentImportFile({ name: "a.pdf", size: 0 })).toMatch(/为空/)
    expect(validateDocumentImportFile({ name: "a.pdf", size: -1 })).toMatch(/无效/)
    expect(validateDocumentImportFile({ name: "a.csv", size: NaN })).toMatch(/无效/)
    expect(validateDocumentImportFile({ name: "a.pdf", size: DOCUMENT_IMPORT_MAX_FILE_BYTES + 1 })).toMatch(/过大/)
    expect(validateDocumentImportFile({ name: "a.docx", size: DOCUMENT_IMPORT_MAX_FILE_BYTES })).toBeNull()
  })
})
