import { describe, expect, it } from "vitest"
import { ASSISTANT_SKILL_NAMES, resolveAssistantSkills } from "./index"

describe("resolveAssistantSkills", () => {
    it("按域过滤并去重", () => {
        const skills = resolveAssistantSkills(["knowledge", "content_write", "admin", "system"])
        const names = skills.map((skill) => skill.name)
        expect(names).toEqual([
            ASSISTANT_SKILL_NAMES.knowledgeQa,
            ASSISTANT_SKILL_NAMES.articleWrite,
            ASSISTANT_SKILL_NAMES.adminOps,
        ])
    })

    it("仅 system 时不挂业务 skill", () => {
        expect(resolveAssistantSkills(["system"])).toEqual([])
    })

    it("doc_library 挂文档问答 skill", () => {
        const names = resolveAssistantSkills(["doc_library", "system"]).map((skill) => skill.name)
        expect(names).toEqual([ASSISTANT_SKILL_NAMES.docLibraryQa])
    })

    it("每个 skill 含可执行 instructions", () => {
        for (const skill of resolveAssistantSkills(["knowledge", "doc_library", "content_write", "admin"])) {
            expect(skill.instructions.length).toBeGreaterThan(40)
            expect(skill.description.toLowerCase()).toContain("use")
        }
    })
})
