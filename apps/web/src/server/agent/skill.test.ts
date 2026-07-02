import { describe, expect, it } from "vitest"
import {
    buildAgentManifest,
    buildAgentSkillMarkdown,
    buildAgentSkillPackageFiles,
    buildAgentSkillPackageZip,
} from "./skill"

describe("Agent Skill 文件", () => {
    it("输出可安装的单文件 SKILL.md", () => {
        const markdown = buildAgentSkillMarkdown("https://petrichor.example.com/")

        expect(markdown).toContain("name: petrichor")
        expect(markdown).toContain("PETRICHOR_API_KEY")
        expect(markdown).not.toContain("PETRICHOR_AGENT_SOURCE")
        expect(markdown).not.toContain("X-Petrichor-Agent-Source")
        expect(markdown).toContain("https://petrichor.example.com")
        expect(markdown).toContain("/api/agent/article/create")
        expect(markdown).toContain("/api/agent/document/qa")
        expect(markdown).toContain("删除文章前必须")
    })

    it("打成单 skill + 子文档结构", () => {
        const files = buildAgentSkillPackageFiles("https://petrichor.example.com/")
        const paths = files.map((file) => file.path)

        expect(paths).toEqual(expect.arrayContaining([
            "petrichor/SKILL.md",
            "petrichor/config.json",
            "petrichor/skills/setup.md",
            "petrichor/skills/articles.md",
            "petrichor/skills/docs.md",
            "petrichor/skills/qa.md",
            "petrichor/skills/share.md",
            "petrichor/skills/ai.md",
            "petrichor/skills/wiki.md",
            "petrichor/scripts/petrichor",
            "petrichor/scripts/petrichor-api.sh",
            "petrichor/references/endpoints.md",
            "petrichor/assets/manifest.json",
        ]))

        // 路径只出现一次：scripts、references、manifest 不再被 6 个子 skill 各复制一份
        expect(paths.filter((path) => path === "petrichor/scripts/petrichor")).toHaveLength(1)
        expect(paths.filter((path) => path === "petrichor/references/endpoints.md")).toHaveLength(1)
        expect(paths.filter((path) => path.endsWith("/SKILL.md"))).toHaveLength(1)

        // 不再生成旧的并列子 skill 目录
        expect(paths.some((path) => path.startsWith("petrichor-setup/"))).toBe(false)
        expect(paths.some((path) => path.startsWith("petrichor-articles/"))).toBe(false)
        expect(paths.some((path) => path.startsWith("petrichor-docs/"))).toBe(false)
        expect(paths.some((path) => path.startsWith("petrichor-qa/"))).toBe(false)
        expect(paths.some((path) => path.startsWith("petrichor-share/"))).toBe(false)
        expect(paths.some((path) => path.startsWith("petrichor-ai/"))).toBe(false)

        const rootSkill = files.find((file) => file.path === "petrichor/SKILL.md")?.content ?? ""
        expect(rootSkill).toContain("name: petrichor")
        // 路由表必须列出所有子文档
        expect(rootSkill).toContain("Read skills/setup.md")
        expect(rootSkill).toContain("Read skills/articles.md")
        expect(rootSkill).toContain("Read skills/docs.md")
        expect(rootSkill).toContain("Read skills/qa.md")
        expect(rootSkill).toContain("Read skills/share.md")
        expect(rootSkill).toContain("Read skills/ai.md")
        expect(rootSkill).toContain("Read skills/wiki.md")
        expect(rootSkill).toContain("config.json")

        expect(files.find((file) => file.path === "petrichor/config.json")?.content)
            .toContain('"baseUrl": "https://petrichor.example.com"')
        expect(files.find((file) => file.path === "petrichor/config.json")?.content)
            .toContain('"apiKey": "ptc_live_xxx"')

        expect(files.find((file) => file.path === "petrichor/skills/articles.md")?.content)
            .toContain("petrichor article update")
        expect(files.find((file) => file.path === "petrichor/skills/articles.md")?.content)
            .toContain("petrichor article move")
        expect(files.find((file) => file.path === "petrichor/skills/share.md")?.content)
            .toContain("share create")
        expect(files.find((file) => file.path === "petrichor/scripts/petrichor-api.sh")?.content)
            .toContain("config.json")
        expect(files.find((file) => file.path === "petrichor/scripts/petrichor-api.sh")?.content)
            .toContain("Authorization: Bearer $api_key")
        expect(files.find((file) => file.path === "petrichor/scripts/petrichor-api.sh")?.content)
            .not.toContain("X-Petrichor-Agent-Source")
        expect(files.find((file) => file.path === "petrichor/scripts/petrichor")?.content)
            .toContain("#!/usr/bin/env python3")
        expect(files.find((file) => file.path === "petrichor/scripts/petrichor")?.content)
            .toContain("_setting(\"baseUrl\"")
        expect(files.find((file) => file.path === "petrichor/references/endpoints.md")?.content)
            .toContain("/api/agent/article/list")
        expect(files.find((file) => file.path === "petrichor/references/endpoints.md")?.content)
            .toContain("/api/agent/wiki/ingest")
        expect(files.find((file) => file.path === "petrichor/skills/wiki.md")?.content)
            .toContain("petrichor wiki ingest")
        expect(files.find((file) => file.path === "petrichor/scripts/petrichor")?.content)
            .toContain("/api/agent/wiki/page/list")

        // 与 MCP 工具能力保持一致：语义检索命令、端点说明、MCP 替代入口
        expect(files.find((file) => file.path === "petrichor/scripts/petrichor")?.content)
            .toContain("/api/agent/document/semantic-search")
        expect(files.find((file) => file.path === "petrichor/skills/docs.md")?.content)
            .toContain("doc semantic")
        expect(files.find((file) => file.path === "petrichor/references/endpoints.md")?.content)
            .toContain("/api/agent/document/semantic-search")
        expect(files.find((file) => file.path === "petrichor/skills/setup.md")?.content)
            .toContain("/api/mcp")
    })

    it("输出 ZIP 文件", () => {
        const zip = buildAgentSkillPackageZip("https://petrichor.example.com/")

        expect(zip.subarray(0, 2).toString("utf8")).toBe("PK")
        expect(zip.toString("utf8")).toContain("petrichor/SKILL.md")
        expect(zip.toString("utf8")).toContain("petrichor/skills/qa.md")
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
        expect(manifest.endpoints.wikiPageList).toBe("/api/agent/wiki/page/list")
        expect(manifest.endpoints.wikiIngest).toBe("/api/agent/wiki/ingest")
        expect(manifest.scopes["wiki:read"]).toEqual(["wiki.page.list", "wiki.page.detail", "wiki.lint"])
        expect(manifest.scopes["wiki:write"]).toEqual(["wiki.ingest"])
        expect(manifest.endpoints.documentSemanticSearch).toBe("/api/agent/document/semantic-search")
        expect(manifest.mcp.endpoint).toBe("https://petrichor.example.com/api/mcp")
        expect(manifest.mcp.transport).toBe("streamable-http")
        expect(manifest).not.toHaveProperty("requiredHeaders")
    })
})
