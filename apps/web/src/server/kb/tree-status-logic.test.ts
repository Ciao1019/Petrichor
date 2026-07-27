import { describe, expect, it } from "vitest"

import {
    buildArticleWikiSourceHash,
    buildArticleWikiSourcePageKey,
    resolveArticleHasMindmap,
    resolveArticleTreeShareStatus,
    resolveArticleTreeStatus,
    resolveArticleTreeWikiStatus,
} from "@/server/kb/tree-status-logic"

describe("tree-status-logic", () => {
    const now = new Date("2026-07-27T12:00:00.000Z")

    it("builds wiki source page key", () => {
        expect(buildArticleWikiSourcePageKey(42)).toBe("source-42")
    })

    it("resolves share statuses", () => {
        expect(resolveArticleTreeShareStatus(null, now)).toBe("none")
        expect(resolveArticleTreeShareStatus({
            enabled: false,
            expiresAt: null,
            passwordHash: null,
            revokedAt: null,
        }, now)).toBe("none")
        expect(resolveArticleTreeShareStatus({
            enabled: true,
            expiresAt: null,
            passwordHash: null,
            revokedAt: null,
        }, now)).toBe("public")
        expect(resolveArticleTreeShareStatus({
            enabled: true,
            expiresAt: null,
            passwordHash: "hashed",
            revokedAt: null,
        }, now)).toBe("password")
        expect(resolveArticleTreeShareStatus({
            enabled: true,
            expiresAt: new Date("2026-07-01T00:00:00.000Z"),
            passwordHash: null,
            revokedAt: null,
        }, now)).toBe("expired")
    })

    it("resolves mindmap presence", () => {
        expect(resolveArticleHasMindmap({ mindmapJson: null, mindmapGeneratedAt: null })).toBe(false)
        expect(resolveArticleHasMindmap({ mindmapJson: "  ", mindmapGeneratedAt: null })).toBe(false)
        expect(resolveArticleHasMindmap({ mindmapJson: "{\"nodes\":[]}", mindmapGeneratedAt: null })).toBe(true)
        expect(resolveArticleHasMindmap({ mindmapJson: null, mindmapGeneratedAt: now })).toBe(true)
    })

    it("resolves wiki compile statuses", () => {
        const article = { title: "标题", contentMd: "# Hello" }
        const sourceHash = buildArticleWikiSourceHash(article)

        expect(resolveArticleTreeWikiStatus(article, null)).toBe("none")
        expect(resolveArticleTreeWikiStatus(article, {
            frontmatterJson: JSON.stringify({ sourceHash }),
            archivedAt: now,
        })).toBe("none")
        expect(resolveArticleTreeWikiStatus(article, {
            frontmatterJson: JSON.stringify({ sourceHash }),
            archivedAt: null,
        })).toBe("ready")
        expect(resolveArticleTreeWikiStatus(article, {
            frontmatterJson: JSON.stringify({ sourceHash: "outdated" }),
            archivedAt: null,
        })).toBe("stale")
        expect(resolveArticleTreeWikiStatus(article, {
            frontmatterJson: null,
            archivedAt: null,
        })).toBe("ready")
    })

    it("aggregates tree status fields", () => {
        const article = {
            title: "标题",
            contentMd: "# Hello",
            mindmapJson: "{\"nodes\":[]}",
            mindmapGeneratedAt: now,
        }
        expect(resolveArticleTreeStatus(
            article,
            {
                enabled: true,
                expiresAt: null,
                passwordHash: null,
                revokedAt: null,
            },
            {
                frontmatterJson: JSON.stringify({ sourceHash: buildArticleWikiSourceHash(article) }),
                archivedAt: null,
            },
            now,
        )).toEqual({
            hasMindmap: true,
            shareStatus: "public",
            wikiStatus: "ready",
        })
    })
})
