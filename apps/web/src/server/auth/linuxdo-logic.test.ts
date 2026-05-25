import { describe, expect, it } from "vitest"
import { normalizeLinuxDoUserInfo, shouldUpgradeToLinuxDoUserType, validateLinuxDoCallbackInput } from "./linuxdo-logic"

describe("linuxdo auth logic", () => {
    it("校验授权码", () => {
        expect(validateLinuxDoCallbackInput({ code: " abc ", state: " bind " })).toEqual({ code: "abc", state: "bind" })
        expect(() => validateLinuxDoCallbackInput({ code: " " })).toThrow("授权码不能为空")
    })

    it("按 Go 逻辑补齐 LinuxDo 用户信息", () => {
        expect(normalizeLinuxDoUserInfo({
            id: 123,
            username: "neo",
            name: "",
            avatar_url: "https://example.com/a.png",
        })).toEqual({
            accountId: "123",
            email: "neo@linux.do",
            username: "neo",
            nickname: "neo",
            avatar: "https://example.com/a.png",
        })
        expect(normalizeLinuxDoUserInfo({})).toMatchObject({
            accountId: "null@linux.do",
            email: "null@linux.do",
            username: null,
            nickname: null,
            avatar: null,
        })
    })

    it("只升级无本地密码的历史用户类型", () => {
        expect(shouldUpgradeToLinuxDoUserType("LOCAL", "hash")).toBe(false)
        expect(shouldUpgradeToLinuxDoUserType("LOCAL", "")).toBe(true)
        expect(shouldUpgradeToLinuxDoUserType("", "")).toBe(true)
    })
})
