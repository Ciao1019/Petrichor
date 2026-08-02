import { SITE_GRAPH_ROOT_KEY } from "./normalize"
import type { SiteGraphPayloadLink, SiteGraphPayloadNode } from "./types"

/**
 * 前台载荷的纯计算部分。
 * 单独成模块是为了能脱离数据库/鉴权依赖直接单测（store.ts 会拉起整条服务端依赖链）。
 */

/** 结构连线只表达层级归属，不构成「这个概念还有公开依据」的证据 */
function isEvidenceLink(link: SiteGraphPayloadLink) {
    return link.kind !== "structure"
}

/**
 * 只保留能追溯到可见文章的概念/实体/标签。
 *
 * 判据是「经关系边可达任一文章节点」而不是「度数大于 0」：所有概念都挂在「概念」分类下，
 * 恒有一条 structure 连线，用度数判断等于永远为真、一个都摘不掉。
 * 传入的 nodes 里文章节点已由调用方按当前公开文章集过滤过，
 * 所以从文章节点出发做一次 BFS，捞不到的就是失去全部公开依据的悬空节点。
 *
 * root/section 始终保留（否则树会散架），article 也始终保留（可见性由上游把关）。
 */
export function keepArticleReachableNodes(
    nodes: SiteGraphPayloadNode[],
    links: SiteGraphPayloadLink[],
): SiteGraphPayloadNode[] {
    const nodeIds = new Set(nodes.map((node) => node.id))
    const neighbors = new Map<string, string[]>()
    for (const link of links) {
        if (!isEvidenceLink(link)) continue
        if (!nodeIds.has(link.source) || !nodeIds.has(link.target)) continue
        neighbors.set(link.source, [...(neighbors.get(link.source) ?? []), link.target])
        neighbors.set(link.target, [...(neighbors.get(link.target) ?? []), link.source])
    }

    const reachable = new Set<string>()
    const queue = nodes.filter((node) => node.kind === "article").map((node) => node.id)
    for (const id of queue) reachable.add(id)

    while (queue.length > 0) {
        const current = queue.shift()
        if (current == null) continue
        for (const neighbor of neighbors.get(current) ?? []) {
            if (reachable.has(neighbor)) continue
            reachable.add(neighbor)
            queue.push(neighbor)
        }
    }

    return nodes.filter((node) => {
        if (node.kind === "root" || node.kind === "section" || node.kind === "article") return true
        return reachable.has(node.id)
    })
}

/** 顶层分类 = 根的直接子节点；点群按它聚簇着色 */
export function assignTopSections(nodes: SiteGraphPayloadNode[]) {
    const byId = new Map(nodes.map((node) => [node.id, node]))
    for (const node of nodes) {
        if (node.id === SITE_GRAPH_ROOT_KEY) continue
        let current: SiteGraphPayloadNode | undefined = node
        const visited = new Set<string>()
        while (current && current.parentId && !visited.has(current.id)) {
            visited.add(current.id)
            if (current.parentId === SITE_GRAPH_ROOT_KEY) break
            current = byId.get(current.parentId)
        }
        node.topSectionId = current && current.parentId === SITE_GRAPH_ROOT_KEY ? current.id : node.id
    }
}

/** 摘掉节点后，只剩空壳的分类没有展示价值（root 保留） */
export function dropEmptySections(
    nodes: SiteGraphPayloadNode[],
): SiteGraphPayloadNode[] {
    const childCount = new Map<string, number>()
    for (const node of nodes) {
        if (!node.parentId) continue
        childCount.set(node.parentId, (childCount.get(node.parentId) ?? 0) + 1)
    }
    return nodes.filter((node) => node.kind !== "section" || (childCount.get(node.id) ?? 0) > 0)
}
