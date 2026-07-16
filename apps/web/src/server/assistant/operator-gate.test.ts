import { describe, expect, it } from "vitest"
import { assertAssistantOperator, isAssistantOperator } from "./operator-gate"
import { HttpError } from "@/server/http/response"

describe("isAssistantOperator", () => {
    it("SUPER_ADMIN 为 true", () => {
        expect(isAssistantOperator({ id: 5, systemRole: "SUPER_ADMIN" })).toBe(true)
    })

    it("普通 USER 为 false", () => {
        expect(isAssistantOperator({ id: 1, systemRole: "USER" })).toBe(false)
    })

    it("role 空且 id=1 时与 isSuperAdmin 一致为 true", () => {
        expect(isAssistantOperator({ id: 1, systemRole: null })).toBe(true)
        expect(isAssistantOperator({ id: 1, systemRole: "" })).toBe(true)
    })

    it("role 空且非 1 为 false", () => {
        expect(isAssistantOperator({ id: 2, systemRole: null })).toBe(false)
    })
})

describe("assertAssistantOperator", () => {
    it("非操作员抛 403 assistant_operator_only", () => {
        expect(() => assertAssistantOperator({ id: 2, systemRole: "USER" })).toThrow(HttpError)
        try {
            assertAssistantOperator({ id: 2, systemRole: "USER" })
        } catch (error) {
            expect(error).toBeInstanceOf(HttpError)
            expect((error as HttpError).status).toBe(403)
            expect((error as HttpError).message).toBe("assistant_operator_only")
        }
    })
})
