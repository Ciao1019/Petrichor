import type {
  AdminUserItem,
  AgentApiKeyItem,
  AgentApiKeyScope,
  AiBindingResponse,
  AiBindingSlot,
  AiCredentialResponse,
  AiGenerationOptions,
  AiModelResponse,
  AiProviderResponse,
  NotificationItem,
  SystemRole,
} from "@/lib/api"

import type { DemoHandler, DemoHandlerResult } from "./demo-adapter"
import { DEMO_ABOUT_PROFILE, DEMO_PROJECT_SHOWCASE, buildDemoSiteGraph } from "./demo-public-data"
import { DEMO_USER } from "./demo-store"

/* 最新工作台附加数据：覆盖文档库、视觉导入、模型、Agent 与系统管理。
 * 所有写操作只更新当前标签页内存，刷新后恢复种子数据。 */

function ok(data: unknown): DemoHandlerResult {
  return { data }
}

function notFound(msg: string): DemoHandlerResult {
  return { status: 404, data: { code: 404, msg } }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

const agentScopes = new Set<AgentApiKeyScope>([
  "article:write", "article:delete", "doc:read", "qa:read",
  "share:write", "ai:write", "wiki:read", "wiki:write",
])

function toAgentScopes(value: unknown): AgentApiKeyScope[] {
  return strings(value).filter((scope): scope is AgentApiKeyScope => agentScopes.has(scope as AgentApiKeyScope))
}

function now() {
  return new Date().toISOString()
}

const seedTime = new Date(Date.now() - 2 * 86_400_000).toISOString()
const recentTime = new Date(Date.now() - 38 * 60_000).toISOString()

const profile = {
  ...DEMO_USER,
  signature: "Coding / AI / Minecraft",
  createdAt: seedTime,
  updatedAt: recentTime,
}

const sessions = [
  {
    id: "demo-session-current",
    deviceInfo: "Chrome · macOS",
    ip: "127.0.0.1",
    userAgent: "Petrichor Static Demo",
    createdAt: seedTime,
    lastSeenAt: now(),
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    updatedAt: now(),
    current: true,
  },
]

let notifications: NotificationItem[] = [
  {
    id: "demo-notice-1",
    category: "KNOWLEDGE",
    bizType: "WIKI_BUILD",
    bizId: "demo-kb-product",
    title: "工具手册 Wiki 已更新",
    content: "Mole 与 Fastfetch 的概念、来源页和关联关系已完成编译。",
    payload: { knowledgeBaseId: "demo-kb-product" },
    read: false,
    readAt: null,
    createdAt: recentTime,
  },
  {
    id: "demo-notice-2",
    category: "IMPORT",
    bizType: "DOCUMENT_IMPORT",
    bizId: "demo-import-1",
    title: "视觉文档导入完成",
    content: "《Fastfetch 命令速查》共 6 页，已生成知识库文章。",
    payload: { jobId: "demo-import-1" },
    read: true,
    readAt: recentTime,
    createdAt: seedTime,
  },
]

interface DemoLibrary {
  id: string
  name: string
  description: string | null
  color: string | null
  icon: string | null
  documentCount: number
  createdAt: string
  updatedAt: string
}

interface DemoFolder {
  id: string
  libraryId: string
  parentId: string | null
  name: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

interface DemoDocument {
  id: string
  libraryId: string
  folderId: string | null
  fileName: string
  title: string
  fileType: "pdf" | "docx" | "xlsx" | "csv"
  contentType: string | null
  objectKey: string
  sizeBytes: number | null
  pageCount: number | null
  status: "pending" | "parsing" | "ready" | "failed"
  createdAt: string
  updatedAt: string
  charCount?: number | null
  blocks?: unknown[]
  chunks?: Array<{ chunkIndex: number; page: number | null; locator: string | null; text: string }>
  summary?: string | null
}

let libraries: DemoLibrary[] = [
  {
    id: "demo-library-tools",
    name: "工具资料库",
    description: "命令速查、配置样例与系统维护参考资料。",
    color: "blue",
    icon: "folder-code",
    documentCount: 2,
    createdAt: seedTime,
    updatedAt: recentTime,
  },
]
let folders: DemoFolder[] = [
  { id: "demo-folder-cheatsheets", libraryId: "demo-library-tools", parentId: null, name: "命令速查", sortOrder: 0, createdAt: seedTime, updatedAt: recentTime },
  { id: "demo-folder-configs", libraryId: "demo-library-tools", parentId: null, name: "配置样例", sortOrder: 1, createdAt: seedTime, updatedAt: recentTime },
]
let documents: DemoDocument[] = [
  {
    id: "demo-doc-mole",
    libraryId: "demo-library-tools",
    folderId: "demo-folder-cheatsheets",
    fileName: "mole-commands.xlsx",
    title: "Mole 命令速查",
    fileType: "xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    objectKey: "demo/mole-commands.xlsx",
    sizeBytes: 16_384,
    pageCount: 1,
    status: "ready",
    createdAt: seedTime,
    updatedAt: recentTime,
    charCount: 516,
    blocks: [],
    chunks: [
      { chunkIndex: 0, page: 1, locator: "命令速查", text: "| 命令 | 用途 |\n| --- | --- |\n| `mo clean --dry-run` | 预览清理项 |\n| `mo uninstall` | 智能卸载 |\n| `mo analyze` | 磁盘分析 |\n| `mo status` | 系统状态 |\n| `mo purge` | 项目缓存清理 |" },
    ],
    summary: "Mole 六项核心能力与安全清理入口。",
  },
  {
    id: "demo-doc-fastfetch",
    libraryId: "demo-library-tools",
    folderId: "demo-folder-configs",
    fileName: "fastfetch-modules.xlsx",
    title: "Fastfetch 模块清单",
    fileType: "xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    objectKey: "demo/fastfetch-modules.xlsx",
    sizeBytes: 16_384,
    pageCount: 1,
    status: "ready",
    createdAt: seedTime,
    updatedAt: recentTime,
    charCount: 682,
    blocks: [],
    chunks: [
      { chunkIndex: 0, page: 1, locator: "模块", text: "| 模块 | 信息 |\n| --- | --- |\n| `os` | 操作系统 |\n| `cpu` | 处理器 |\n| `gpu` | 图形处理器 |\n| `memory` | 内存使用 |\n| `disk` | 磁盘空间 |\n| `command` | 自定义命令输出 |" },
    ],
    summary: "常用系统、硬件、软件与自定义输出模块。",
  },
]

const importJobs = [
  {
    id: "demo-import-1",
    knowledgeBaseId: "demo-kb-product",
    knowledgeBaseName: "开源命令行工具手册",
    parentNodeId: null,
    parentFolderName: null,
    sourceType: "pdf",
    fileName: "fastfetch-cheatsheet.pdf",
    title: "Fastfetch 命令速查",
    totalPages: 6,
    processedPages: 6,
    donePages: 6,
    failedPages: 0,
    pendingPages: 0,
    status: "completed",
    modelConfigId: "demo-provider-model-chat",
    articleId: "demo-a-fastfetch",
    error: null,
    deadLetteredAt: null,
    replayCount: 0,
    createdAt: seedTime,
    updatedAt: recentTime,
  },
  {
    id: "demo-import-2",
    knowledgeBaseId: "demo-kb-product",
    knowledgeBaseName: "开源命令行工具手册",
    parentNodeId: null,
    parentFolderName: null,
    sourceType: "pdf",
    fileName: "mole-safety-notes.pdf",
    title: "Mole 安全清理笔记",
    totalPages: 4,
    processedPages: 3,
    donePages: 3,
    failedPages: 1,
    pendingPages: 0,
    status: "dead_letter",
    modelConfigId: "demo-provider-model-chat",
    articleId: null,
    error: "第 4 页图像质量过低，演示死信状态",
    deadLetteredAt: recentTime,
    replayCount: 1,
    createdAt: seedTime,
    updatedAt: recentTime,
  },
]

function importPages(jobId: string) {
  const job = importJobs.find((item) => item.id === jobId)
  if (!job) return []
  return Array.from({ length: job.totalPages }, (_, index) => {
    const failed = job.id === "demo-import-2" && index === job.totalPages - 1
    return {
      pageNo: index + 1,
      imageKey: failed ? "demo/mole-page-4.webp" : null,
      extractedBy: failed ? "vision" : "pdf",
      status: failed ? "dead_letter" : "done",
      markdown: failed ? null : `## 第 ${index + 1} 页\n\n已提取的演示 Markdown 内容。`,
      error: failed ? "图像文字置信度不足" : null,
      attemptCount: failed ? 3 : 1,
      maxAttempts: 3,
      nextAttemptAt: recentTime,
      lastError: failed ? "图像文字置信度不足" : null,
      deadLetteredAt: failed ? recentTime : null,
    }
  })
}

const providerCatalog = [
  {
    key: "openai-compatible",
    name: "OpenAI Compatible",
    description: "支持 OpenAI Chat Completions 协议的模型服务。",
    accent: "emerald",
    defaultBaseUrl: "https://api.openai.com/v1",
    baseUrlRequired: true,
    kinds: ["LANGUAGE", "EMBEDDING"],
    apiProtocols: ["chat", "responses"],
    supportsModelListing: true,
    credentialFields: [],
    presetModels: [
      { id: "gpt-5-mini", kind: "LANGUAGE", label: "GPT-5 mini", contextWindow: 400000, capabilities: ["tools", "vision", "reasoning", "json"] },
      { id: "text-embedding-3-small", kind: "EMBEDDING", label: "Embedding 3 Small", contextWindow: 8191, capabilities: [] },
    ],
    docUrl: "https://platform.openai.com/docs",
  },
]
const credentials: AiCredentialResponse[] = [
  { id: "demo-credential", name: "演示凭证", providerKey: "openai-compatible", providerName: "OpenAI Compatible", apiKeyMasked: "sk-demo••••••••", extraKeys: [], usageCount: 1, lastUsedAt: recentTime, createdAt: seedTime, updatedAt: recentTime },
]
const providers: AiProviderResponse[] = [
  { id: "demo-provider", providerKey: "openai-compatible", providerName: "OpenAI Compatible", accent: "emerald", name: "演示模型服务", baseUrl: "https://api.openai.com/v1", effectiveBaseUrl: "https://api.openai.com/v1", supportsModelListing: true, kinds: ["LANGUAGE", "EMBEDDING"], apiProtocols: ["chat", "responses"], apiProtocol: "chat", credentialId: "demo-credential", credentialName: "演示凭证", enabled: true, headers: {}, options: {}, modelCount: 2, enabledModelCount: 2, lastCheckedAt: recentTime, lastCheckStatus: "OK", lastCheckMessage: "演示连接正常", createdAt: seedTime, updatedAt: recentTime },
]
let models: AiModelResponse[] = [
  { id: "demo-model-chat", providerId: "demo-provider", providerName: "演示模型服务", providerKey: "openai-compatible", modelId: "gpt-5-mini", displayName: "GPT-5 mini", kind: "LANGUAGE", contextWindow: 400000, dimensions: null, capabilities: ["tools", "vision", "reasoning", "json"], enabled: true, createdAt: seedTime, updatedAt: recentTime },
  { id: "demo-model-embedding", providerId: "demo-provider", providerName: "演示模型服务", providerKey: "openai-compatible", modelId: "text-embedding-3-small", displayName: "Embedding 3 Small", kind: "EMBEDDING", contextWindow: 8191, dimensions: 1536, capabilities: [], enabled: true, createdAt: seedTime, updatedAt: recentTime },
]
let bindings: AiBindingSlot[] = [
  { purpose: "CHAT", requiredKind: "LANGUAGE", binding: { id: "demo-binding-chat", purpose: "CHAT", modelRefId: "demo-model-chat", modelId: "gpt-5-mini", modelDisplayName: "GPT-5 mini", providerId: "demo-provider", providerName: "演示模型服务", providerKey: "openai-compatible", contextWindow: 400000, dimensions: null, options: { maxTokens: 8192, temperature: 0.3, thinking: "enabled", disableThinkingForTools: true }, updatedAt: recentTime } },
  { purpose: "VISION", requiredKind: "LANGUAGE", binding: { id: "demo-binding-vision", purpose: "VISION", modelRefId: "demo-model-chat", modelId: "gpt-5-mini", modelDisplayName: "GPT-5 mini", providerId: "demo-provider", providerName: "演示模型服务", providerKey: "openai-compatible", contextWindow: 400000, dimensions: null, options: { maxTokens: 8192, temperature: 0.1, thinking: "disabled", disableThinkingForTools: true }, updatedAt: recentTime } },
  { purpose: "DOC_QA", requiredKind: "LANGUAGE", binding: { id: "demo-binding-doc", purpose: "DOC_QA", modelRefId: "demo-model-chat", modelId: "gpt-5-mini", modelDisplayName: "GPT-5 mini", providerId: "demo-provider", providerName: "演示模型服务", providerKey: "openai-compatible", contextWindow: 400000, dimensions: null, options: { maxTokens: 8192, temperature: 0.2, thinking: "enabled", disableThinkingForTools: true }, updatedAt: recentTime } },
  { purpose: "EMBEDDING", requiredKind: "EMBEDDING", binding: { id: "demo-binding-embedding", purpose: "EMBEDDING", modelRefId: "demo-model-embedding", modelId: "text-embedding-3-small", modelDisplayName: "Embedding 3 Small", providerId: "demo-provider", providerName: "演示模型服务", providerKey: "openai-compatible", contextWindow: 8191, dimensions: 1536, options: { maxTokens: null, temperature: null, thinking: null, disableThinkingForTools: false }, updatedAt: recentTime } },
]

let apiKeys: AgentApiKeyItem[] = [
  { id: "demo-key-1", name: "Claude Code 演示", keyPrefix: "pk_demo_4f8a", scopes: ["doc:read", "qa:read", "wiki:read", "article:write"], expiresAt: null, lastUsedAt: recentTime, revokedAt: null, createdAt: seedTime, updatedAt: recentTime },
]
const callLogs = [
  { id: "demo-log-1", apiKeyId: "demo-key-1", apiKeyPrefix: "pk_demo_4f8a", method: "POST", path: "/api/agent/wiki/search", ip: "127.0.0.1", userAgent: "Claude Code", statusCode: 200, durationMs: 86, errorMessage: null, request: { query: "Fastfetch JSONC" }, response: { items: 2 }, createdAt: recentTime },
  { id: "demo-log-2", apiKeyId: "demo-key-1", apiKeyPrefix: "pk_demo_4f8a", method: "POST", path: "/api/agent/article/get", ip: "127.0.0.1", userAgent: "MCP Client", statusCode: 200, durationMs: 42, errorMessage: null, request: { articleId: "demo-a-mole" }, response: { title: "小鼹鼠 Mole" }, createdAt: seedTime },
]

let users: AdminUserItem[] = [
  { id: "demo-user", email: "demo@petrichor.local", systemRole: "SUPER_ADMIN", userType: "LOCAL", username: "cizai", nickname: "CiZai", avatar: null, signature: "Coding / AI / Minecraft", createdAt: seedTime, updatedAt: recentTime },
  { id: "demo-user-2", email: "reader@example.com", systemRole: "USER", userType: "LOCAL", username: "reader", nickname: "演示读者", avatar: null, signature: "Knowledge explorer", createdAt: seedTime, updatedAt: seedTime },
]

let appearance = { publicQaEnabled: true, createdAt: seedTime, updatedAt: recentTime }
let deadLetters = [
  { kind: "document_import", id: "demo-import-2", userId: "demo-user", knowledgeBaseId: "demo-kb-product", articleId: null, title: "Mole 安全清理笔记", attemptCount: 3, maxAttempts: 3, replayCount: 1, lastError: "第 4 页图像文字置信度不足", deadLetteredAt: recentTime, updatedAt: recentTime },
]

function graphOverview() {
  const graph = buildDemoSiteGraph()
  const timestamp = now()
  const nodes = graph.nodes.map((node, index) => ({
    id: node.id,
    nodeKey: node.id,
    parentId: node.parentId,
    parentKey: node.parentId,
    kind: node.kind,
    name: node.label,
    summary: node.summary,
    route: node.route,
    articleId: node.kind === "article" ? (index === 2 ? "demo-a-mole" : "demo-a-fastfetch") : null,
    attributes: node.attributes,
    aliases: node.aliases,
    weight: node.weight,
    sortOrder: index,
    status: "PUBLISHED",
    source: node.kind === "root" ? "SYSTEM" : "AGENT",
    confidence: 0.96,
    locked: node.kind === "root",
    depth: node.parentId == null ? 0 : node.kind === "article" || node.kind === "concept" ? 2 : 1,
    childCount: graph.nodes.filter((item) => item.parentId === node.id).length,
    degree: graph.links.filter((link) => link.source === node.id || link.target === node.id).length,
    updatedAt: timestamp,
  }))
  const conceptualLinks = graph.links.filter((link) => link.kind !== "structure")
  const edges = conceptualLinks.map((link, index) => ({
    id: `demo-admin-edge-${index + 1}`,
    fromNodeId: link.source,
    fromNodeKey: link.source,
    fromNodeName: graph.nodes.find((node) => node.id === link.source)?.label ?? link.source,
    toNodeId: link.target,
    toNodeKey: link.target,
    toNodeName: graph.nodes.find((node) => node.id === link.target)?.label ?? link.target,
    relation: link.relation,
    kind: link.kind,
    attributes: [],
    weight: 1,
    directed: true,
    status: "PUBLISHED",
    source: "AGENT",
    confidence: 0.94,
    locked: false,
    updatedAt: timestamp,
  }))
  const validation = { score: 98, passed: true, nodeCount: nodes.length, edgeCount: edges.length, orphanCount: 0, maxDepth: 2, issues: [], checkedAt: timestamp }
  return {
    nodes,
    edges,
    runs: [{ id: "demo-graph-run", status: "COMPLETED", mode: "FULL", modelName: "GPT-5 mini", articleCount: 2, nodeCount: nodes.length, edgeCount: edges.length, validation, warnings: [], errorMessage: null, startedAt: seedTime, finishedAt: recentTime }],
    nodeOptions: nodes.map((node) => ({ id: node.id, nodeKey: node.nodeKey, name: node.name, kind: node.kind })),
    validation,
    mergeCandidates: [],
    stats: { nodeCount: nodes.length, edgeCount: edges.length, publishedNodes: nodes.length, draftNodes: 0, lockedNodes: 1, manualNodes: 0, articleNodes: 2, conceptNodes: 2 },
  }
}

const handlers: Record<string, DemoHandler> = {
  /* 账户与通知 */
  "GET /auth/profile": () => ok(profile),
  "POST /auth/profile/update": (body) => {
    Object.assign(profile, { nickname: str(body.nickname) || null, avatar: str(body.avatar) || null, signature: str(body.signature) || null, updatedAt: now() })
    Object.assign(DEMO_USER, { nickname: profile.nickname, avatar: profile.avatar })
    return ok(profile)
  },
  "POST /auth/password/change": () => ok({}),
  "GET /auth/sessions": () => ok({ sessions, currentSessionId: "demo-session-current" }),
  "POST /auth/sessions/revoke": () => ok({ success: true }),
  "POST /auth/sessions/revoke-others": () => ok({ success: true, revokedCount: 0 }),
  "GET /notification/summary": () => ok({ unreadCount: notifications.filter((item) => !item.read).length, latestUnreadId: notifications.find((item) => !item.read)?.id ?? null }),
  "POST /notification/list": (body) => {
    const readStatus = str(body.readStatus)
    const rows = notifications.filter((item) => readStatus === "UNREAD" ? !item.read : readStatus === "READ" ? item.read : true)
    return ok({ total: rows.length, rows, code: 200, msg: "ok" })
  },
  "POST /notification/read": (body) => {
    const item = notifications.find((notice) => notice.id === str(body.notificationId))
    if (item) Object.assign(item, { read: true, readAt: now() })
    return ok({ notificationId: str(body.notificationId), readAt: now() })
  },
  "POST /notification/read-all": () => {
    const updatedCount = notifications.filter((item) => !item.read).length
    notifications = notifications.map((item) => ({ ...item, read: true, readAt: item.readAt ?? now() }))
    return ok({ updatedCount, readAt: now() })
  },

  /* 文档库 */
  "GET /doc-library/library/list": () => ok({ libraries }),
  "POST /doc-library/library/save": (body) => {
    const id = str(body.id) || `demo-library-${libraries.length + 1}`
    const existing = libraries.find((item) => item.id === id)
    const next = { id, name: str(body.name) || "新文档库", description: str(body.description) || null, color: str(body.color) || null, icon: str(body.icon) || null, documentCount: existing?.documentCount ?? 0, createdAt: existing?.createdAt ?? now(), updatedAt: now() }
    libraries = existing ? libraries.map((item) => item.id === id ? next : item) : [...libraries, next]
    return ok({ id })
  },
  "POST /doc-library/library/delete": (body) => {
    const id = str(body.id)
    libraries = libraries.filter((item) => item.id !== id)
    folders = folders.filter((item) => item.libraryId !== id)
    documents = documents.filter((item) => item.libraryId !== id)
    return ok({ id, storageCleanup: { deletedObjectKeys: [], failedObjectKeys: [] } })
  },
  "POST /doc-library/folder/list": (body) => ok({ folders: folders.filter((item) => item.libraryId === str(body.libraryId)) }),
  "POST /doc-library/folder/save": (body) => {
    const id = str(body.id) || `demo-folder-${folders.length + 1}`
    const existing = folders.find((item) => item.id === id)
    const next = { id, libraryId: str(body.libraryId), parentId: str(body.parentId) || null, name: str(body.name) || "新文件夹", sortOrder: existing?.sortOrder ?? folders.length, createdAt: existing?.createdAt ?? now(), updatedAt: now() }
    folders = existing ? folders.map((item) => item.id === id ? next : item) : [...folders, next]
    return ok({ id })
  },
  "POST /doc-library/folder/delete": (body) => {
    const id = str(body.id)
    folders = folders.filter((item) => item.id !== id)
    documents = documents.map((item) => item.folderId === id ? { ...item, folderId: null } : item)
    return ok({ id })
  },
  "POST /doc-library/document/list": (body) => ok({ documents: documents.filter((item) => item.libraryId === str(body.libraryId)).map(({ chunks: _chunks, blocks: _blocks, charCount: _charCount, summary: _summary, ...item }) => item) }),
  "POST /doc-library/document/detail": (body) => {
    const document = documents.find((item) => item.id === str(body.id))
    return document ? ok({ document }) : notFound("文档不存在")
  },
  "POST /doc-library/document/delete": (body) => {
    const id = str(body.id)
    const objectKey = documents.find((item) => item.id === id)?.objectKey
    documents = documents.filter((item) => item.id !== id)
    return ok({ id, storageCleanup: { deletedObjectKeys: objectKey ? [objectKey] : [], failedObjectKeys: [] } })
  },
  "POST /upload/presign-get": (body) => {
    const objectKey = str(body.objectKey)
    return ok({ url: objectKey.includes("fastfetch") ? "/demo/fastfetch-modules.xlsx" : "/demo/mole-commands.xlsx" })
  },

  /* 视觉导入 */
  "POST /kb/import/list": (body) => {
    const knowledgeBaseId = str(body.knowledgeBaseId)
    const rows = importJobs.filter((item) => !knowledgeBaseId || item.knowledgeBaseId === knowledgeBaseId)
    return ok({ total: rows.length, rows, code: 200, msg: "ok" })
  },
  "POST /kb/import/detail": (body) => {
    const job = importJobs.find((item) => item.id === str(body.jobId))
    return job ? ok({ job, pages: importPages(job.id) }) : notFound("导入任务不存在")
  },
  "POST /kb/import/retry-page": (body) => ok({ page: importPages(str(body.jobId)).find((item) => item.pageNo === Number(body.pageNo)), processedPages: 4, status: "processing" }),
  "POST /kb/import/retry-failed": () => ok({ retried: 1, status: "processing" }),
  "POST /kb/import/cancel": (body) => ok({ id: str(body.jobId), status: "canceled" }),
  "POST /kb/import/finalize": () => ok({ articleId: "demo-a-mole", nodeId: "demo-node-mole" }),
  "POST /kb/import/delete": (body) => ok({ deleted: strings(body.ids) }),

  /* AI 模型中心 */
  "POST /ai/provider/catalog": () => ok({ items: providerCatalog }),
  "POST /ai/credential/list": () => ok({ items: credentials }),
  "POST /ai/provider/list": () => ok({ items: providers }),
  "POST /ai/model/list": (body) => ok({ items: models.filter((item) => !str(body.providerId) || item.providerId === str(body.providerId)) }),
  "POST /ai/binding/list": () => ok({ items: bindings }),
  "POST /ai/provider/fetch-models": () => ok({ fetched: true, warning: null, items: models.map((item) => ({ modelId: item.modelId, kind: item.kind, label: item.displayName, contextWindow: item.contextWindow, preset: true, saved: true, enabled: item.enabled, dimensions: item.dimensions })) }),
  "POST /ai/provider/test": () => ok({ status: "OK", latencyMs: 128, message: "演示连接测试通过", sample: "Petrichor demo" }),
  "POST /ai/model/probe-dimensions": () => ok({ id: "demo-model-embedding", modelId: "text-embedding-3-small", dimensions: 1536, indexable: true, warning: null }),
  "POST /ai/model/toggle": (body) => {
    models = models.map((item) => item.id === str(body.id) ? { ...item, enabled: Boolean(body.enabled), updatedAt: now() } : item)
    return ok(models.find((item) => item.id === str(body.id)))
  },
  "POST /ai/binding/clear": (body) => {
    bindings = bindings.map((item) => item.purpose === str(body.purpose) ? { ...item, binding: null } : item)
    return ok({})
  },
  "POST /ai/binding/set": (body) => {
    const model = models.find((item) => item.id === str(body.modelRefId))
    if (!model) return notFound("模型不存在")
    const purpose = str(body.purpose) as AiBindingResponse["purpose"]
    const overrides = typeof body.options === "object" && body.options
      ? body.options as Partial<AiGenerationOptions>
      : {}
    const binding: AiBindingResponse = { id: `demo-binding-${purpose.toLowerCase()}`, purpose, modelRefId: model.id, modelId: model.modelId, modelDisplayName: model.displayName, providerId: model.providerId, providerName: model.providerName, providerKey: model.providerKey, contextWindow: model.contextWindow, dimensions: model.dimensions, options: { maxTokens: 8192, temperature: 0.2, thinking: "enabled", disableThinkingForTools: true, ...overrides }, updatedAt: now() }
    bindings = bindings.map((item) => item.purpose === purpose ? { ...item, binding } : item)
    return ok(binding)
  },

  /* Agent 集成 */
  "POST /agent/api-key/list": () => ok({ items: apiKeys }),
  "POST /agent/api-key/create": (body) => {
    const item: AgentApiKeyItem = { id: `demo-key-${apiKeys.length + 1}`, name: str(body.name) || "新 API Key", keyPrefix: "pk_demo_new", scopes: toAgentScopes(body.scopes), expiresAt: str(body.expiresAt) || null, lastUsedAt: null, revokedAt: null, createdAt: now(), updatedAt: now() }
    apiKeys = [...apiKeys, item]
    return ok({ apiKey: "pk_demo_only_shown_once_123456", item })
  },
  "POST /agent/api-key/revoke": (body) => {
    apiKeys = apiKeys.map((item) => item.id === str(body.id) ? { ...item, revokedAt: now(), updatedAt: now() } : item)
    return ok({ item: apiKeys.find((item) => item.id === str(body.id)) })
  },
  "POST /agent/call-log/list": (body) => ok({ items: callLogs.slice(0, Number(body.limit) || 100) }),

  /* 系统管理 */
  "GET /public/appearance": () => ok(appearance),
  "POST /admin/user/list": (body) => {
    const keyword = str(body.keyword).toLowerCase()
    const rows = users.filter((item) => !keyword || item.email.toLowerCase().includes(keyword) || (item.nickname ?? "").toLowerCase().includes(keyword))
    return ok({ total: rows.length, rows, code: 200, msg: "ok" })
  },
  "POST /admin/user/create": (body) => {
    const systemRole: SystemRole = str(body.systemRole) === "SUPER_ADMIN" ? "SUPER_ADMIN" : "USER"
    const item: AdminUserItem = { id: `demo-user-${users.length + 1}`, email: str(body.email), systemRole, userType: "LOCAL", username: str(body.name), nickname: str(body.name), avatar: null, signature: null, createdAt: now(), updatedAt: now() }
    users = [...users, item]
    return ok(item)
  },
  "POST /admin/user/delete": (body) => {
    users = users.filter((item) => item.id !== str(body.userId))
    return ok({})
  },
  "GET /admin/about/profile": () => ok(DEMO_ABOUT_PROFILE),
  "POST /admin/about/profile": (body) => {
    Object.assign(DEMO_ABOUT_PROFILE, body, { updatedAt: now() })
    return ok(DEMO_ABOUT_PROFILE)
  },
  "GET /admin/projects": () => ok(DEMO_PROJECT_SHOWCASE),
  "POST /admin/projects": (body) => {
    Object.assign(DEMO_PROJECT_SHOWCASE, body, { updatedAt: now() })
    return ok(DEMO_PROJECT_SHOWCASE)
  },
  "GET /admin/appearance": () => ok(appearance),
  "POST /admin/appearance": (body) => {
    appearance = { ...appearance, publicQaEnabled: Boolean(body.publicQaEnabled), updatedAt: now() }
    return ok(appearance)
  },
  "GET /admin/site-graph/overview": () => ok(graphOverview()),
  "POST /admin/site-graph/validate": () => ok({ validation: graphOverview().validation, summary: "星图结构完整，可以发布。" }),
  "POST /admin/site-graph/generate": () => {
    const overview = graphOverview()
    return ok({ runId: "demo-graph-run-new", validation: overview.validation, warnings: [], articleCount: 2, nodeCount: overview.nodes.length, edgeCount: overview.edges.length, lockedSkipped: 1, autoAlignedCount: 2, mergeCandidateCount: 0, summary: "已基于 Mole 与 Fastfetch 重新生成演示星图。" })
  },
  "POST /admin/site-graph/publish": () => ok({ publishedNodes: graphOverview().nodes.length, publishedEdges: graphOverview().edges.length, archivedStaleNodes: 0 }),
  "POST /admin/site-graph/unpublish": () => ok({ unpublishedNodes: graphOverview().nodes.length, unpublishedEdges: graphOverview().edges.length }),
  "POST /admin/site-graph/clear": () => ok({ cleared: true }),
  "GET /admin/runtime/dead-letters": () => ok({ items: deadLetters }),
  "POST /admin/runtime/dead-letters/replay": (body) => {
    deadLetters = deadLetters.filter((item) => item.id !== str(body.id))
    return ok({ kind: "document_import", id: str(body.id), status: "pending" })
  },
}

export function resolveLatestDemoHandler(key: string): DemoHandler | undefined {
  return handlers[key]
}
