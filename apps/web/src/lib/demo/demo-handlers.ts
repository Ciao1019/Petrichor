import type { DemoHandler, DemoHandlerResult } from "./demo-adapter"
import type {
    AiModelConfigResponse,
    KBDocument,
    KBDocumentDetail,
    KBDocumentFolder,
    KnowledgeBaseWikiGraphEdge,
    KnowledgeBaseWikiGraphNode,
    KnowledgeBaseWikiPageDetailResponse,
    KnowledgeBaseWikiPageResponse,
} from "@/lib/api"
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

function demoDate(days = 0) {
    const date = new Date()
    date.setDate(date.getDate() - days)
    return date.toISOString()
}

const demoDocumentFolders: KBDocumentFolder[] = [
    { id: "demo-folder-design", knowledgeBaseId: "demo-kb-product", parentId: null, name: "产品设计", sortOrder: 0, createdAt: demoDate(12), updatedAt: demoDate(2) },
    { id: "demo-folder-research", knowledgeBaseId: "demo-kb-product", parentId: null, name: "调研资料", sortOrder: 1, createdAt: demoDate(10), updatedAt: demoDate(1) },
    { id: "demo-folder-react", knowledgeBaseId: "demo-kb-engineering", parentId: null, name: "React", sortOrder: 0, createdAt: demoDate(8), updatedAt: demoDate(2) },
]

function demoDocument(input: Partial<KBDocument> & Pick<KBDocument, "id" | "knowledgeBaseId" | "fileName" | "title" | "fileType">): KBDocument {
    return {
        folderId: null,
        contentType: null,
        objectKey: `uploads/demo-user/${input.fileName}`,
        sizeBytes: 12_480,
        pageCount: null,
        charCount: null,
        chunkCount: 3,
        summary: null,
        status: "ready",
        error: null,
        createdAt: demoDate(5),
        updatedAt: demoDate(1),
        ...input,
    }
}

const demoDocuments: KBDocument[] = [
    demoDocument({ id: "demo-doc-roadmap", knowledgeBaseId: "demo-kb-product", folderId: "demo-folder-design", fileName: "Petrichor-路线图.md", title: "Petrichor 产品路线图", fileType: "md", contentType: "text/markdown", sizeBytes: 8_420, chunkCount: 3 }),
    demoDocument({ id: "demo-doc-architecture", knowledgeBaseId: "demo-kb-product", folderId: "demo-folder-design", fileName: "知识库架构说明.pdf", title: "知识库架构说明", fileType: "pdf", contentType: "application/pdf", sizeBytes: 2_481_300, pageCount: 12, chunkCount: 18 }),
    demoDocument({ id: "demo-doc-feedback", knowledgeBaseId: "demo-kb-product", folderId: "demo-folder-research", fileName: "用户反馈汇总.xlsx", title: "用户反馈汇总", fileType: "xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sizeBytes: 84_200, chunkCount: 6 }),
    demoDocument({ id: "demo-doc-rsc", knowledgeBaseId: "demo-kb-engineering", folderId: "demo-folder-react", fileName: "RSC-心智模型.md", title: "RSC 心智模型", fileType: "md", contentType: "text/markdown", sizeBytes: 6_700, chunkCount: 2 }),
    demoDocument({ id: "demo-doc-ts", knowledgeBaseId: "demo-kb-engineering", fileName: "TypeScript-手册.docx", title: "TypeScript 类型收窄手册", fileType: "docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: 62_000, chunkCount: 8 }),
    demoDocument({ id: "demo-doc-reading", knowledgeBaseId: "demo-kb-reading", fileName: "思考快与慢摘录.md", title: "《思考，快与慢》摘录", fileType: "md", contentType: "text/markdown", sizeBytes: 9_800, chunkCount: 4 }),
]

const documentChunks: Record<string, string[]> = {
    "demo-doc-roadmap": [
        "# Petrichor 产品路线图\n\nPetrichor 将文档、分片、检索与 Wiki 收敛到同一个知识库工作区。",
        "## 文件处理\n\n支持 Markdown、PDF、Word 与 Excel。上传后按照知识库配置完成切片，并保留原文件与定位信息。",
        "## Wiki\n\n从文件分片提炼主题页面，通过 [[页面双链]] 组织引用关系；它不是实体关系型知识图谱。",
    ],
    "demo-doc-rsc": ["# RSC 心智模型\n\nServer Component 的代码不会进入客户端 bundle。", "需要交互的区域使用 Client Component，并保持边界 props 可序列化。"],
    "demo-doc-reading": ["# 系统 1 与系统 2\n\n快速直觉擅长日常判断，但容易受到锚定和可得性影响。", "# 产品启发\n\n设计信息层级时，要降低用户调用系统 2 的认知成本。"],
}

function documentDetail(document: KBDocument): KBDocumentDetail {
    const texts = documentChunks[document.id] ?? [
        `${document.title} 的解析摘要。`,
        "这是演示模式生成的分片，可在真实实例中查看对应页码、工作表或段落定位。",
    ]
    return {
        ...document,
        charCount: texts.reduce((total, text) => total + text.length, 0),
        blocks: [],
        chunks: texts.map((text, index) => ({
            id: `${document.id}-chunk-${index}`,
            chunkIndex: index,
            page: document.fileType === "pdf" ? index + 1 : null,
            locator: document.fileType === "xlsx" ? "反馈汇总" : document.fileType === "md" ? "Markdown" : null,
            contextHeader: null,
            startOffset: null,
            endOffset: null,
            text,
            charCount: text.length,
            tokenEstimate: Math.ceil(text.length / 2),
        })),
        summary: `${document.title} 的演示摘要。`,
        extractedText: texts.join("\n"),
    }
}

const demoWikiPages: KnowledgeBaseWikiPageDetailResponse[] = [
    {
        id: "demo-wiki-index", knowledgeBaseId: "demo-kb-product", pageKey: "index", title: "Petrichor 产品手记 Wiki", kind: "index",
        contentMd: "# Petrichor 产品手记 Wiki\n\n这是从知识库文件分片整理出的主题入口。\n\n- [[文件处理流程]]\n- [[切片与检索]]\n- [[Wiki 页面双链]]",
        frontmatter: {}, summary: "从原始文件进入可检索、可引用 Wiki 的总入口。", contentHash: "demo-index", categoryPath: [], sortOrder: 0, version: 1, archivedAt: null, createdAt: demoDate(2), updatedAt: demoDate(),
		documentRefs: [], links: [
            { id: "demo-link-index-ingest", toPageKey: "file-ingestion", linkType: "index" },
            { id: "demo-link-index-chunk", toPageKey: "chunk-retrieval", linkType: "index" },
            { id: "demo-link-index-wiki", toPageKey: "wiki-links", linkType: "index" },
        ],
    },
    {
        id: "demo-wiki-ingest", knowledgeBaseId: "demo-kb-product", pageKey: "file-ingestion", title: "文件处理流程", kind: "concept",
        contentMd: "# 文件处理流程\n\n文件上传后保留原件，同时抽取文本与版面定位，再按知识库规则切片。\n\n## 支持格式\n\nMarkdown、PDF、Word、Excel 与 CSV。\n\n## 关联\n\n处理结果进入 [[切片与检索]]，也可继续构建 [[Wiki 页面双链]]。",
        frontmatter: {}, summary: "统一处理多种知识文件，并保留原文浏览能力。", contentHash: "demo-ingest", categoryPath: ["产品流程"], sortOrder: 0, version: 1, archivedAt: null, createdAt: demoDate(2), updatedAt: demoDate(),
		documentRefs: [{ id: "demo-ref-ingest", documentId: "demo-doc-roadmap", documentTitle: "Petrichor 产品路线图", fileName: "Petrichor-路线图.md", chunkIndexes: [0, 1], note: "源文件分片" }],
        links: [{ id: "demo-link-ingest-chunk", toPageKey: "chunk-retrieval", linkType: "related" }, { id: "demo-link-ingest-wiki", toPageKey: "wiki-links", linkType: "related" }],
    },
    {
        id: "demo-wiki-chunk", knowledgeBaseId: "demo-kb-product", pageKey: "chunk-retrieval", title: "切片与检索", kind: "concept",
        contentMd: "# 切片与检索\n\n每个知识库可以独立选择递归语义、段落或固定长度切片，并绑定 Embedding 与 Rerank 模型。",
        frontmatter: {}, summary: "知识库级切片、向量化和重排配置。", contentHash: "demo-chunk", categoryPath: ["检索能力"], sortOrder: 0, version: 1, archivedAt: null, createdAt: demoDate(2), updatedAt: demoDate(),
		documentRefs: [{ id: "demo-ref-chunk", documentId: "demo-doc-roadmap", documentTitle: "Petrichor 产品路线图", fileName: "Petrichor-路线图.md", chunkIndexes: [1], note: "源文件分片" }],
        links: [{ id: "demo-link-chunk-wiki", toPageKey: "wiki-links", linkType: "related" }],
    },
    {
        id: "demo-wiki-links", knowledgeBaseId: "demo-kb-product", pageKey: "wiki-links", title: "Wiki 页面双链", kind: "concept",
        contentMd: "# Wiki 页面双链\n\n页面之间以显式引用形成出链与反向链接。双链图只表达 Wiki 页面关系，不构建实体、属性和三元组。",
        frontmatter: {}, summary: "来源可追溯的 Wiki 页面引用网络。", contentHash: "demo-wiki", categoryPath: ["检索能力"], sortOrder: 0, version: 1, archivedAt: null, createdAt: demoDate(1), updatedAt: demoDate(),
		documentRefs: [{ id: "demo-ref-wiki", documentId: "demo-doc-roadmap", documentTitle: "Petrichor 产品路线图", fileName: "Petrichor-路线图.md", chunkIndexes: [2], note: "源文件分片" }],
        links: [{ id: "demo-link-wiki-ingest", toPageKey: "file-ingestion", linkType: "related" }],
    },
]

function wikiPagesOf(knowledgeBaseId: string): KnowledgeBaseWikiPageResponse[] {
    return demoWikiPages.filter((page) => page.knowledgeBaseId === knowledgeBaseId)
}

function wikiGraphOf(knowledgeBaseId: string): { nodes: KnowledgeBaseWikiGraphNode[]; edges: KnowledgeBaseWikiGraphEdge[] } {
    const pages = demoWikiPages.filter((page) => page.knowledgeBaseId === knowledgeBaseId)
    const edges = pages.flatMap((page) => page.links.map((link) => ({ source: page.pageKey, target: link.toPageKey, linkType: link.linkType })))
    const degree = new Map<string, number>()
    edges.forEach((edge) => {
        degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
        degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
    })
    return { nodes: pages.map((page) => ({ pageKey: page.pageKey, title: page.title, kind: page.kind, summary: page.summary, linkCount: degree.get(page.pageKey) ?? 0 })), edges }
}

function ensureDemoWiki(knowledgeBaseId: string, knowledgeBaseName: string) {
    if (demoWikiPages.some((page) => page.knowledgeBaseId === knowledgeBaseId)) return
    const documents = demoDocuments.filter((document) => document.knowledgeBaseId === knowledgeBaseId)
    const indexPage: KnowledgeBaseWikiPageDetailResponse = {
        id: `demo-wiki-${knowledgeBaseId}-index`, knowledgeBaseId, pageKey: "index", title: `${knowledgeBaseName} Wiki`, kind: "index",
        contentMd: `# ${knowledgeBaseName} Wiki\n\n${documents.map((document) => `- [[document-${document.id}]] ${document.title}`).join("\n")}`,
        frontmatter: {}, summary: `从 ${documents.length} 个知识文件整理出的 Wiki 入口。`, contentHash: `demo-${knowledgeBaseId}-index`, categoryPath: [], sortOrder: 0, version: 1,
		archivedAt: null, createdAt: demoDate(), updatedAt: demoDate(), documentRefs: [],
        links: documents.map((document, index) => ({ id: `demo-wiki-link-${knowledgeBaseId}-${index}`, toPageKey: `document-${document.id}`, linkType: "index" })),
    }
    demoWikiPages.push(indexPage)
    documents.forEach((document, index) => {
        demoWikiPages.push({
            id: `demo-wiki-${knowledgeBaseId}-${index}`, knowledgeBaseId, pageKey: `summary/${document.id}`, title: document.title, kind: "summary",
            contentMd: `# ${document.title}\n\n${documentDetail(document).summary}\n\n## 来源\n\n- ${document.fileName}`,
            frontmatter: {}, summary: documentDetail(document).summary, contentHash: `demo-${document.id}`, categoryPath: ["文档摘要"], sortOrder: 0, version: 1,
			archivedAt: null, createdAt: demoDate(), updatedAt: demoDate(),
            documentRefs: [{ id: `demo-ref-${document.id}`, documentId: document.id, documentTitle: document.title, fileName: document.fileName, chunkIndexes: documentDetail(document).chunks.map((chunk) => chunk.chunkIndex), note: "源文件分片" }],
            links: index + 1 < documents.length ? [{ id: `demo-related-${document.id}`, toPageKey: `document-${documents[index + 1]?.id}`, linkType: "related" }] : [],
        })
    })
}

const demoModels: AiModelConfigResponse[] = [
    { id: "demo-chat", configType: "CHAT", protocol: "OPENAI_COMPAT", name: "通用对话模型", baseUrl: null, hasApiKey: true, apiKeyMasked: "sk-****demo", model: "demo-chat", enabled: true, isDefault: true, extraJson: null, createdAt: demoDate(10), updatedAt: demoDate(1) },
    { id: "demo-embedding", configType: "EMBEDDING", protocol: "OPENAI_COMPAT", name: "中文向量模型", baseUrl: null, hasApiKey: true, apiKeyMasked: "sk-****demo", model: "demo-embedding", enabled: true, isDefault: true, extraJson: null, createdAt: demoDate(10), updatedAt: demoDate(1) },
    { id: "demo-rerank", configType: "RERANK", protocol: "SILICONFLOW", name: "检索重排模型", baseUrl: null, hasApiKey: true, apiKeyMasked: "sk-****demo", model: "demo-reranker", enabled: true, isDefault: true, extraJson: null, createdAt: demoDate(10), updatedAt: demoDate(1) },
]

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
            chunkStrategy: "auto" as const,
            chunkSize: 700,
            chunkOverlap: 100,
            chunkSeparators: ["\n\n", "\n", "。"], enableParentChild: false, parentChunkSize: 0, childChunkSize: 0,
            chatModelId: null,
            embeddingModelId: null,
            rerankModelId: null,
            wikiEnabled: false,
            documentCount: 0,
            wikiPageCount: 0,
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
        if (body.chunkStrategy === "recursive" || body.chunkStrategy === "paragraph" || body.chunkStrategy === "fixed") kb.chunkStrategy = body.chunkStrategy
        if (typeof body.chunkSize === "number") kb.chunkSize = body.chunkSize
        if (typeof body.chunkOverlap === "number") kb.chunkOverlap = body.chunkOverlap
        if (Array.isArray(body.chunkSeparators)) kb.chunkSeparators = body.chunkSeparators.map(String).filter(Boolean)
        if (body.chatModelId === null || typeof body.chatModelId === "string") kb.chatModelId = body.chatModelId
        if (body.embeddingModelId === null || typeof body.embeddingModelId === "string") kb.embeddingModelId = body.embeddingModelId
        if (body.rerankModelId === null || typeof body.rerankModelId === "string") kb.rerankModelId = body.rerankModelId
        if (typeof body.wikiEnabled === "boolean") kb.wikiEnabled = body.wikiEnabled
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
        for (let index = demoDocuments.length - 1; index >= 0; index -= 1) {
            if (demoDocuments[index]?.knowledgeBaseId === knowledgeBaseId) demoDocuments.splice(index, 1)
        }
        for (let index = demoDocumentFolders.length - 1; index >= 0; index -= 1) {
            if (demoDocumentFolders[index]?.knowledgeBaseId === knowledgeBaseId) demoDocumentFolders.splice(index, 1)
        }
        for (let index = demoWikiPages.length - 1; index >= 0; index -= 1) {
            if (demoWikiPages[index]?.knowledgeBaseId === knowledgeBaseId) demoWikiPages.splice(index, 1)
        }
        return ok({ knowledgeBaseId, storageCleanup: { deletedObjectKeys: [], failedObjectKeys: [] } })
    },

    /* ---------- 知识库文件 / 文件夹 ---------- */
    "POST /kb/document-folder/list": (body) =>
        ok({ folders: demoDocumentFolders.filter((folder) => folder.knowledgeBaseId === str(body.knowledgeBaseId)) }),
    "POST /kb/document-folder/save": (body) => {
        const knowledgeBaseId = str(body.knowledgeBaseId)
        if (!kbById(knowledgeBaseId)) return notFound("知识库不存在")
        const id = str(body.id)
        const existing = demoDocumentFolders.find((folder) => folder.id === id)
        if (existing) {
            existing.name = str(body.name) || existing.name
            existing.parentId = typeof body.parentId === "string" ? body.parentId : null
            existing.updatedAt = demoDate()
            return ok({ id: existing.id })
        }
        const folder: KBDocumentFolder = {
            id: `demo-folder-${demoDocumentFolders.length + 1}`,
            knowledgeBaseId,
            parentId: typeof body.parentId === "string" ? body.parentId : null,
            name: str(body.name) || "新建目录",
            sortOrder: demoDocumentFolders.filter((item) => item.knowledgeBaseId === knowledgeBaseId).length,
            createdAt: demoDate(),
            updatedAt: demoDate(),
        }
        demoDocumentFolders.push(folder)
        return ok({ id: folder.id })
    },
    "POST /kb/document-folder/delete": (body) => {
        const id = str(body.id)
        const index = demoDocumentFolders.findIndex((folder) => folder.id === id)
        if (index < 0) return notFound("目录不存在")
        demoDocumentFolders.splice(index, 1)
        demoDocuments.forEach((document) => {
            if (document.folderId === id) document.folderId = null
        })
        return ok({ id })
    },
    "POST /kb/document/list": (body) =>
        ok({ documents: demoDocuments.filter((document) => document.knowledgeBaseId === str(body.knowledgeBaseId)) }),
    "POST /kb/document/register": (body) => {
        const knowledgeBaseId = str(body.knowledgeBaseId)
        const kb = kbById(knowledgeBaseId)
        if (!kb) return notFound("知识库不存在")
        const id = `demo-doc-${Date.now()}`
        const chunks = Array.isArray(body.chunks)
            ? body.chunks.flatMap((value) => {
                if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string") return []
                return [value.text]
            })
            : []
        const document = demoDocument({
            id,
            knowledgeBaseId,
            folderId: typeof body.folderId === "string" ? body.folderId : null,
            fileName: str(body.fileName) || "演示文件.md",
            title: str(body.title) || str(body.fileName) || "演示文件",
            fileType: (str(body.fileType) || "md") as KBDocument["fileType"],
            contentType: typeof body.contentType === "string" ? body.contentType : null,
            objectKey: str(body.objectKey) || `uploads/demo-user/${id}`,
            sizeBytes: typeof body.sizeBytes === "number" ? body.sizeBytes : null,
            pageCount: typeof body.pageCount === "number" ? body.pageCount : null,
            chunkCount: chunks.length,
            createdAt: demoDate(),
            updatedAt: demoDate(),
        })
        demoDocuments.unshift(document)
        documentChunks[id] = chunks
        kb.documentCount = demoDocuments.filter((item) => item.knowledgeBaseId === knowledgeBaseId).length
        if (kb.wikiEnabled) {
            ensureDemoWiki(knowledgeBaseId, kb.name)
            kb.wikiPageCount = wikiPagesOf(knowledgeBaseId).length
        }
        kb.updatedAt = demoDate()
        return ok({ id })
    },
    "POST /kb/document/detail": (body) => {
        const document = demoDocuments.find((item) => item.id === str(body.id))
        return document ? ok({ document: documentDetail(document) }) : notFound("文件不存在")
    },
    "POST /kb/document/move": (body) => {
        const document = demoDocuments.find((item) => item.id === str(body.id))
        if (!document) return notFound("文件不存在")
        document.folderId = typeof body.folderId === "string" ? body.folderId : null
        document.updatedAt = demoDate()
        return ok({ id: document.id })
    },
    "POST /kb/document/delete": (body) => {
        const id = str(body.id)
        const index = demoDocuments.findIndex((document) => document.id === id)
        if (index < 0) return notFound("文件不存在")
        const [document] = demoDocuments.splice(index, 1)
        delete documentChunks[id]
        if (document) {
            const kb = kbById(document.knowledgeBaseId)
            if (kb) kb.documentCount = demoDocuments.filter((item) => item.knowledgeBaseId === document.knowledgeBaseId).length
        }
        return ok({ id, storageCleanup: { deletedObjectKeys: document ? [document.objectKey] : [], failedObjectKeys: [] } })
    },

    /* ---------- 文件 Wiki 与页面双链 ---------- */
    "POST /kb/wiki/page/list": (body) => {
        const knowledgeBaseId = str(body.knowledgeBaseId)
        return ok({ knowledgeBaseId, pages: wikiPagesOf(knowledgeBaseId) })
    },
    "POST /kb/wiki/page/detail": (body) => {
        const page = demoWikiPages.find((item) => item.knowledgeBaseId === str(body.knowledgeBaseId) && item.pageKey === str(body.pageKey))
        return page ? ok(page) : notFound("Wiki 页面不存在")
    },
    "POST /kb/wiki/graph": (body) => ok(wikiGraphOf(str(body.knowledgeBaseId))),
    "POST /kb/wiki/document-ingest": (body) => {
        const knowledgeBaseId = str(body.knowledgeBaseId)
        const kb = kbById(knowledgeBaseId)
        if (!kb) return notFound("知识库不存在")
        if (!demoDocuments.some((document) => document.knowledgeBaseId === knowledgeBaseId)) return badRequest("知识库里还没有可构建 Wiki 的文件")
        ensureDemoWiki(knowledgeBaseId, kb.name)
        const pages = wikiPagesOf(knowledgeBaseId)
        kb.wikiPageCount = pages.length
        kb.updatedAt = demoDate()
        return ok({ knowledgeBaseId, pages, indexPage: pages.find((page) => page.kind === "index") ?? pages[0], warnings: ["演示模式使用本地规则生成，真实实例会优先调用知识库绑定的对话模型"] })
    },

    /* ---------- 模型与文件预览 ---------- */
    "POST /ai/config/list": (body) => {
        const rows = demoModels.filter((model) => !body.configType || model.configType === body.configType)
        return ok({ total: rows.length, rows, code: 200, msg: "ok" })
    },
    "POST /upload/presign-get": (body) => ok({ url: `data:text/plain;charset=utf-8,${encodeURIComponent(`演示文件：${str(body.objectKey)}`)}` }),

    /* ---------- 目录树 ---------- */
    "POST /kb/node/tree": (body) => {
        const knowledgeBaseId = str(body.knowledgeBaseId)
        if (!kbById(knowledgeBaseId)) return notFound("知识库不存在")
        const roots = nodesOf(knowledgeBaseId, null).map((node) => toTreeNode(node, true))
        return ok({ knowledgeBaseId, roots, totalFolders: roots.length })
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
        return ok({ knowledgeBaseId, roots, totalFolders: roots.length, pageNum: 1, pageSize: 200 })
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

    /* ---------- 问答 / 模型信息 ---------- */
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
