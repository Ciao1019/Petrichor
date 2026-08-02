import { describe, expect, it } from "vitest"

import { dropEmptySections, keepArticleReachableNodes } from "./payload"
import type { SiteGraphPayloadLink, SiteGraphPayloadNode } from "./types"

function node(
    id: string,
    kind: SiteGraphPayloadNode["kind"],
    parentId: string | null = null,
): SiteGraphPayloadNode {
    return {
        id,
        label: id,
        kind,
        route: null,
        summary: "",
        attributes: [],
        parentId,
        topSectionId: null,
        weight: 1,
    }
}

/**
 * 真实载荷里每个有父节点的节点都会带一条 structure 连线，
 * 测试必须复现这一点——否则「按度数判断」这类错误实现也能通过。
 */
function withStructureLinks(
    nodes: SiteGraphPayloadNode[],
    relationLinks: SiteGraphPayloadLink[] = [],
): SiteGraphPayloadLink[] {
    const structure = nodes
        .filter((item) => item.parentId)
        .map((item) => ({
            source: item.parentId as string,
            target: item.id,
            kind: "structure" as const,
            relation: "包含",
        }))
    return [...structure, ...relationLinks]
}

function relation(source: string, target: string): SiteGraphPayloadLink {
    return { source, target, kind: "reference", relation: "阐述" }
}

const ROOT = node("root", "root")
const SECTION_CONCEPT = node("section-概念", "section", "root")

describe("keepArticleReachableNodes", () => {
    it("唯一来源文章下架后，概念不再可达并被摘掉", () => {
        // 文章节点已被上游按公开文章集过滤掉，这里只剩概念挂在分类下
        const nodes = [ROOT, SECTION_CONCEPT, node("concept-x", "concept", "section-概念")]
        const kept = keepArticleReachableNodes(nodes, withStructureLinks(nodes))
        expect(kept.map((item) => item.id)).toEqual(["root", "section-概念"])
    })

    it("structure 连线不构成可见依据（度数实现会在这里漏掉）", () => {
        const nodes = [ROOT, SECTION_CONCEPT, node("concept-x", "concept", "section-概念")]
        const links = withStructureLinks(nodes)
        // 概念确实有一条连线，但那是层级归属，不是公开依据
        expect(links.some((link) => link.target === "concept-x")).toBe(true)
        expect(keepArticleReachableNodes(nodes, links).some((item) => item.id === "concept-x")).toBe(false)
    })

    it("仍被可见文章引用的概念保留", () => {
        const nodes = [
            ROOT,
            node("section-博客", "section", "root"),
            SECTION_CONCEPT,
            node("article-1", "article", "section-博客"),
            node("concept-x", "concept", "section-概念"),
        ]
        const kept = keepArticleReachableNodes(nodes, withStructureLinks(nodes, [relation("article-1", "concept-x")]))
        expect(kept.map((item) => item.id)).toContain("concept-x")
    })

    it("多来源时只要还有一篇可见文章就保留", () => {
        const nodes = [
            ROOT,
            node("section-博客", "section", "root"),
            SECTION_CONCEPT,
            node("article-2", "article", "section-博客"),
            node("concept-x", "concept", "section-概念"),
        ]
        // article-1 已下架被过滤，article-2 仍在
        const kept = keepArticleReachableNodes(nodes, withStructureLinks(nodes, [relation("article-2", "concept-x")]))
        expect(kept.map((item) => item.id)).toContain("concept-x")
    })

    it("经其他概念间接可达文章的概念保留（多跳）", () => {
        const nodes = [
            ROOT,
            node("section-博客", "section", "root"),
            SECTION_CONCEPT,
            node("article-1", "article", "section-博客"),
            node("concept-x", "concept", "section-概念"),
            node("concept-y", "concept", "section-概念"),
        ]
        const links = withStructureLinks(nodes, [
            relation("article-1", "concept-x"),
            { source: "concept-x", target: "concept-y", kind: "semantic", relation: "相关" },
        ])
        expect(keepArticleReachableNodes(nodes, links).map((item) => item.id)).toContain("concept-y")
    })

    it("整条概念链都够不到可见文章时整片摘掉", () => {
        const nodes = [
            ROOT,
            SECTION_CONCEPT,
            node("concept-x", "concept", "section-概念"),
            node("concept-y", "concept", "section-概念"),
        ]
        const links = withStructureLinks(nodes, [
            { source: "concept-x", target: "concept-y", kind: "semantic", relation: "相关" },
        ])
        const kept = keepArticleReachableNodes(nodes, links).map((item) => item.id)
        expect(kept).not.toContain("concept-x")
        expect(kept).not.toContain("concept-y")
    })

    it("文章节点自身始终保留，可见性由上游公开文章集把关", () => {
        const nodes = [ROOT, node("article-9", "article", "root")]
        expect(keepArticleReachableNodes(nodes, withStructureLinks(nodes)).map((item) => item.id))
            .toContain("article-9")
    })

    it("标签同样按可达性判定", () => {
        const nodes = [
            ROOT,
            node("section-标签", "section", "root"),
            node("tag-孤儿", "tag", "section-标签"),
        ]
        expect(keepArticleReachableNodes(nodes, withStructureLinks(nodes)).map((item) => item.id))
            .not.toContain("tag-孤儿")
    })
})

describe("dropEmptySections", () => {
    it("摘完节点后剩下的空分类一并清掉", () => {
        const nodes = [ROOT, SECTION_CONCEPT]
        expect(dropEmptySections(nodes).map((item) => item.id)).toEqual(["root"])
    })

    it("还有子节点的分类保留", () => {
        const nodes = [ROOT, SECTION_CONCEPT, node("concept-x", "concept", "section-概念")]
        expect(dropEmptySections(nodes).map((item) => item.id)).toContain("section-概念")
    })
})
