import { describe, expect, it } from "vitest"
import { HttpError } from "@/server/http/response"
import {
    BURN_MAX_VIEWS_LIMIT,
    parseBurnMaxViews,
    resolveBurnLinkPublicState,
    validateBurnLinkCode,
    validateBurnLinkCreateInput,
    validatePublicBurnConsumeInput,
} from "@/server/kb/burn-link-logic"

describe("parseBurnMaxViews", () => {
    it("空值默认 1（阅后即焚）", () => {
        expect(parseBurnMaxViews(undefined)).toBe(1)
        expect(parseBurnMaxViews(null)).toBe(1)
        expect(parseBurnMaxViews("")).toBe(1)
    })

    it("接受范围内整数", () => {
        expect(parseBurnMaxViews("5")).toBe(5)
        expect(parseBurnMaxViews(3)).toBe(3)
        expect(parseBurnMaxViews(BURN_MAX_VIEWS_LIMIT)).toBe(BURN_MAX_VIEWS_LIMIT)
    })

    it("拒绝非正整数与越界值", () => {
        expect(() => parseBurnMaxViews("0")).toThrow(HttpError)
        expect(() => parseBurnMaxViews("-1")).toThrow(HttpError)
        expect(() => parseBurnMaxViews("1.5")).toThrow(HttpError)
        expect(() => parseBurnMaxViews("abc")).toThrow(HttpError)
        expect(() => parseBurnMaxViews(String(BURN_MAX_VIEWS_LIMIT + 1))).toThrow(HttpError)
    })
})

describe("validateBurnLinkCreateInput", () => {
    it("默认生成 1 次访问、无密码、无过期", () => {
        const input = validateBurnLinkCreateInput({ articleId: "12" })
        expect(input).toEqual({
            articleId: 12,
            maxViews: 1,
            passwordEnabled: false,
            accessPassword: "",
            expiresAt: null,
        })
    })

    it("启用密码但未填写时报错", () => {
        expect(() => validateBurnLinkCreateInput({ articleId: "1", passwordEnabled: true })).toThrow(HttpError)
    })

    it("启用密码并填写 6 位数字", () => {
        const input = validateBurnLinkCreateInput({
            articleId: "1",
            passwordEnabled: true,
            accessPassword: "123456",
            maxViews: "9",
        })
        expect(input.passwordEnabled).toBe(true)
        expect(input.accessPassword).toBe("123456")
        expect(input.maxViews).toBe(9)
    })

    it("未启用密码时忽略已填的密码", () => {
        const input = validateBurnLinkCreateInput({
            articleId: "1",
            passwordEnabled: false,
            accessPassword: "123456",
        })
        expect(input.accessPassword).toBe("")
    })

    it("缺少文章ID报错", () => {
        expect(() => validateBurnLinkCreateInput({})).toThrow(HttpError)
    })
})

describe("validateBurnLinkCode / validatePublicBurnConsumeInput", () => {
    it("接受合法链接码", () => {
        const code = "abcDEF12_-xyz"
        expect(validateBurnLinkCode(code)).toBe(code)
    })

    it("拒绝过短或非法字符的链接码", () => {
        expect(() => validateBurnLinkCode("short")).toThrow(HttpError)
        expect(() => validateBurnLinkCode("has space!!!!")).toThrow(HttpError)
        expect(() => validateBurnLinkCode("")).toThrow(HttpError)
    })

    it("consume 输入兼容 code / linkCode 字段且密码可选", () => {
        expect(validatePublicBurnConsumeInput({ linkCode: "abcDEF1234" })).toEqual({
            code: "abcDEF1234",
            accessPassword: "",
        })
        expect(validatePublicBurnConsumeInput({ code: "abcDEF1234", accessPassword: "123456" })).toEqual({
            code: "abcDEF1234",
            accessPassword: "123456",
        })
    })

    it("consume 密码格式非法时报错", () => {
        expect(() => validatePublicBurnConsumeInput({ code: "abcDEF1234", accessPassword: "12a" })).toThrow(HttpError)
    })
})

describe("resolveBurnLinkPublicState", () => {
    const now = new Date("2026-06-12T00:00:00.000Z")

    it("撤销 / 焚毁优先级最高", () => {
        expect(resolveBurnLinkPublicState({ status: "REVOKED" }, now)).toBe("REVOKED")
        expect(resolveBurnLinkPublicState({ status: "BURNED" }, now)).toBe("BURNED")
    })

    it("过期判定", () => {
        expect(resolveBurnLinkPublicState({ status: "ACTIVE", expiresAt: "2026-06-11T23:59:59.000Z" }, now)).toBe("EXPIRED")
        expect(resolveBurnLinkPublicState({ status: "ACTIVE", expiresAt: "2026-06-12T01:00:00.000Z" }, now)).toBe("ACTIVE")
    })

    it("无过期时间默认可访问", () => {
        expect(resolveBurnLinkPublicState({ status: "ACTIVE" }, now)).toBe("ACTIVE")
        expect(resolveBurnLinkPublicState({ status: "ACTIVE", expiresAt: null }, now)).toBe("ACTIVE")
    })
})
