import { and, eq, inArray, sql } from "drizzle-orm"

import { getDb, isSqliteDatabase } from "@/server/db/client"
import { siteGraphEdges, siteGraphNodes } from "@/server/db/schema"

import { SITE_GRAPH_LIMITS } from "./normalize"
import type { SiteGraphStatus } from "./types"

/**
 * 图查询层：不使用图数据库，树形结构靠邻接表（parent_id）+ PostgreSQL 递归 CTE，
 * 跨树关系的 N 跳邻域同样用递归 CTE 在关系表上展开。
 *
 * 本地 SQLite 开发模式下 drizzle 的 bun:sqlite driver 没有 execute()，
 * 因此每个查询都配了一份等价的内存遍历兜底（图规模上限 1200 节点，成本可忽略）。
 */

function readRows(raw: unknown): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = []
    for (const row of raw as Iterable<Record<string, unknown>>) {
        rows.push(row)
    }
    return rows
}

/** 把状态数组展开成 SQL 的 in 列表参数（drizzle 的 sql 模板不会自动展开数组） */
function statusListSql(statuses: SiteGraphStatus[]) {
    return sql.join(statuses.map((status) => sql`${status}`), sql`, `)
}

function toIdList(rows: Record<string, unknown>[], column: string) {
    const ids: number[] = []
    for (const row of rows) {
        const value = Number(row[column])
        if (Number.isInteger(value)) ids.push(value)
    }
    return ids
}

/**
 * 子树查询：从 rootNodeId 沿 parent_id 向下展开，最多 maxDepth 层。
 * depth 上界同时也是递归终止条件，即使数据被人工改出环也不会无限递归。
 */
export async function loadSubtreeNodeIds(input: {
    userId: number
    rootNodeId: number
    maxDepth?: number
    statuses?: SiteGraphStatus[]
}): Promise<Array<{ id: number; depth: number }>> {
    const maxDepth = Math.min(Math.max(input.maxDepth ?? SITE_GRAPH_LIMITS.maxDepth, 0), SITE_GRAPH_LIMITS.maxDepth)
    const statuses = input.statuses ?? ["DRAFT", "PUBLISHED"]

    if (isSqliteDatabase()) {
        return loadSubtreeNodeIdsInMemory(input.userId, input.rootNodeId, maxDepth, statuses)
    }

    const statusList = statusListSql(statuses)
    const rows = await getDb().execute(sql`
        with recursive subtree as (
            select n.id, n.parent_id, 0 as depth
            from petrichor_site_graph_node n
            where n.id = ${input.rootNodeId}
              and n.user_id = ${input.userId}
              and n.status in (${statusList})
            union all
            select child.id, child.parent_id, parent.depth + 1
            from petrichor_site_graph_node child
            join subtree parent on child.parent_id = parent.id
            where parent.depth < ${maxDepth}
              and child.user_id = ${input.userId}
              and child.status in (${statusList})
        )
        select id, depth from subtree
    `)

    return readRows(rows)
        .map((row) => ({ id: Number(row.id), depth: Number(row.depth) }))
        .filter((row) => Number.isInteger(row.id))
}

/**
 * N 跳邻域查询：在关系表上做无向展开，用于前台「聚焦某个节点看它周边」。
 * 递归项用 union（去重）而非 union all，行数上界为 节点数 × (hops + 1)。
 */
export async function loadNeighborhoodNodeIds(input: {
    userId: number
    startNodeId: number
    hops?: number
    statuses?: SiteGraphStatus[]
}): Promise<number[]> {
    const hops = Math.min(Math.max(input.hops ?? 1, 1), 3)
    const statuses = input.statuses ?? ["DRAFT", "PUBLISHED"]

    if (isSqliteDatabase()) {
        return loadNeighborhoodNodeIdsInMemory(input.userId, input.startNodeId, hops, statuses)
    }

    const rows = await getDb().execute(sql`
        with recursive hood(node_id, hop) as (
            select ${input.startNodeId}, 0
            union
            select
                case when edge.from_node_id = hood.node_id then edge.to_node_id else edge.from_node_id end,
                hood.hop + 1
            from hood
            join petrichor_site_graph_edge edge
              on edge.from_node_id = hood.node_id or edge.to_node_id = hood.node_id
            where hood.hop < ${hops}
              and edge.user_id = ${input.userId}
              and edge.status in (${statusListSql(statuses)})
        )
        select distinct node_id from hood
    `)

    return toIdList(readRows(rows), "node_id")
}

/**
 * 祖先链：从节点沿 parent_id 一路向上，返回从根到自身的路径，用于后台面包屑。
 */
export async function loadAncestorPath(input: {
    userId: number
    nodeId: number
}): Promise<Array<{ id: number; nodeKey: string; name: string }>> {
    if (isSqliteDatabase()) {
        return loadAncestorPathInMemory(input.userId, input.nodeId)
    }

    const rows = await getDb().execute(sql`
        with recursive ancestors as (
            select n.id, n.parent_id, n.node_key, n.name, 0 as up
            from petrichor_site_graph_node n
            where n.id = ${input.nodeId} and n.user_id = ${input.userId}
            union all
            select parent.id, parent.parent_id, parent.node_key, parent.name, child.up + 1
            from petrichor_site_graph_node parent
            join ancestors child on child.parent_id = parent.id
            where child.up < ${SITE_GRAPH_LIMITS.maxDepth} and parent.user_id = ${input.userId}
        )
        select id, node_key, name, up from ancestors order by up desc
    `)

    return readRows(rows).map((row) => ({
        id: Number(row.id),
        nodeKey: String(row.node_key ?? ""),
        name: String(row.name ?? ""),
    }))
}

// ===== SQLite 兜底实现：一次拉全量后在内存里做同样的遍历 =====

async function loadAllNodes(userId: number, statuses: SiteGraphStatus[]) {
    return await getDb()
        .select({
            id: siteGraphNodes.id,
            parentId: siteGraphNodes.parentId,
            nodeKey: siteGraphNodes.nodeKey,
            name: siteGraphNodes.name,
        })
        .from(siteGraphNodes)
        .where(and(eq(siteGraphNodes.userId, userId), inArray(siteGraphNodes.status, statuses)))
}

async function loadSubtreeNodeIdsInMemory(
    userId: number,
    rootNodeId: number,
    maxDepth: number,
    statuses: SiteGraphStatus[],
) {
    const nodes = await loadAllNodes(userId, statuses)
    const childrenByParent = new Map<number, number[]>()
    for (const node of nodes) {
        if (node.parentId == null) continue
        childrenByParent.set(node.parentId, [...(childrenByParent.get(node.parentId) ?? []), node.id])
    }
    if (!nodes.some((node) => node.id === rootNodeId)) return []

    const result: Array<{ id: number; depth: number }> = []
    const visited = new Set<number>()
    let frontier = [rootNodeId]
    for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth += 1) {
        const next: number[] = []
        for (const id of frontier) {
            if (visited.has(id)) continue
            visited.add(id)
            result.push({ id, depth })
            next.push(...(childrenByParent.get(id) ?? []))
        }
        frontier = next
    }
    return result
}

async function loadNeighborhoodNodeIdsInMemory(
    userId: number,
    startNodeId: number,
    hops: number,
    statuses: SiteGraphStatus[],
) {
    const edges = await getDb()
        .select({ fromNodeId: siteGraphEdges.fromNodeId, toNodeId: siteGraphEdges.toNodeId })
        .from(siteGraphEdges)
        .where(and(eq(siteGraphEdges.userId, userId), inArray(siteGraphEdges.status, statuses)))

    const neighbors = new Map<number, number[]>()
    for (const edge of edges) {
        neighbors.set(edge.fromNodeId, [...(neighbors.get(edge.fromNodeId) ?? []), edge.toNodeId])
        neighbors.set(edge.toNodeId, [...(neighbors.get(edge.toNodeId) ?? []), edge.fromNodeId])
    }

    const visited = new Set<number>([startNodeId])
    let frontier = [startNodeId]
    for (let hop = 0; hop < hops; hop += 1) {
        const next: number[] = []
        for (const id of frontier) {
            for (const neighbor of neighbors.get(id) ?? []) {
                if (visited.has(neighbor)) continue
                visited.add(neighbor)
                next.push(neighbor)
            }
        }
        frontier = next
    }
    return [...visited]
}

async function loadAncestorPathInMemory(userId: number, nodeId: number) {
    const nodes = await loadAllNodes(userId, ["DRAFT", "PUBLISHED", "ARCHIVED"])
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const path: Array<{ id: number; nodeKey: string; name: string }> = []
    const visited = new Set<number>()
    let current = byId.get(nodeId)
    while (current && !visited.has(current.id) && path.length <= SITE_GRAPH_LIMITS.maxDepth) {
        visited.add(current.id)
        path.unshift({ id: current.id, nodeKey: current.nodeKey, name: current.name })
        current = current.parentId == null ? undefined : byId.get(current.parentId)
    }
    return path
}
