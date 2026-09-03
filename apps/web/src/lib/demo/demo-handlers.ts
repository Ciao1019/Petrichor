import type { DemoHandler, DemoHandlerResult } from "./demo-adapter"
import { resolveLatestDemoHandler } from "./demo-latest-handlers"
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
import {
    DEMO_ABOUT_PROFILE,
    DEMO_PROJECT_SHOWCASE,
    buildDemoPublicArticleList,
    buildDemoSiteGraph,
    findDemoPublicArticle,
    searchDemoPublicArticles,
} from "./demo-public-data"
import {
    demoPublicWikiGraph,
    demoPublicWikiKnowledgeBases,
    demoPublicWikiPage,
    demoPublicWikiPageList,
    demoWikiDashboard,
    demoWikiEmbedding,
    demoWikiGraph,
    demoWikiGuide,
    demoWikiIngest,
    demoWikiLint,
    demoWikiPageDetail,
    demoWikiPages,
    demoWikiTree,
} from "./demo-wiki"
import { demoPublicSearch } from "./demo-public-search"

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

function num(value: unknown, fallback: number): number {
    const parsed = typeof value === "number" ? value : Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
}

const handlers: Record<string, DemoHandler> = {
    /* ---------- 会话 / 用户 ---------- */
    "GET /auth/setup/status": () => ok({ required: false }),
    "GET /auth/me": () => ok(DEMO_USER),
    "GET /auth/profile": () => ok(DEMO_USER),
    "POST /auth/logout": () => ok({}),
    "GET /notification/summary": () => ok({ unreadCount: 0, latestUnreadId: null }),
    "POST /notification/list": () => ok({ total: 0, rows: [], code: 200, msg: "ok" }),

    /* ---------- 公开站：文章、搜索、外观与展示页 ---------- */
    "GET /public/article/list": () => ok({ items: buildDemoPublicArticleList() }),
    "GET /public/article/share/detail": (body) => {
        const article = findDemoPublicArticle(str(body.shareCode))
        return article ? ok(article) : notFound("演示文章不存在")
    },
    "POST /public/article/share/detail": (body) => {
        const article = findDemoPublicArticle(str(body.shareCode))
        return article ? ok(article) : notFound("演示文章不存在")
    },
    "GET /public/article/search": (body) => ok(searchDemoPublicArticles(
        str(body.q),
        num(body.offset, 0),
        num(body.limit, 20),
    )),
    "GET /public/search": (body) => ok(demoPublicSearch({
        q: str(body.q),
        mode: body.mode === "fulltext" || body.mode === "lexical" || body.mode === "semantic" ? body.mode : "hybrid",
        type: body.type === "article" || body.type === "wiki" ? body.type : "all",
        kb: str(body.kb) || undefined,
        tag: str(body.tag) || undefined,
        offset: num(body.offset, 0),
        limit: num(body.limit, 20),
    })),
    "GET /public/appearance": () => ok({ publicQaEnabled: true }),
    "GET /public/about/profile": () => ok(DEMO_ABOUT_PROFILE),
    "GET /public/projects": () => ok(DEMO_PROJECT_SHOWCASE),
    "GET /public/site-graph": () => ok(buildDemoSiteGraph()),
    "GET /public/wiki/knowledge-bases": () => ok({ items: demoPublicWikiKnowledgeBases() }),
    "GET /public/wiki/pages": (body) => {
        const result = demoPublicWikiPageList({
            knowledgeBaseId: str(body.knowledgeBaseId),
            q: str(body.q),
            kind: str(body.kind),
            limit: num(body.limit, 50),
            offset: num(body.offset, 0),
        })
        return result ? ok(result) : notFound("演示知识库不存在")
    },
    "GET /public/wiki/page": (body) => {
        const page = demoPublicWikiPage(str(body.pageKey), str(body.knowledgeBaseId) || undefined)
        return page ? ok(page) : notFound("演示 Wiki 页面不存在")
    },
    "GET /public/wiki/graph": (body) => {
        const graph = demoPublicWikiGraph(str(body.knowledgeBaseId))
        return graph ? ok(graph) : notFound("演示 Wiki 图谱不存在")
    },
    "GET /assistant/wiki/page": (body) => {
        const page = demoPublicWikiPage(str(body.pageKey))
        return page ? ok(page) : notFound("演示 Wiki 页面不存在")
    },

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
    "POST /kb/knowledge/build": (body) => {
        const knowledgeBaseId = str(body.knowledgeBaseId)
        const articleId = str(body.articleId)
        const article = demoStore.articles.get(articleId)
        if (!article || article.knowledgeBaseId !== knowledgeBaseId) return notFound("文章不存在")
        const sourcePage = demoWikiPages(knowledgeBaseId).find((page) => page.kind === "source")
        if (!sourcePage) return badRequest("演示知识库暂无 Wiki 数据")
        const now = new Date().toISOString()
        return ok({
            id: `demo-build-${articleId}`,
            userId: DEMO_USER.id,
            knowledgeBaseId,
            articleId,
            status: "completed",
            progress: { percent: 100, phase: "completed", message: "知识构建完成", updatedAt: now },
            result: {
                articleId,
                knowledgeBaseId,
                fromCache: true,
                chunkCount: 6,
                recommendedQuestionCount: 4,
                entityCount: 2,
                conceptCount: 3,
                sourcePage,
                warnings: [],
            },
            error: null,
            startedAt: now,
            completedAt: now,
            createdAt: now,
            updatedAt: now,
        })
    },

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

    /* ---------- Wiki 知识空间 / 图谱 ---------- */
    "POST /kb/wiki/page/list": (body) => {
        const knowledgeBaseId = str(body.knowledgeBaseId)
        return ok({ knowledgeBaseId, pages: demoWikiPages(knowledgeBaseId) })
    },
    "POST /kb/wiki/page/detail": (body) => {
        const detail = demoWikiPageDetail(str(body.knowledgeBaseId), str(body.pageKey))
        return detail ? ok(detail) : notFound("Wiki 页面不存在")
    },
    "POST /kb/wiki/dashboard": (body) => ok(demoWikiDashboard(str(body.knowledgeBaseId))),
    "POST /kb/wiki/tree": (body) => ok(demoWikiTree(str(body.knowledgeBaseId), str(body.articleId))),
    "POST /kb/wiki/graph": (body) => ok(demoWikiGraph(str(body.knowledgeBaseId))),
    "POST /kb/wiki/lint": (body) => ok(demoWikiLint(str(body.knowledgeBaseId))),
    "POST /kb/wiki/guide": (body) => ok(demoWikiGuide(str(body.knowledgeBaseId))),
    "POST /kb/wiki/guide/save": (body) => ok(demoWikiGuide(str(body.knowledgeBaseId), str(body.contentMd))),
    "POST /kb/wiki/ingest": (body) => {
        const result = demoWikiIngest(str(body.knowledgeBaseId))
        return result ? ok(result) : notFound("知识库暂无可编译内容")
    },
    "POST /kb/wiki/embedding/run": (body) => ok(demoWikiEmbedding(str(body.knowledgeBaseId))),
    "POST /kb/wiki/export": () => ok(new Blob(["Petrichor 静态演示站：导出内容为示意数据。"], { type: "text/plain" })),
    "POST /kb/wiki/skill-pack": () => ok(new Blob(["Petrichor Demo Skill Pack"], { type: "text/plain" })),

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
    return resolveLatestDemoHandler(key) ?? handlers[key]
}
