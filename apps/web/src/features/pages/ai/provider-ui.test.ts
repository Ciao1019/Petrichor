import { describe, expect, it } from "vitest"
import { errorMessage, formatContextWindow } from "./provider-ui"

describe("errorMessage", () => {
    it("优先取服务端返回的 msg，而不是 axios 的通用文案", () => {
        const axiosLikeError = Object.assign(
            new Error("Request failed with status code 400"),
            { response: { data: { code: 400, msg: "请先点「获取模型列表」并选择一个测试用模型" } } },
        )
        expect(errorMessage(axiosLikeError, "兜底")).toBe("请先点「获取模型列表」并选择一个测试用模型")
    })

    it("服务端消息为空白时退回 axios 文案", () => {
        const error = Object.assign(
            new Error("Request failed with status code 500"),
            { response: { data: { msg: "   " } } },
        )
        expect(errorMessage(error, "兜底")).toBe("Request failed with status code 500")
    })

    it("没有 response 时用 Error.message", () => {
        expect(errorMessage(new Error("Network Error"), "兜底")).toBe("Network Error")
    })

    it("完全拿不到信息时用兜底文案", () => {
        expect(errorMessage(null, "保存失败")).toBe("保存失败")
        expect(errorMessage({}, "保存失败")).toBe("保存失败")
        expect(errorMessage(new Error(""), "保存失败")).toBe("保存失败")
    })
})

describe("formatContextWindow", () => {
    it("按量级压缩显示", () => {
        expect(formatContextWindow(1_000_000)).toBe("1M")
        expect(formatContextWindow(2_000_000)).toBe("2M")
        expect(formatContextWindow(1_047_576)).toBe("1.0M")
        expect(formatContextWindow(200_000)).toBe("200K")
        expect(formatContextWindow(16_385)).toBe("16K")
        expect(formatContextWindow(512)).toBe("512")
    })

    it("空值和非正数显示为占位符", () => {
        expect(formatContextWindow(null)).toBe("-")
        expect(formatContextWindow(undefined)).toBe("-")
        expect(formatContextWindow(0)).toBe("-")
        expect(formatContextWindow(-1)).toBe("-")
    })
})
