/**
 * 把 Wiki 页面与双链组装成图谱数据。
 *
 * 旧实现把索引页当根、所有页面直接挂成它的子节点，图谱因此塌成一个星形，
 * 既看不出目录结构也看不出页面之间的引用。这里改成三层：
 * 索引页 → 目录节点（来自 categoryPath）→ 页面，再把真实的双链作为交叉边叠上去，
 * 于是层级边表达"页面归属哪个目录"，交叉边表达"页面之间互相引用"。
 */

import type { MindElixirData } from "mind-elixir"

import type { KnowledgeBaseWikiGraphEdge, KnowledgeBaseWikiGraphNode } from "@/lib/api"

/** 目录节点的 id 前缀，用来和页面节点区分：目录不可点击跳转。 */
export const WIKI_GRAPH_FOLDER_PREFIX = "folder:"

/** 页面类型配色，与左侧目录树的图标色系保持一致。 */
export const WIKI_GRAPH_KIND_COLORS: Record<string, string> = {
    index: "#0f766e",
    summary: "#0284c7",
    entity: "#7c3aed",
    concept: "#d97706",
}

const FOLDER_COLOR = "#94a3b8"
const FALLBACK_KIND_COLOR = "#64748b"

export function wikiGraphNodeColor(kind: string): string {
    return WIKI_GRAPH_KIND_COLORS[kind] ?? FALLBACK_KIND_COLOR
}

/** 目录节点不是页面，点击它没有正文可展示。 */
export function isWikiGraphFolderId(id: string): boolean {
    return id.startsWith(WIKI_GRAPH_FOLDER_PREFIX)
}

interface MindNode {
    id: string
    topic: string
    branchColor?: string
    children: MindNode[]
}

export function buildWikiGraphData(
    knowledgeBaseName: string,
    nodes: KnowledgeBaseWikiGraphNode[],
    edges: KnowledgeBaseWikiGraphEdge[],
    categoryPaths: Map<string, string[]>,
): MindElixirData {
    const indexNode = nodes.find((node) => node.kind === "index")
    const rootId = indexNode?.pageKey ?? "wiki-root"

    // 目录节点按需创建，父目录先于子目录建立，形成和左侧目录树一致的层级。
    const folderNodes = new Map<string, MindNode>()
    const root: MindNode = {
        id: rootId,
        topic: indexNode?.title ?? `${knowledgeBaseName} Wiki`,
        children: [],
    }

    const folderFor = (path: string[]): MindNode => {
        let parent = root
        for (let depth = 0; depth < path.length; depth += 1) {
            const id = `${WIKI_GRAPH_FOLDER_PREFIX}${path.slice(0, depth + 1).join("/")}`
            let folder = folderNodes.get(id)
            if (!folder) {
                folder = { id, topic: path[depth]!, branchColor: FOLDER_COLOR, children: [] }
                folderNodes.set(id, folder)
                parent.children.push(folder)
            }
            parent = folder
        }
        return parent
    }

    for (const node of nodes) {
        if (node.pageKey === rootId) continue
        const path = (categoryPaths.get(node.pageKey) ?? []).filter((part) => part.trim() !== "")
        folderFor(path).children.push({
            id: node.pageKey,
            topic: node.title,
            branchColor: wikiGraphNodeColor(node.kind),
            children: [],
        })
    }

    // 层级边已经由目录结构表达，这里只保留页面之间真正的引用关系，
    // 并且跳过索引页发出的边（它指向每一个页面，画出来只会糊成一团）。
    const pageKeys = new Set(nodes.map((node) => node.pageKey))
    const seen = new Set<string>()
    const arrows = edges
        .filter((edge) => {
            if (edge.source === rootId || edge.target === rootId) return false
            if (!pageKeys.has(edge.source) || !pageKeys.has(edge.target)) return false
            if (edge.source === edge.target) return false
            const key = `${edge.source}→${edge.target}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
        })
        .map((edge, index) => ({ id: `wiki-edge-${index}`, from: edge.source, to: edge.target, label: edge.linkType }))

    return { nodeData: { ...root, root: true }, arrows } as unknown as MindElixirData
}
