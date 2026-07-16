import { describe, expect, it } from "vitest"
import {
    ASSISTANT_SKILL_NAMES,
    getAssistantSkillBody,
    listAssistantSkillCatalog,
    resolveAssistantSkills,
} from "./index"

describe("assistant skills progressive disclosure", () => {
    it("resolveAssistantSkills 不再注入全文（目录进 system，正文 load_skill）", () => {
        expect(resolveAssistantSkills(["knowledge", "content_write", "admin", "system"])).toEqual([])
        expect(resolveAssistantSkills(["system"])).toEqual([])
    })

    it("目录按域过滤", () => {
        const names = listAssistantSkillCatalog(["knowledge", "content_write", "admin"]).map((s) => s.name)
        expect(names).toEqual([
            ASSISTANT_SKILL_NAMES.knowledgeQa,
            ASSISTANT_SKILL_NAMES.articleWrite,
            ASSISTANT_SKILL_NAMES.adminOps,
        ])
        expect(listAssistantSkillCatalog(["doc_library"]).map((s) => s.name)).toEqual([
            ASSISTANT_SKILL_NAMES.docLibraryQa,
        ])
    })

    it("getAssistantSkillBody 返回可执行 playbook", () => {
        const knowledge = getAssistantSkillBody(ASSISTANT_SKILL_NAMES.knowledgeQa)
        expect(knowledge?.instructions).toContain("list_knowledge_bases")
        expect(knowledge?.instructions).toContain("不要对每个库调用 search_knowledge")
        expect(knowledge?.instructions).toContain("不传 knowledgeBaseId")

        const article = getAssistantSkillBody(ASSISTANT_SKILL_NAMES.articleWrite)
        expect(article?.instructions.length).toBeGreaterThan(40)
        expect(article?.instructions).toContain("move_article")
        expect(getAssistantSkillBody("nope")).toBeNull()
    })
})
