import { describe, expect, it } from "vitest"

import type { KnowledgeBaseWikiGraphEdge, KnowledgeBaseWikiGraphNode } from "@/lib/api"
import { buildWikiGraphData, isWikiGraphFolderId, wikiGraphNodeColor } from "./graph"

function node(pageKey: string, title: string, kind: KnowledgeBaseWikiGraphNode["kind"]): KnowledgeBaseWikiGraphNode {
    return { pageKey, title, kind, summary: null, linkCount: 0 }
}

const nodes = [
    node("index", "索引", "index"),
    node("entity/zsh", "Zsh", "entity"),
    node("entity/bash", "Bash", "entity"),
    node("concept/cleanup", "系统清理", "concept"),
]
const categoryPaths = new Map([
    ["entity/zsh", ["软件", "Shell"]],
    ["entity/bash", ["软件", "Shell"]],
    ["concept/cleanup", []],
])

/** 在 mind-elixir 树里按 id 找节点。 */
function find(tree: any, id: string): any {
    if (tree.id === id) return tree
    for (const child of tree.children ?? []) {
        const hit = find(child, id)
        if (hit) return hit
    }
    return null
}

describe("buildWikiGraphData", () => {
    it("按 categoryPath 建立目录层级，而不是把所有页面挂在根上", () => {
        const data = buildWikiGraphData("我的知识库", nodes, [], categoryPaths) as any
        const root = data.nodeData

        expect(root.id).toBe("index")
        expect(root.root).toBe(true)
        const shell = find(root, "folder:软件/Shell")
        expect(shell).not.toBeNull()
        expect(shell.children.map((child: any) => child.id)).toEqual(["entity/zsh", "entity/bash"])
        expect(find(root, "folder:软件").children.map((child: any) => child.id)).toEqual(["folder:软件/Shell"])
    })

    it("没有目录的页面直接挂在根节点下", () => {
        const data = buildWikiGraphData("我的知识库", nodes, [], categoryPaths) as any

        expect(data.nodeData.children.map((child: any) => child.id)).toContain("concept/cleanup")
    })

    it("页面按类型上色，目录节点用中性色", () => {
        const data = buildWikiGraphData("我的知识库", nodes, [], categoryPaths) as any

        expect(find(data.nodeData, "entity/zsh").branchColor).toBe(wikiGraphNodeColor("entity"))
        expect(find(data.nodeData, "concept/cleanup").branchColor).toBe(wikiGraphNodeColor("concept"))
        expect(find(data.nodeData, "folder:软件").branchColor).not.toBe(wikiGraphNodeColor("entity"))
    })

    it("只保留页面之间的引用边，索引页发出的边被丢弃", () => {
        const edges: KnowledgeBaseWikiGraphEdge[] = [
            { source: "index", target: "entity/zsh", linkType: "index" },
            { source: "entity/zsh", target: "entity/bash", linkType: "related" },
        ]
        const data = buildWikiGraphData("我的知识库", nodes, edges, categoryPaths) as any

        expect(data.arrows).toHaveLength(1)
        expect(data.arrows[0]).toMatchObject({ from: "entity/zsh", to: "entity/bash", label: "related" })
    })

    it("丢弃自环、重复边和指向不存在页面的边", () => {
        const edges: KnowledgeBaseWikiGraphEdge[] = [
            { source: "entity/zsh", target: "entity/zsh", linkType: "self" },
            { source: "entity/zsh", target: "entity/bash", linkType: "related" },
            { source: "entity/zsh", target: "entity/bash", linkType: "related" },
            { source: "entity/zsh", target: "entity/missing", linkType: "broken" },
        ]
        const data = buildWikiGraphData("我的知识库", nodes, edges, categoryPaths) as any

        expect(data.arrows).toHaveLength(1)
    })

    it("没有索引页时用知识库名兜底做根节点", () => {
        const data = buildWikiGraphData("我的知识库", [node("entity/zsh", "Zsh", "entity")], [], new Map()) as any

        expect(data.nodeData.id).toBe("wiki-root")
        expect(data.nodeData.topic).toBe("我的知识库 Wiki")
    })
})

describe("isWikiGraphFolderId", () => {
    it("区分目录节点与页面节点", () => {
        expect(isWikiGraphFolderId("folder:软件")).toBe(true)
        expect(isWikiGraphFolderId("entity/zsh")).toBe(false)
    })
})
