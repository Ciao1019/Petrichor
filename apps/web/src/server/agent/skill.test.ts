import { describe, expect, it } from "vitest"
import {
    buildAgentManifest,
    buildAgentSkillMarkdown,
    buildAgentSkillPackageFiles,
    buildAgentSkillPackageZip,
} from "./skill"

describe("Agent Skill 文件", () => {
    it("输出可安装的 SKILL.md 内容", () => {
        const markdown = buildAgentSkillMarkdown("https://petrichor.example.com/")

        expect(markdown).toContain("name: petrichor-agent")
        expect(markdown).toContain("PETRICHOR_API_KEY")
        expect(markdown).toContain("PETRICHOR_AGENT_SOURCE")
        expect(markdown).toContain("https://petrichor.example.com")
        expect(markdown).toContain("/api/agent/article/create")
        expect(markdown).toContain("/api/agent/document/qa")
        expect(markdown).toContain("删除文章前必须")
    })

    it("输出多 Skill 文件夹包内容", () => {
        const files = buildAgentSkillPackageFiles("https://petrichor.example.com/")

        expect(files.map((file) => file.path)).toEqual(expect.arrayContaining([
            "petrichor-setup/SKILL.md",
            "petrichor-articles/SKILL.md",
            "petrichor-docs/SKILL.md",
            "petrichor-qa/SKILL.md",
            "petrichor-share/SKILL.md",
            "petrichor-ai/SKILL.md",
            "petrichor-articles/scripts/petrichor",
            "petrichor-articles/scripts/petrichor-api.sh",
            "petrichor-docs/references/endpoints.md",
        ]))
        expect(files.find((file) => file.path === "petrichor-articles/SKILL.md")?.content)
            .toContain("petrichor article update")
        expect(files.find((file) => file.path === "petrichor-articles/SKILL.md")?.content)
            .toContain("petrichor article move")
        expect(files.find((file) => file.path === "petrichor-share/SKILL.md")?.content)
            .toContain("share create")
        expect(files.find((file) => file.path === "petrichor-setup/scripts/petrichor-api.sh")?.content)
            .toContain("X-Petrichor-Agent-Source")
        expect(files.find((file) => file.path === "petrichor-setup/scripts/petrichor")?.content)
            .toContain("#!/usr/bin/env python3")
        expect(files.find((file) => file.path === "petrichor-docs/references/endpoints.md")?.content)
            .toContain("/api/agent/article/list")
    })

    it("输出 ZIP 文件", () => {
        const zip = buildAgentSkillPackageZip("https://petrichor.example.com/")

        expect(zip.subarray(0, 2).toString("utf8")).toBe("PK")
        expect(zip.toString("utf8")).toContain("petrichor-qa/SKILL.md")
    })

    it("输出 manifest endpoint map", () => {
        const manifest = buildAgentManifest("https://petrichor.example.com/")

        expect(manifest.baseUrl).toBe("https://petrichor.example.com")
        expect(manifest.endpoints.articleUpdate).toBe("/api/agent/article/update")
        expect(manifest.endpoints.articleList).toBe("/api/agent/article/list")
        expect(manifest.endpoints.articleMove).toBe("/api/agent/article/move")
        expect(manifest.endpoints.articleShareCreate).toBe("/api/agent/article/share/create")
        expect(manifest.endpoints.articleSummaryGenerate).toBe("/api/agent/article/summary/generate")
        expect(manifest.endpoints.skillPack).toBe("/api/agent/skill-pack")
        expect(manifest.requiredHeaders["X-Petrichor-Agent-Source"]).toContain("调用方")
    })
})
