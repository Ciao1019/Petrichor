import { describe, expect, it } from "vitest"
import { suggestInboxTitle } from "./inbox-utils"

describe("随笔归档标题", () => {
  it("从富文本正文取标题，排除颜色标记并保留文字中的符号", () => {
    const json = JSON.stringify([{ type: "p", children: [{ text: "彩色", color: "red" }, { text: "随笔 A_B", bold: true }] }])
    expect(suggestInboxTitle('<span style="color:red">彩色</span>**随笔 A_B**', json)).toBe("彩色随笔 A_B")
  })

  it("跳过图片与空段落，支持包装后的编辑器结构", () => {
    const json = JSON.stringify({ value: [{ type: "img", url: "s4key:image", children: [{ text: "" }] }, { type: "p", children: [{ text: "正文标题" }] }] })
    expect(suggestInboxTitle("![图](s4key:image)", json)).toBe("正文标题")
  })

  it("兼容旧 Markdown，按 Unicode 字符限制标题长度", () => {
    expect(suggestInboxTitle("## **旧随笔**", "invalid")).toBe("旧随笔")
    expect(suggestInboxTitle('<span style="color:red">彩色随笔</span>')).toBe("彩色随笔")
    expect(suggestInboxTitle("😀".repeat(81))).toBe("😀".repeat(80))
    expect(suggestInboxTitle("![图](s4key:image)")).toBe("随笔整理")
  })
})
