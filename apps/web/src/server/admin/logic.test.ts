import { describe, expect, it } from "vitest"
import {
    buildAdminUserItem,
    normalizeSystemRole,
    resolveAdminUserOrder,
    validateAdminCreateInput,
    validateAdminDeleteInput,
} from "./logic"

describe("admin user logic", () => {
    it("按 Go 逻辑兼容历史 1 号超级管理员", () => {
        expect(normalizeSystemRole("", 1)).toBe("SUPER_ADMIN")
        expect(normalizeSystemRole("  ", 2)).toBe("USER")
        expect(normalizeSystemRole(" SUPER_ADMIN ", 9)).toBe("SUPER_ADMIN")
    })

    it("校验创建用户请求并保留 trim 后字段", () => {
        const input = validateAdminCreateInput({
            email: " admin@example.com ",
            name: " 管理员 ",
            password: "123456",
            systemRole: "SUPER_ADMIN",
        })

        expect(input).toEqual({
            email: "admin@example.com",
            name: "管理员",
            password: "123456",
            systemRole: "SUPER_ADMIN",
        })
    })

    it("复用注册校验语义", () => {
        expect(() => validateAdminCreateInput({
            email: "bad-email",
            name: "管理员",
            password: "123456",
        })).toThrow("不是一个合法的电子邮件地址")

        expect(() => validateAdminCreateInput({
            email: "admin@example.com",
            name: "管理员",
            password: "123",
        })).toThrow("个数必须在6和50之间")

        expect(() => validateAdminCreateInput({
            email: "admin@example.com",
            name: "管理员",
            password: "123456",
            systemRole: "ADMIN",
        })).toThrow("systemRole 非法")
    })

    it("校验删除用户请求中的数字 ID", () => {
        expect(validateAdminDeleteInput({ userId: " 42 " })).toEqual({ userId: 42 })
        expect(() => validateAdminDeleteInput({ userId: "abc" })).toThrow("用户ID非法")
    })

    it("构造 Go 兼容的管理员用户响应", () => {
        const item = buildAdminUserItem({
            authUserId: null,
            avatar: null,
            createdAt: new Date("2026-04-27T00:00:00.000Z"),
            email: "admin@example.com",
            id: 1,
            linuxDoAccountId: null,
            linuxDoEmail: null,
            linuxDoUsername: null,
            nickname: "Admin",
            passwordHash: "",
            signature: null,
            systemRole: "",
            updatedAt: new Date("2026-04-27T01:00:00.000Z"),
            userType: "",
            username: "admin",
        })

        expect(item).toEqual({
            avatar: null,
            createdAt: "2026-04-27T00:00:00.000Z",
            email: "admin@example.com",
            id: "1",
            nickname: "Admin",
            signature: null,
            systemRole: "SUPER_ADMIN",
            updatedAt: "2026-04-27T01:00:00.000Z",
            userType: "LINUXDO",
            username: "admin",
        })
    })

    it("按 QueryBuilder 规则解析排序字段", () => {
        expect(resolveAdminUserOrder({})).toEqual([
            { column: "updatedAt", direction: "desc" },
            { column: "id", direction: "desc" },
        ])

        expect(resolveAdminUserOrder({
            isAsc: "ascending,descending",
            orderByColumn: "createdAt,id",
        })).toEqual([
            { column: "createdAt", direction: "asc" },
            { column: "id", direction: "desc" },
        ])

        expect(() => resolveAdminUserOrder({
            isAsc: "asc",
            orderByColumn: "created_at;drop",
        })).toThrow("排序参数有误")
    })
})
