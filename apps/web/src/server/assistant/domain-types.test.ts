import { describe, expect, it } from "vitest"
import { CORE_SESSION_DOMAINS, resolveToolLoadDomains } from "./domain-types"

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
