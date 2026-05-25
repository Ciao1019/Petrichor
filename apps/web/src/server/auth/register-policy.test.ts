import { describe, expect, it } from "vitest"
import { resolveRegisterDefaultSystemRole } from "./register-policy"

describe("register policy", () => {
    it("默认注册用户角色为普通用户", () => {
        expect(resolveRegisterDefaultSystemRole({})).toBe("USER")
    })

    it("允许通过环境变量把注册用户角色设置为超级管理员", () => {
        expect(resolveRegisterDefaultSystemRole({
            PETRICHOR_REGISTER_DEFAULT_SYSTEM_ROLE: "SUPER_ADMIN",
        })).toBe("SUPER_ADMIN")
    })

    it("兼容环境变量大小写和首尾空格", () => {
        expect(resolveRegisterDefaultSystemRole({
            PETRICHOR_REGISTER_DEFAULT_SYSTEM_ROLE: " user ",
        })).toBe("USER")
    })

    it("非法注册角色配置会失败，避免误放权", () => {
        expect(() => resolveRegisterDefaultSystemRole({
            PETRICHOR_REGISTER_DEFAULT_SYSTEM_ROLE: "ADMIN",
        })).toThrow("PETRICHOR_REGISTER_DEFAULT_SYSTEM_ROLE")
    })
})
