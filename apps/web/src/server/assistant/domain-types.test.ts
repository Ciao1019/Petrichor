import { describe, expect, it } from "vitest"
import {
    ASSISTANT_MAX_STEPS_READ,
    ASSISTANT_MAX_STEPS_WRITE,
    CORE_SESSION_DOMAINS,
    resolveAssistantMaxSteps,
    resolveToolLoadDomains,
} from "./domain-types"

describe("resolveToolLoadDomains", () => {
    it("无论意图如何都常驻核心域（含 content_write）", () => {
        for (const intent of [
            ["system"],
            ["knowledge", "system"],
            ["system", "knowledge", "doc_library"],
            ["content_write"],
        ] as const) {
            const loaded = resolveToolLoadDomains([...intent])
            for (const domain of CORE_SESSION_DOMAINS) {
                expect(loaded).toContain(domain)
            }
            expect(loaded).not.toContain("admin")
        }
    })

    it("仅在意图含 admin 时追加 admin", () => {
        expect(resolveToolLoadDomains(["knowledge", "system"])).not.toContain("admin")
        const withAdmin = resolveToolLoadDomains(["admin"])
        expect(withAdmin).toEqual(expect.arrayContaining([
            ...CORE_SESSION_DOMAINS,
            "admin",
        ]))
    })
})

describe("resolveAssistantMaxSteps", () => {
    it("纯读意图用 12，含写或 admin 用 20", () => {
        expect(resolveAssistantMaxSteps(["system", "knowledge"])).toBe(ASSISTANT_MAX_STEPS_READ)
        expect(resolveAssistantMaxSteps(["content_write", "knowledge"])).toBe(ASSISTANT_MAX_STEPS_WRITE)
        expect(resolveAssistantMaxSteps(["admin"])).toBe(ASSISTANT_MAX_STEPS_WRITE)
    })
})
