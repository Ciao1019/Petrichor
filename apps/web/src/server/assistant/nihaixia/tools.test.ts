import { describe, expect, it } from "vitest"
import { buildNihaixiaSystemPrompt, buildNihaixiaTools, isNihaixiaFocus, NIHAIXIA_TOOL_NAMES } from "./index"

type ToolExec = (input: unknown, context?: unknown) => Promise<unknown>

describe("isNihaixiaFocus", () => {
    it("仅在 persona=nihaixia 时为真", () => {
        expect(isNihaixiaFocus({ persona: "nihaixia" })).toBe(true)
        expect(isNihaixiaFocus({ knowledgeBaseId: "1" })).toBe(false)
        expect(isNihaixiaFocus({ persona: null })).toBe(false)
        expect(isNihaixiaFocus(null)).toBe(false)
        expect(isNihaixiaFocus(undefined)).toBe(false)
    })
})

describe("buildNihaixiaTools", () => {
    it("装配 grep/read 两个工具，名称与常量一致", () => {
        const tools = buildNihaixiaTools()
        expect(Object.keys(tools).sort()).toEqual([...NIHAIXIA_TOOL_NAMES].sort())
    })

    it("nihaixia_grep 走 schema 解析并命中原文", async () => {
        const tools = buildNihaixiaTools()
        const exec = tools.nihaixia_grep!.execute as unknown as ToolExec
        const out = (await exec({ query: "桂枝汤" })) as { ok: boolean; matches: Array<{ line: number }> }
        expect(out.ok).toBe(true)
        expect(out.matches.length).toBeGreaterThan(0)
        expect(out.matches[0]!.line).toBeGreaterThan(0)
    })

    it("nihaixia_read 返回带行号原文", async () => {
        const tools = buildNihaixiaTools()
        const exec = tools.nihaixia_read!.execute as unknown as ToolExec
        const out = (await exec({ file: "SKILL.md", offset: 1, limit: 2 })) as { ok: boolean; content: string }
        expect(out.ok).toBe(true)
        expect(out.content.split("\n")[0]).toMatch(/^1\t/)
    })

    it("非法文件被工具层拒绝", async () => {
        const tools = buildNihaixiaTools()
        const exec = tools.nihaixia_read!.execute as unknown as ToolExec
        await expect(exec({ file: "../../etc/passwd" })).rejects.toThrow()
    })
})

describe("buildNihaixiaSystemPrompt", () => {
    it("含人格、检索协议与安全边界", () => {
        const prompt = buildNihaixiaSystemPrompt()
        expect(prompt).toContain("倪海厦")
        expect(prompt).toContain("nihaixia_grep")
        expect(prompt).toContain("脱离站内业务")
        expect(prompt).toMatch(/禁止.*编造|编造/)
        expect(prompt).toMatch(/学习与研究|中医师/)
    })
})
