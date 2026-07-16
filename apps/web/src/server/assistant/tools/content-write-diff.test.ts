import { describe, expect, it } from "vitest"
import { buildUnifiedDiff } from "./content-write"

describe("buildUnifiedDiff", () => {
    it("输出标题与增删行", () => {
        const diff = buildUnifiedDiff("a\nb\nc", "a\nB\nc", "content.md")
        expect(diff).toContain("--- a/content.md")
        expect(diff).toContain("+++ b/content.md")
        expect(diff).toContain("-b")
        expect(diff).toContain("+B")
    })
})
