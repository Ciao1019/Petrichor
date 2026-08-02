import { describe, expect, it } from "vitest"

import { retrieveFromGraph } from "./qa-retrieval"
import type { SiteGraphPayload, SiteGraphPayloadLink, SiteGraphPayloadNode } from "./types"

function node(
    id: string,
    kind: SiteGraphPayloadNode["kind"],
    label: string,
    extra: Partial<SiteGraphPayloadNode> = {},
): SiteGraphPayloadNode {
    return {
        id,
        label,
        kind,
        route: kind === "article" ? `/p/${id}` : null,
        summary: "",
        attributes: [],
        aliases: [],
        parentId: null,
        topSectionId: null,
        weight: 1,
        ...extra,
    }
}

function link(
    source: string,
    target: string,
    relation: string,
    kind: SiteGraphPayloadLink["kind"] = "reference",
): SiteGraphPayloadLink {
    return { source, target, relation, kind }
}

/**
 * 文章一「阐述」向量检索，向量检索「依赖」pgvector；
 * 另有一条不相干的分支（用户鉴权 ← 文章二）用于验证不会误召回。
 */
function payload(): SiteGraphPayload {
    const nodes = [
        node("root", "root", "全站星图"),
        node("section-概念", "section", "概念", { parentId: "root" }),
        node("article-1", "article", "向量检索入门", { parentId: "root" }),
        node("article-2", "article", "鉴权实践", { parentId: "root" }),
        node("concept-向量检索", "concept", "向量检索", {
            parentId: "section-概念",
            aliases: ["vector search"],
            attributes: [{ name: "类别", value: "检索技术" }],
        }),
        node("entity-pgvector", "entity", "pgvector", { parentId: "section-概念" }),
        node("concept-用户鉴权", "concept", "用户鉴权", { parentId: "section-概念" }),
    ]
    const links = [
        // 结构边：不应参与语义扩散
        ...nodes.filter((item) => item.parentId).map((item) =>
            link(item.parentId as string, item.id, "包含", "structure")),
        link("article-1", "concept-向量检索", "阐述"),
        link("concept-向量检索", "entity-pgvector", "依赖", "semantic"),
        link("article-2", "concept-用户鉴权", "阐述"),
    ]
    return {
        nodes,
        links,
        stats: { nodeCount: nodes.length, linkCount: links.length, articleCount: 2, conceptCount: 3 },
        generatedAt: null,
    }
}

describe("retrieveFromGraph", () => {
    it("按概念名命中入口，并沿关系边找到文章", () => {
        const result = retrieveFromGraph(payload(), { query: "向量检索" })
        // 精确同名的概念排在最前；标题含该词的文章也是合理入口，故只断言排序与包含
        expect(result.matched[0].id).toBe("concept-向量检索")
        expect(result.matched[0].matchedBy).toBe("name")
        expect(result.articles.map((item) => item.articleId)).toContain("1")
    })

    it("命中别名的同义写法", () => {
        const result = retrieveFromGraph(payload(), { query: "vector search" })
        // 别名精确命中得分最高，排在子串命中（pgvector 含 vector）之前
        expect(result.matched[0].id).toBe("concept-向量检索")
        expect(result.matched[0].matchedBy).toBe("alias")
    })

    it("从中文长问句里切出概念词，而不是整句比对", () => {
        const result = retrieveFromGraph(payload(), { query: "向量检索 和 pgvector 是什么关系？" })
        const ids = result.matched.map((item) => item.id)
        expect(ids).toContain("concept-向量检索")
        expect(ids).toContain("entity-pgvector")
    })

    it("产出的链路节点与关系数量对齐，且能追溯到文章", () => {
        const result = retrieveFromGraph(payload(), { query: "pgvector" })
        for (const path of result.paths) {
            expect(path.relations).toHaveLength(path.nodes.length - 1)
        }
        const toArticle = result.paths.find((path) => path.article?.articleId === "1")
        expect(toArticle).toBeDefined()
        // pgvector → 向量检索 → 文章一
        expect(toArticle?.nodes.map((item) => item.label)).toEqual(["pgvector", "向量检索", "向量检索入门"])
        expect(toArticle?.relations).toEqual(["依赖", "阐述"])
    })

    it("结构边不参与扩散，不会顺着分类把无关文章拉进来", () => {
        const result = retrieveFromGraph(payload(), { query: "向量检索" })
        expect(result.nodes.map((item) => item.id)).not.toContain("article-2")
        expect(result.nodes.map((item) => item.id)).not.toContain("concept-用户鉴权")
        expect(result.links.every((item) => item.kind !== "structure")).toBe(true)
    })

    it("跳数上限生效", () => {
        const oneHop = retrieveFromGraph(payload(), { query: "pgvector", maxHops: 1 })
        // 1 跳只能到「向量检索」，到不了文章
        expect(oneHop.nodes.map((item) => item.id)).toContain("concept-向量检索")
        expect(oneHop.nodes.map((item) => item.id)).not.toContain("article-1")
    })

    it("结构骨架不作为语义入口", () => {
        const result = retrieveFromGraph(payload(), { query: "概念" })
        expect(result.matched.every((item) => item.kind !== "section" && item.kind !== "root")).toBe(true)
    })

    it("无命中时给出改用全文检索的提示", () => {
        const result = retrieveFromGraph(payload(), { query: "量子纠缠" })
        expect(result.matched).toHaveLength(0)
        expect(result.paths).toHaveLength(0)
        expect(result.emptyMessage).toContain("search_public_articles")
    })
})
