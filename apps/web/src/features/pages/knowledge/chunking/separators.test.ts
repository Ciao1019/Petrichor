import { describe, expect, it } from "vitest"

import { addSeparator, escapeSeparator, removeSeparator, separatorLabel, unescapeSeparator } from "./separators"

describe("separatorLabel", () => {
    it("常用分隔符显示中文名", () => {
        expect(separatorLabel("\n\n")).toBe("双换行 (\\n\\n)")
        expect(separatorLabel("。")).toBe("中文句号 (。)")
    })

    it("自定义分隔符回退到转义字面量", () => {
        expect(separatorLabel("§")).toBe("「§」")
        expect(separatorLabel("\r")).toBe("「\\r」")
    })
})

describe("escapeSeparator / unescapeSeparator", () => {
    it("转义与还原互为逆运算", () => {
        for (const value of ["\n\n", "\t", "。", "a\\b", "\r\n"]) {
            expect(unescapeSeparator(escapeSeparator(value))).toBe(value)
        }
    })
})

describe("addSeparator", () => {
    it("接受转义写法并还原成真实字符", () => {
        expect(addSeparator([], "\\n\\n")).toEqual(["\n\n"])
    })

    it("忽略空白输入", () => {
        const current = ["\n"]
        expect(addSeparator(current, "   ")).toBe(current)
    })

    it("已存在时不重复追加", () => {
        const current = ["\n"]
        expect(addSeparator(current, "\\n")).toBe(current)
    })
})

describe("removeSeparator", () => {
    it("按值移除", () => {
        expect(removeSeparator(["\n\n", "\n"], "\n\n")).toEqual(["\n"])
    })
})
