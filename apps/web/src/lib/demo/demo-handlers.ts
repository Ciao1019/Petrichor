import type { DemoHandler, DemoHandlerResult } from "./demo-adapter"
import {
    DEMO_USER,
    articleDetail,
    buildDashboardOverview,
    demoStore,
    kbById,
    nextArticleId,
    nextNodeId,
    nodePath,
    nodesOf,
    toTreeNode,
    touchKb,
} from "./demo-store"
import { demoThreadDelete, demoThreadDetail, demoThreadList, demoPlanPatch, ensureDemoThreads } from "./demo-assistant"

/*
 * 演示模式的 mock 路由表：键为 "METHOD /path"（不含 /api 前缀）。
 * 写操作直接改内存 store，页面交互全部真实生效；刷新即重置。
 * 未在表内的接口由 demo-adapter 统一回 400 + 「演示模式暂不支持」。
 */

function ok(data: unknown): DemoHandlerResult {
    return { data }
}

function notFound(msg: string): DemoHandlerResult {
    return { status: 404, data: { code: 404, msg } }
}

function badRequest(msg: string): DemoHandlerResult {
    return { status: 400, data: { code: 400, msg } }
}

function str(value: unknown): string {
    return typeof value === "string" ? value : ""
}

const handlers: Record<string, DemoHandler> = {
    /* ---------- 会话 / 用户 ---------- */
    "GET /auth/me": () => ok(DEMO_USER),
    "GET /auth/profile": () => ok(DEMO_USER),
    "POST /auth/logout": () => ok({}),
    "GET /notification/summary": () => ok({ unreadCount: 0, latestUnreadId: null }),
    "POST /notification/list": () => ok({ total: 0, rows: [], code: 200, msg: "ok" }),

    /* ---------- 知识库 CRUD ---------- */
    "POST /kb/knowledge-base/list": () =>
        ok({
            total: demoStore.knowledgeBases.length,
            rows: demoStore.knowledgeBases,
            code: 200,
            msg: "ok",
        }),
    "POST /kb/knowledge-base/detail": (body) => {
        const kb = kbById(str(body.knowledgeBaseId))
        return kb ? ok(kb) : notFound("知识库不存在")
    },
    "POST /kb/knowledge-base/create": (body) => {
        const now = new Date().toISOString()
        const kb = {
            id: `demo-kb-new-${demoStore.knowledgeBases.length + 1}`,
            name: str(body.name) || "未命名知识库",
            description: str(body.description),
            createdAt: now,
            updatedAt: now,
        }
        demoStore.knowledgeBases.push(kb)
        return ok(kb)
    },
    "POST /kb/knowledge-base/update": (body) => {
        const kb = kbById(str(body.knowledgeBaseId))
        if (!kb) return notFound("知识库不存在")
        kb.name = str(body.name) || kb.name
        kb.description = typeof body.description === "string" ? body.description : kb.description
        kb.updatedAt = new Date().toISOString()
        return ok(kb)
    },
    "POST /kb/knowledge-base/delete": (body) => {
        const knowledgeBaseId = str(body.knowledgeBaseId)
        const index = demoStore.knowledgeBases.findIndex((kb) => kb.id === knowledgeBaseId)
        if (index < 0) return notFound("知识库不存在")
        demoStore.knowledgeBases.splice(index, 1)
        demoStore.nodes = demoStore.nodes.filter((node) => node.knowledgeBaseId !== knowledgeBaseId)
        for (const [articleId, article] of [...demoStore.articles]) {
            if (article.knowledgeBaseId === knowledgeBaseId) demoStore.articles.delete(articleId)
        }
        return ok({ knowledgeBaseId })
    },

    /* ---------- 目录树 ---------- */
    "POST /kb/node/tree": (body) => {
        const knowledgeBaseId = str(body.knowledgeBaseId)
        if (!kbById(knowledgeBaseId)) return notFound("知识库不存在")
        const roots = nodesOf(knowledgeBaseId, null).map((node) => toTreeNode(node, true))
        return ok({ knowledgeBaseId, roots, totalRootNodes: roots.length })
    },
    "POST /kb/node/roots": (body) => {
        const knowledgeBaseId = str(body.knowledgeBaseId)
        if (!kbById(knowledgeBaseId)) return notFound("知识库不存在")
        const keyword = str(body.keyword).trim().toLowerCase()
        let roots = nodesOf(knowledgeBaseId, null).map((node) => toTreeNode(node, false))
        if (keyword) {
            // 简化版搜索：拍平所有节点按名称过滤（真实实现为服务端全文检索）
            roots = demoStore.nodes
                .filter((node) => node.knowledgeBaseId === knowledgeBaseId && node.name.toLowerCase().includes(keyword))
                .map((node) => toTreeNode(node, false))
        }
        return ok({ knowledgeBaseId, roots, totalRootNodes: roots.length, pageNum: 1, pageSize: 200 })
    },
    "POST /kb/node/children": (body) => {
        const knowledgeBaseId = str(body.knowledgeBaseId)
        const parentId = typeof body.parentId === "string" ? body.parentId : null
        return ok({
            knowledgeBaseId,
            parentId,
            nodes: nodesOf(knowledgeBaseId, parentId).map((node) => toTreeNode(node, false)),
        })
    },
    "POST /kb/node/detail": (body) => {
        const node = demoStore.nodes.find((item) => item.id === str(body.nodeId))
        if (!node) return notFound("节点不存在")
        return ok({
            knowledgeBaseId: node.knowledgeBaseId,
            nodeId: node.id,
            parentId: node.parentId,
            type: node.type,
            name: node.name,
            path: nodePath(node),
            articleId: node.articleId,
        })
    },
    "POST /kb/node/create-folder": (body) => {
        const knowledgeBaseId = str(body.knowledgeBaseId)
        if (!kbById(knowledgeBaseId)) return notFound("知识库不存在")
        const parentId = typeof body.parentId === "string" ? body.parentId : null
        const nodeId = nextNodeId()
        demoStore.nodes.push({
            id: nodeId,
            knowledgeBaseId,
            parentId,
            type: "FOLDER",
            name: str(body.name) || "新建目录",
            articleId: null,
            sortOrder: nodesOf(knowledgeBaseId, parentId).length,
        })
        touchKb(knowledgeBaseId)
        return ok({ nodeId })
    },
    "POST /kb/node/update-folder": (body) => {
        const node = demoStore.nodes.find((item) => item.id === str(body.nodeId))
        if (!node) return notFound("目录不存在")
        node.name = str(body.name) || node.name
        touchKb(node.knowledgeBaseId)
        return ok({ nodeId: node.id })
    },
    "POST /kb/node/delete-folder": (body) => {
        const nodeId = str(body.nodeId)
        const node = demoStore.nodes.find((item) => item.id === nodeId)
        if (!node) return notFound("目录不存在")
        const removeIds = new Set<string>()
        const collect = (id: string) => {
            removeIds.add(id)
            demoStore.nodes.filter((item) => item.parentId === id).forEach((child) => collect(child.id))
        }
        collect(nodeId)
        for (const removed of demoStore.nodes.filter((item) => removeIds.has(item.id))) {
            if (removed.articleId) demoStore.articles.delete(removed.articleId)
        }
        demoStore.nodes = demoStore.nodes.filter((item) => !removeIds.has(item.id))
        touchKb(node.knowledgeBaseId)
        return ok({ nodeId })
    },
    "POST /kb/node/move": (body) => {
        const node = demoStore.nodes.find((item) => item.id === str(body.nodeId))
        if (!node) return notFound("节点不存在")
        const targetParentId = typeof body.targetParentId === "string" ? body.targetParentId : null
        node.parentId = targetParentId
        const siblings = nodesOf(node.knowledgeBaseId, targetParentId).filter((item) => item.id !== node.id)
        const targetIndex = typeof body.targetIndex === "number"
            ? Math.max(0, Math.min(body.targetIndex, siblings.length))
            : siblings.length
        siblings.splice(targetIndex, 0, node)
        siblings.forEach((item, index) => {
            item.sortOrder = index
        })
        touchKb(node.knowledgeBaseId)
        return ok({
            knowledgeBaseId: node.knowledgeBaseId,
            nodeId: node.id,
            parentId: targetParentId,
            orderedNodeIds: siblings.map((item) => item.id),
        })
    },

    /* ---------- 文章 ---------- */
    "POST /kb/article/detail": (body) => {
        const detail = articleDetail(str(body.articleId))
        return detail ? ok(detail) : notFound("文章不存在")
    },
    "POST /kb/article/create": (body) => {
        const knowledgeBaseId = str(body.knowledgeBaseId)
        if (!kbById(knowledgeBaseId)) return notFound("知识库不存在")
        const parentId = typeof body.parentId === "string" ? body.parentId : null
        const articleId = nextArticleId()
        const nodeId = nextNodeId()
        const title = str(body.title) || "未命名文章"
        const now = new Date().toISOString()
        demoStore.nodes.push({
            id: nodeId,
            knowledgeBaseId,
            parentId,
            type: "ARTICLE",
            name: title,
            articleId,
            sortOrder: nodesOf(knowledgeBaseId, parentId).length,
        })
        demoStore.articles.set(articleId, {
            articleId,
            nodeId,
            knowledgeBaseId,
            title,
            contentMd: str(body.contentMd),
            contentJson: typeof body.contentJson === "string" ? body.contentJson : null,
            contentMetaJson: typeof body.contentMetaJson === "string" ? body.contentMetaJson : null,
            tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
            createdAt: now,
            updatedAt: now,
        })
        touchKb(knowledgeBaseId)
        return ok({ articleId, nodeId })
    },
    "POST /kb/article/update": (body) => {
        const article = demoStore.articles.get(str(body.articleId))
        if (!article) return notFound("文章不存在")
        article.title = str(body.title) || article.title
        article.contentMd = str(body.contentMd)
        article.contentJson = typeof body.contentJson === "string" ? body.contentJson : null
        article.contentMetaJson = typeof body.contentMetaJson === "string" ? body.contentMetaJson : null
        article.tags = Array.isArray(body.tags) ? body.tags.map(String) : article.tags
        article.updatedAt = new Date().toISOString()
        const node = demoStore.nodes.find((item) => item.id === article.nodeId)
        if (node) node.name = article.title
        touchKb(article.knowledgeBaseId)
        return ok({ articleId: article.articleId, nodeId: article.nodeId })
    },
    "POST /kb/article/delete": (body) => {
        const article = demoStore.articles.get(str(body.articleId))
        if (!article) return notFound("文章不存在")
        demoStore.articles.delete(article.articleId)
        demoStore.nodes = demoStore.nodes.filter((item) => item.id !== article.nodeId)
        touchKb(article.knowledgeBaseId)
        return ok({ articleId: article.articleId, nodeId: article.nodeId })
    },
    "POST /kb/article/summary/generate": (body) => {
        const article = demoStore.articles.get(str(body.articleId))
        if (!article) return notFound("文章不存在")
        return ok({
            articleId: article.articleId,
            fromCache: false,
            summary: `【演示摘要】《${article.title}》要点：${article.contentMd
                .split("\n")
                .filter((line) => line.startsWith("## "))
                .map((line) => line.slice(3))
                .slice(0, 3)
                .join("；") || "全文围绕单一主题展开，结构简洁"}。部署真实实例后由你配置的模型生成。`,
            generatedAt: new Date().toISOString(),
        })
    },
    "POST /kb/article/public-cache/refresh": (body) =>
        ok({ articleId: str(body.articleId), refreshedAt: new Date().toISOString() }),

    /* ---------- 分享（演示模式仅展示关闭态） ---------- */
    "POST /kb/article/share/info": (body) =>
        ok({
            articleId: str(body.articleId),
            shareCode: null,
            enabled: false,
            hasPassword: false,
            isRepost: false,
        }),
    "POST /kb/article/share/create": () => badRequest("演示模式不生成公开分享链接"),
    "POST /kb/article/share/revoke": (body) =>
        ok({ articleId: str(body.articleId), enabled: false, revokedAt: new Date().toISOString() }),

    /* ---------- 问答 / 模型信息 / 文档库 ---------- */
    "POST /kb/qa/knowledge-base/list": () =>
        ok({
            knowledgeBases: demoStore.knowledgeBases.map((kb) => ({
                id: kb.id,
                name: kb.name,
                description: kb.description,
            })),
        }),
    "POST /kb/qa/model-info": () =>
        ok({
            configId: "demo-model",
            modelId: "petrichor-demo",
            modelName: "演示模型（脚本回放）",
            contextWindow: 128000,
            availableModels: [
                {
                    configId: "demo-model",
                    modelId: "petrichor-demo",
                    modelName: "演示模型（脚本回放）",
                    contextWindow: 128000,
                    isDefault: true,
                },
            ],
        }),
    "GET /doc-library/library/list": () => ok({ libraries: [] }),

    /* ---------- 仪表盘 ---------- */
    "POST /dashboard/overview": () => {
        ensureDemoThreads()
        return ok(buildDashboardOverview())
    },

    /* ---------- 助手（axios 部分；对话流走 demo-chat） ---------- */
    "POST /assistant/thread/list": (body) => demoThreadList(body),
    "POST /assistant/thread/detail": (body) => demoThreadDetail(body),
    "POST /assistant/thread/delete": (body) => demoThreadDelete([str(body.threadId)]),
    "POST /assistant/thread/delete-many": (body) =>
        demoThreadDelete(Array.isArray(body.threadIds) ? body.threadIds.map(String) : []),
    "POST /assistant/plan/patch": (body) => demoPlanPatch(body),
}

export function resolveDemoHandler(key: string): DemoHandler | undefined {
    return handlers[key]
}
