import { beforeEach, describe, expect, it } from "vitest"
import {
    __resetSkillFilesCacheForTests,
    grepSkill,
    isAllowedSkillFile,
    listSkillFiles,
    readSkill,
    resolveSkillBaseDir,
} from "./skill-files"

beforeEach(() => {
    __resetSkillFilesCacheForTests()
})

describe("resolveSkillBaseDir / listSkillFiles", () => {
    it("能解析到 vendored 技能目录并列出核心文件", () => {
        expect(() => resolveSkillBaseDir()).not.toThrow()
        const files = listSkillFiles()
        expect(files).toContain("SKILL.md")
        expect(files.some((f) => f.startsWith("modules/"))).toBe(true)
        expect(files.some((f) => f.startsWith("cases/"))).toBe(true)
    })
})

describe("isAllowedSkillFile", () => {
    it("放行白名单内文件", () => {
        expect(isAllowedSkillFile("SKILL.md")).toBe(true)
        expect(isAllowedSkillFile("modules/04_jingui.md")).toBe(true)
        expect(isAllowedSkillFile("cases/01_cancer.md")).toBe(true)
    })
    it("拒绝穿越与非法路径", () => {
        expect(isAllowedSkillFile("../../secret.md")).toBe(false)
        expect(isAllowedSkillFile("modules/../../etc/passwd")).toBe(false)
        expect(isAllowedSkillFile("SKILL.txt")).toBe(false)
        expect(isAllowedSkillFile("modules/evil.ts")).toBe(false)
    })
})

describe("grepSkill", () => {
    it("默认只搜 SKILL.md 并返回带行号的命中", () => {
        const res = grepSkill({ query: "桂枝汤" })
        expect(res.searchedFiles).toEqual(["SKILL.md"])
        expect(res.matches.length).toBeGreaterThan(0)
        const first = res.matches[0]!
        expect(first.file).toBe("SKILL.md")
        expect(first.line).toBeGreaterThan(0)
        expect(first.text).toContain("桂枝汤")
    })

    it("命中的行号能被 readSkill 定位回原文", () => {
        const res = grepSkill({ query: "桂枝汤" })
        const hit = res.matches[0]!
        const read = readSkill({ file: hit.file, offset: hit.line, limit: 1 })
        expect(read.content).toContain(`${hit.line}\t`)
        expect(read.content).toContain("桂枝汤")
    })

    it("指定 file 时深搜对应模块", () => {
        const res = grepSkill({ query: "妇人", file: "modules/04_jingui.md" })
        expect(res.searchedFiles).toEqual(["modules/04_jingui.md"])
        expect(res.matches.every((m) => m.file === "modules/04_jingui.md")).toBe(true)
    })

    it("空查询返回空结果", () => {
        expect(grepSkill({ query: "   " }).matches).toEqual([])
    })

    it("非法文件抛错", () => {
        expect(() => grepSkill({ query: "x", file: "../../etc/passwd" })).toThrow()
    })
})

describe("readSkill", () => {
    it("返回带行号前缀、offset/limit 生效", () => {
        const res = readSkill({ file: "SKILL.md", offset: 2, limit: 3 })
        expect(res.offset).toBe(2)
        expect(res.returnedLines).toBeLessThanOrEqual(3)
        expect(res.content.split("\n")[0]).toMatch(/^2\t/)
        expect(res.totalLines).toBeGreaterThan(100)
        expect(res.hasMore).toBe(true)
    })

    it("limit 被上限约束、超范围 offset 安全", () => {
        const res = readSkill({ file: "SKILL.md", offset: 10_000_000, limit: 5 })
        expect(res.returnedLines).toBe(0)
        expect(res.hasMore).toBe(false)
    })

    it("非法文件抛错", () => {
        expect(() => readSkill({ file: "modules/../../secret.md" })).toThrow()
    })
})
