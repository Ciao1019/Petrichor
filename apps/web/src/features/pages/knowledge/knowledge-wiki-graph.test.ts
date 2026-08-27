import { describe, expect, it } from "vitest"

import type {
  KnowledgeBaseWikiGraphLink,
  KnowledgeBaseWikiGraphNode,
  KnowledgeBaseWikiGraphResponse,
} from "@/lib/api"
import {
  WIKI_GRAPH_ROOT_ID,
  WIKI_GRAPH_UNCATEGORIZED,
  buildWikiGraphPayload,
  wikiGraphPageRoute,
  wikiGraphRoutePageKey,
} from "@/features/pages/knowledge/knowledge-wiki-graph"

function node(
  pageKey: string,
  kind: string,
  overrides: Partial<KnowledgeBaseWikiGraphNode> = {},
): KnowledgeBaseWikiGraphNode {
  return {
    pageKey,
    title: pageKey,
    kind,
    summary: null,
    categoryPath: [],
    aliases: [],
    sourceCount: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function link(
  fromPageKey: string,
  toPageKey: string,
  overrides: Partial<KnowledgeBaseWikiGraphLink> = {},
): KnowledgeBaseWikiGraphLink {
  return {
    id: `${fromPageKey}->${toPageKey}`,
    fromPageKey,
    toPageKey,
    linkType: "related",
    description: null,
    ...overrides,
  }
}

function graph(
  nodes: KnowledgeBaseWikiGraphNode[],
  links: KnowledgeBaseWikiGraphLink[] = [],
): KnowledgeBaseWikiGraphResponse {
  return {
    knowledgeBaseId: "1",
    knowledgeBaseName: "产品知识库",
    nodes,
    links,
    stats: {
      pageCount: nodes.length,
      linkCount: links.length,
      conceptCount: nodes.filter((item) => item.kind === "concept").length,
      entityCount: nodes.filter((item) => item.kind === "entity").length,
      sourceCount: nodes.filter((item) => item.kind === "source").length,
    },
    generatedAt: "2026-01-02T00:00:00.000Z",
  }
}

describe("buildWikiGraphPayload", () => {
  it("把知识库折成根节点，页面按类型映射到星图 kind", () => {
    const payload = buildWikiGraphPayload(graph([
      node("index", "index"),
      node("concept-1", "concept", { categoryPath: ["架构"] }),
      node("entity-1", "entity", { categoryPath: ["架构", "组件"] }),
      node("source-9", "source"),
      node("log-1", "log"),
    ]))

    const byId = new Map(payload.nodes.map((item) => [item.id, item]))
    expect(byId.get(WIKI_GRAPH_ROOT_ID)?.kind).toBe("root")
    expect(byId.get(WIKI_GRAPH_ROOT_ID)?.label).toBe("产品知识库")
    expect(byId.get("index")?.kind).toBe("section")
    expect(byId.get("concept-1")?.kind).toBe("concept")
    expect(byId.get("entity-1")?.kind).toBe("entity")
    expect(byId.get("source-9")?.kind).toBe("article")
    expect(byId.get("log-1")?.kind).toBe("tag")
  })

  it("按 categoryPath 逐级建分类节点，未标注分类的走兜底目录", () => {
    const payload = buildWikiGraphPayload(graph([
      node("entity-1", "entity", { categoryPath: ["架构", "组件"] }),
      node("concept-1", "concept"),
    ]))

    const byId = new Map(payload.nodes.map((item) => [item.id, item]))
    const entityParent = byId.get(byId.get("entity-1")?.parentId ?? "")
    expect(entityParent?.label).toBe("组件")
    expect(byId.get(entityParent?.parentId ?? "")?.label).toBe("架构")
    expect(byId.get(byId.get("concept-1")?.parentId ?? "")?.label).toBe(WIKI_GRAPH_UNCATEGORIZED)

    // 分类节点自身也有 structure 连线，层级布局才不会把它们甩成孤儿
    expect(payload.links).toContainEqual({
      source: WIKI_GRAPH_ROOT_ID,
      target: byId.get("entity-1")?.topSectionId,
      kind: "structure",
      relation: "包含",
    })
  })

  it("同一层分类只建一次", () => {
    const payload = buildWikiGraphPayload(graph([
      node("entity-1", "entity", { categoryPath: ["架构"] }),
      node("entity-2", "entity", { categoryPath: ["架构"] }),
    ]))

    expect(payload.nodes.filter((item) => item.kind === "section")).toHaveLength(1)
    expect(payload.nodes.find((item) => item.id === "entity-1")?.parentId)
      .toBe(payload.nodes.find((item) => item.id === "entity-2")?.parentId)
  })

  it("出链转成关系边，指向不存在的页面时丢弃", () => {
    const payload = buildWikiGraphPayload(graph(
      [node("concept-1", "concept"), node("concept-2", "concept")],
      [
        link("concept-1", "concept-2", { linkType: "mentions" }),
        link("concept-1", "missing"),
      ],
    ))

    const relationLinks = payload.links.filter((item) => item.kind !== "structure")
    expect(relationLinks).toEqual([
      { source: "concept-1", target: "concept-2", kind: "reference", relation: "提及" },
    ])
  })

  it("节点带上类型、分类、来源引用和更新时间属性", () => {
    const payload = buildWikiGraphPayload(graph([
      node("concept-1", "concept", {
        title: "检索增强",
        summary: "把外部知识拼进提示词",
        categoryPath: ["架构", "检索"],
        sourceCount: 3,
        aliases: ["RAG"],
      }),
    ]))

    const concept = payload.nodes.find((item) => item.id === "concept-1")
    expect(concept?.label).toBe("检索增强")
    expect(concept?.summary).toBe("把外部知识拼进提示词")
    expect(concept?.aliases).toEqual(["RAG"])
    expect(concept?.weight).toBe(3)
    expect(concept?.route).toBe(wikiGraphPageRoute("concept-1"))
    expect(concept?.attributes).toContainEqual({ name: "类型", value: "概念" })
    expect(concept?.attributes).toContainEqual({ name: "分类", value: "架构 / 检索" })
    expect(concept?.attributes).toContainEqual({ name: "来源引用", value: "3 条" })
  })

  it("route 能反解回 pageKey，非页面节点返回 null", () => {
    expect(wikiGraphRoutePageKey(wikiGraphPageRoute("concept-1"))).toBe("concept-1")
    expect(wikiGraphRoutePageKey("/graph")).toBeNull()
  })
})
