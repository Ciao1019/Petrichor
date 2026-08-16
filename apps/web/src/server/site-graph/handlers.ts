import { eq } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { z } from "zod"

import { isSuperAdmin } from "@/server/admin/logic"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import { users } from "@/server/db/schema"
import { forbidden, ok, readJson, toErrorResponse, unauthorized } from "@/server/http/response"

import { buildManualNodeKey } from "./extract-agent"
import {
    SITE_GRAPH_LIMITS,
    clampConfidence,
    clampWeight,
    normalizeAliases,
    normalizeAttributes,
    normalizeNodeKey,
} from "./normalize"
import {
    clearSiteGraph,
    confirmMergeCandidate,
    dismissMergeCandidate,
    generateSiteGraph,
    loadPublicSiteGraph,
    loadSiteGraphNeighborhood,
    loadSiteGraphOverview,
    loadSiteGraphSubtree,
    publishSiteGraph,
    revalidateSiteGraph,
    unpublishSiteGraph,
} from "./service"
import { deleteEdge, deleteNode, saveEdge, saveNode } from "./store"
import { SITE_GRAPH_EDGE_KINDS, SITE_GRAPH_NODE_KINDS, SITE_GRAPH_STATUSES } from "./types"

type User = Awaited<ReturnType<typeof requireCurrentUser>>

const idSchema = z.union([z.string(), z.number()]).transform((value, ctx) => {
    const raw = String(value).trim()
    if (!/^\d+$/.test(raw)) {
        ctx.addIssue({ code: "custom", message: "ID 必须是正整数" })
        return z.NEVER
    }
    return Number(raw)
})

const attributeSchema = z.object({
    name: z.string(),
    value: z.string(),
})

const generateSchema = z.object({
    modelRefId: idSchema.optional().nullable(),
    mode: z.enum(["FULL", "INCREMENTAL"]).optional(),
})

const nodeSaveSchema = z.object({
    id: idSchema.optional().nullable(),
    nodeKey: z.string().trim().max(SITE_GRAPH_LIMITS.nodeKeyLength).optional(),
    parentId: idSchema.optional().nullable(),
    kind: z.enum(SITE_GRAPH_NODE_KINDS),
    name: z.string().trim().min(1, "节点名称不能为空").max(SITE_GRAPH_LIMITS.nameLength),
    summary: z.string().trim().max(SITE_GRAPH_LIMITS.summaryLength).optional().nullable(),
    route: z.string().trim().max(300).optional().nullable(),
    attributes: z.array(attributeSchema).optional(),
    aliases: z.array(z.string()).optional(),
    weight: z.number().optional(),
    status: z.enum(SITE_GRAPH_STATUSES).optional(),
    confidence: z.number().optional(),
    locked: z.boolean().optional(),
})

const edgeSaveSchema = z.object({
    id: idSchema.optional().nullable(),
    fromNodeId: idSchema,
    toNodeId: idSchema,
    relation: z.string().trim().min(1, "关系名称不能为空").max(SITE_GRAPH_LIMITS.relationLength),
    kind: z.enum(SITE_GRAPH_EDGE_KINDS),
    attributes: z.array(attributeSchema).optional(),
    weight: z.number().optional(),
    directed: z.boolean().optional(),
    status: z.enum(SITE_GRAPH_STATUSES).optional(),
    confidence: z.number().optional(),
    locked: z.boolean().optional(),
})

const deleteSchema = z.object({ id: idSchema })

const subtreeSchema = z.object({
    nodeId: idSchema,
    depth: z.number().int().min(0).max(SITE_GRAPH_LIMITS.maxDepth).optional(),
})

const neighborhoodSchema = z.object({
    nodeId: idSchema,
    hops: z.number().int().min(1).max(3).optional(),
})

const mergeConfirmSchema = z.object({
    sourceNodeId: idSchema,
    targetNodeId: idSchema,
})

async function withPublic(request: NextRequest, handler: () => Promise<Response>) {
    try {
        return await handler()
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

/** 图谱是站点级数据，写操作与读后台数据都限超级管理员 */
async function requireSuperAdminUser(user: User) {
    const [freshUser] = await getDb().select().from(users).where(eq(users.id, user.id)).limit(1)
    if (!freshUser) {
        throw unauthorized("登录信息已失效")
    }
    if (!isSuperAdmin(freshUser.systemRole, freshUser.id)) {
        throw forbidden("仅超级管理员可维护全站星图")
    }
    return freshUser
}

async function withAdmin(request: NextRequest, handler: (user: User) => Promise<Response>) {
    try {
        const user = await requireCurrentUser(request)
        await requireSuperAdminUser(user)
        return await handler(user)
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

// ===== 前台 =====

export async function publicSiteGraph(request: NextRequest) {
    return withPublic(request, async () => ok(await loadPublicSiteGraph()))
}

// ===== 后台 =====

export async function adminSiteGraphOverview(request: NextRequest) {
    return withAdmin(request, async (user) => ok(await loadSiteGraphOverview(user.id)))
}

export async function adminSiteGraphGenerate(request: NextRequest) {
    return withAdmin(request, async (user) => {
        const input = generateSchema.parse(await readJson(request))
        return ok(await generateSiteGraph({
            userId: user.id,
            modelRefId: input.modelRefId ?? null,
            mode: input.mode,
        }))
    })
}

export async function adminSiteGraphValidate(request: NextRequest) {
    return withAdmin(request, async (user) => ok(await revalidateSiteGraph(user.id)))
}

export async function adminSiteGraphPublish(request: NextRequest) {
    return withAdmin(request, async (user) => ok(await publishSiteGraph(user.id)))
}

export async function adminSiteGraphUnpublish(request: NextRequest) {
    return withAdmin(request, async (user) => ok(await unpublishSiteGraph(user.id)))
}

export async function adminSiteGraphClear(request: NextRequest) {
    return withAdmin(request, async (user) => ok(await clearSiteGraph(user.id)))
}

export async function adminSiteGraphNodeSave(request: NextRequest) {
    return withAdmin(request, async (user) => {
        const input = nodeSaveSchema.parse(await readJson(request))
        const node = await saveNode({
            userId: user.id,
            id: input.id ?? null,
            nodeKey: input.nodeKey?.trim()
                ? normalizeNodeKey(input.nodeKey)
                : buildManualNodeKey(input.name, input.kind),
            parentId: input.parentId ?? null,
            kind: input.kind,
            name: input.name,
            summary: input.summary ?? null,
            route: input.route ?? null,
            attributes: normalizeAttributes(input.attributes),
            aliases: normalizeAliases(input.aliases),
            weight: clampWeight(input.weight ?? 1),
            status: input.status ?? "DRAFT",
            confidence: clampConfidence(input.confidence ?? 100),
            locked: input.locked ?? false,
        })
        return ok({ id: String(node.id), nodeKey: node.nodeKey })
    })
}

export async function adminSiteGraphNodeDelete(request: NextRequest) {
    return withAdmin(request, async (user) => {
        const input = deleteSchema.parse(await readJson(request))
        return ok(await deleteNode(user.id, input.id))
    })
}

export async function adminSiteGraphEdgeSave(request: NextRequest) {
    return withAdmin(request, async (user) => {
        const input = edgeSaveSchema.parse(await readJson(request))
        const edge = await saveEdge({
            userId: user.id,
            id: input.id ?? null,
            fromNodeId: input.fromNodeId,
            toNodeId: input.toNodeId,
            relation: input.relation,
            kind: input.kind,
            attributes: normalizeAttributes(input.attributes),
            weight: clampWeight(input.weight ?? 1),
            directed: input.directed ?? true,
            status: input.status ?? "DRAFT",
            confidence: clampConfidence(input.confidence ?? 100),
            locked: input.locked ?? false,
        })
        return ok({ id: String(edge.id) })
    })
}

export async function adminSiteGraphEdgeDelete(request: NextRequest) {
    return withAdmin(request, async (user) => {
        const input = deleteSchema.parse(await readJson(request))
        return ok(await deleteEdge(user.id, input.id))
    })
}

export async function adminSiteGraphMergeConfirm(request: NextRequest) {
    return withAdmin(request, async (user) => {
        const input = mergeConfirmSchema.parse(await readJson(request))
        return ok(await confirmMergeCandidate({
            userId: user.id,
            sourceNodeId: input.sourceNodeId,
            targetNodeId: input.targetNodeId,
        }))
    })
}

export async function adminSiteGraphMergeIgnore(request: NextRequest) {
    return withAdmin(request, async (user) => {
        const input = deleteSchema.parse(await readJson(request))
        return ok(await dismissMergeCandidate(user.id, input.id))
    })
}

export async function adminSiteGraphSubtree(request: NextRequest) {
    return withAdmin(request, async (user) => {
        const input = subtreeSchema.parse(await readJson(request))
        return ok(await loadSiteGraphSubtree({ userId: user.id, nodeId: input.nodeId, depth: input.depth }))
    })
}

export async function adminSiteGraphNeighborhood(request: NextRequest) {
    return withAdmin(request, async (user) => {
        const input = neighborhoodSchema.parse(await readJson(request))
        return ok(await loadSiteGraphNeighborhood({ userId: user.id, nodeId: input.nodeId, hops: input.hops }))
    })
}
