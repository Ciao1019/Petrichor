import { createHash } from "node:crypto"
import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { callChatCompletion } from "@/server/ai/generation"
import { embedQuery, embedTexts, hasEmbeddingConfig } from "@/server/ai/embedding"
import { getDb, isSqliteDatabase } from "@/server/db/client"
import {
    knowledgeBaseArticles,
    knowledgeBaseWikiTreeNodes,
    type KnowledgeBaseArticleRecord,
    type KnowledgeBaseWikiTreeNodeRecord,
} from "@/server/db/schema"
import { badRequest } from "@/server/http/response"
import { scoreSearchFields } from "@/server/kb/search-terms"
import {
    assertKnowledgeBaseOwner,
    extractAgentImageReferences,
    formatDate,
} from "@/server/kb/wiki-agent-logic"

type Db = ReturnType<typeof getDb>

// PageIndex 式的「目录树 + 推理式检索」：把源文档按 Markdown 标题拆成层级节点，
// 每个节点带一句话摘要 + 原文片段，检索时让 LLM 在目录上推理导航选节点，
// 而不是只靠关键词子串匹配。完全自托管，不依赖向量库与外部服务。

/** parseMarkdownTree 输出的纯结构节点，不含 DB / 文章字段，便于单测。 */
export interface ParsedTreeNode {
    position: number
    depth: number
    title: string
    parentPosition: number | null
    contentMd: string
    startLine: number
    endLine: number
}

const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const FENCE_PATTERN = /^\s*(```|~~~)/

/**
 * 把 Markdown 解析成层级目录树。
 * - 第一个标题之前的引言归入 depth=0 的根节点（标题用 rootTitle）。
 * - 每个标题成为一个节点，正文为该标题行之后、下一个标题行之前的内容。
 * - 围栏代码块（``` / ~~~）内的 `#` 不当作标题。
 * - parentPosition 指向最近的、层级更浅的祖先节点。
 */
export function parseMarkdownTree(markdown: string, rootTitle: string): ParsedTreeNode[] {
    const lines = (markdown ?? "").split(/\r?\n/)
    const headings: Array<{ level: number; title: string; line: number }> = []
    let inFence = false
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (FENCE_PATTERN.test(line)) {
            inFence = !inFence
            continue
        }
        if (inFence) continue
        const match = line.match(HEADING_PATTERN)
        if (match) {
            headings.push({ level: match[1].length, title: match[2].trim(), line: index })
        }
    }

    const preambleEnd = headings.length > 0 ? headings[0].line : lines.length
    const rootBody = lines.slice(0, preambleEnd).join("\n").trim()
    const nodes: ParsedTreeNode[] = [{
        position: 0,
        depth: 0,
        title: rootTitle.trim() || "（无标题文档）",
        parentPosition: null,
        contentMd: rootBody,
        startLine: 1,
        endLine: preambleEnd,
    }]

    // 维护 (depth -> position) 的祖先栈，确定每个标题节点的父节点。
    const ancestors: Array<{ depth: number; position: number }> = [{ depth: 0, position: 0 }]
    for (let index = 0; index < headings.length; index += 1) {
        const heading = headings[index]
        const bodyStart = heading.line + 1
        const bodyEnd = index + 1 < headings.length ? headings[index + 1].line : lines.length
        const position = index + 1
        while (ancestors.length > 0 && ancestors[ancestors.length - 1].depth >= heading.level) {
            ancestors.pop()
        }
        const parentPosition = ancestors.length > 0 ? ancestors[ancestors.length - 1].position : 0
        nodes.push({
            position,
            depth: heading.level,
            title: heading.title || `章节 ${position}`,
            parentPosition,
            contentMd: lines.slice(bodyStart, bodyEnd).join("\n").trim(),
            startLine: heading.line + 1,
            endLine: bodyEnd,
        })
        ancestors.push({ depth: heading.level, position })
    }

    return nodes
}

function treeNodeKey(articleId: number, position: number) {
    return `a${articleId}-${position}`
}

export function extractArticleIdFromTreeNodeKey(nodeKey: string): number | null {
    const match = nodeKey.match(/^a(\d+)-\d+$/)
    return match ? Number(match[1]) : null
}

function hashTree(nodes: ParsedTreeNode[]) {
    const fingerprint = nodes
        .map((node) => `${node.position}|${node.depth}|${node.title}|${node.contentMd}`)
        .join("\n--\n")
    return createHash("sha256").update(fingerprint).digest("hex")
}

function estimateTokens(text: string) {
    if (!text) return 0
    let tokens = 0
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0
        // 中日韩字符按 1 token 估算，其余按约 1/4 token。
        if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af)) {
            tokens += 1
        } else {
            tokens += 0.25
        }
    }
    return Math.max(0, Math.ceil(tokens))
}

function localSummary(node: ParsedTreeNode, maxLength = 120) {
    const text = (node.contentMd || node.title)
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
        .replace(/\[([^\]]*)]\([^)]*\)/g, "$1")
        .replace(/[#>*_\-~|]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    if (!text) return node.title
    return text.length <= maxLength ? text : `${text.slice(0, maxLength).trim()}...`
}

const MAX_NODES_FOR_LLM_SUMMARY = 40
const MAX_BODY_CHARS_FOR_SUMMARY = 400

/** 用一次 LLM 调用批量生成各节点摘要；失败或节点过多时退回本地摘要。 */
async function generateNodeSummaries(input: {
    userId: number
    knowledgeBaseName: string
    articleTitle: string
    nodes: ParsedTreeNode[]
}): Promise<Map<number, string>> {
    const result = new Map<number, string>()
    const summarizable = input.nodes.filter((node) => node.contentMd.trim().length > 0)
    if (summarizable.length === 0 || summarizable.length > MAX_NODES_FOR_LLM_SUMMARY) {
        for (const node of input.nodes) result.set(node.position, localSummary(node))
        return result
    }

    try {
        const outline = summarizable
            .map((node) => {
                const body = node.contentMd.length > MAX_BODY_CHARS_FOR_SUMMARY
                    ? `${node.contentMd.slice(0, MAX_BODY_CHARS_FOR_SUMMARY)}…`
                    : node.contentMd
                return `[${node.position}] ${"#".repeat(Math.max(1, node.depth))} ${node.title}\n${body}`
            })
            .join("\n\n")
        const completion = await callChatCompletion({
            userId: input.userId,
            systemPrompt: [
                "你是文档目录编译器。为每个章节写一句话中文摘要（不超过 60 字，聚焦该章节回答了什么）。",
                "只输出 JSON，不要 Markdown 围栏。",
                "JSON 结构：{\"summaries\": {\"<position>\": \"摘要\"}}，position 用方括号里的数字。",
            ].join("\n"),
            message: [
                `知识库：${input.knowledgeBaseName}`,
                `文档：${input.articleTitle}`,
                "章节列表：",
                outline,
            ].join("\n\n"),
        })
        const parsed = parseSummaryJson(completion.answer)
        for (const node of input.nodes) {
            const value = parsed.get(node.position)?.trim()
            result.set(node.position, value || localSummary(node))
        }
    } catch {
        for (const node of input.nodes) result.set(node.position, localSummary(node))
    }
    return result
}

function parseSummaryJson(raw: string): Map<number, string> {
    const map = new Map<number, string>()
    const start = raw.indexOf("{")
    const end = raw.lastIndexOf("}")
    if (start < 0 || end < start) return map
    let parsed: unknown
    try {
        parsed = JSON.parse(raw.slice(start, end + 1))
    } catch {
        return map
    }
    const summaries = (parsed as { summaries?: unknown })?.summaries
    if (!summaries || typeof summaries !== "object") return map
    for (const [key, value] of Object.entries(summaries as Record<string, unknown>)) {
        const position = Number(key)
        if (Number.isInteger(position) && typeof value === "string" && value.trim()) {
            map.set(position, value.trim())
        }
    }
    return map
}

/**
 * 为单篇源文档构建/刷新目录树并落库。
 * 结构未变（contentHash 一致）且非强制时跳过，避免重复消耗模型额度。
 */
export async function buildArticleTree(input: {
    db?: Db
    userId: number
    knowledgeBaseId: number
    knowledgeBaseName: string
    pageId: number
    article: KnowledgeBaseArticleRecord
    forceRebuild?: boolean
}): Promise<{ nodeCount: number; rebuilt: boolean }> {
    const db = input.db ?? getDb()
    const parsed = parseMarkdownTree(input.article.contentMd, input.article.title)
    const treeHash = hashTree(parsed)

    const existing = await db
        .select({ id: knowledgeBaseWikiTreeNodes.id, contentHash: knowledgeBaseWikiTreeNodes.contentHash, nodeKey: knowledgeBaseWikiTreeNodes.nodeKey })
        .from(knowledgeBaseWikiTreeNodes)
        .where(eq(knowledgeBaseWikiTreeNodes.articleId, input.article.id))
    const rootKey = treeNodeKey(input.article.id, 0)
    const cachedHash = existing.find((row) => row.nodeKey === rootKey)?.contentHash ?? null
    if (!input.forceRebuild && cachedHash === treeHash && existing.length === parsed.length) {
        return { nodeCount: existing.length, rebuilt: false }
    }

    const summaries = await generateNodeSummaries({
        userId: input.userId,
        knowledgeBaseName: input.knowledgeBaseName,
        articleTitle: input.article.title,
        nodes: parsed,
    })

    const now = new Date()
    const values = parsed.map((node) => ({
        userId: input.userId,
        knowledgeBaseId: input.knowledgeBaseId,
        pageId: input.pageId,
        articleId: input.article.id,
        nodeKey: treeNodeKey(input.article.id, node.position),
        parentKey: node.parentPosition == null ? null : treeNodeKey(input.article.id, node.parentPosition),
        depth: node.depth,
        position: node.position,
        title: node.title,
        summary: summaries.get(node.position) ?? null,
        contentMd: node.contentMd,
        startLine: node.startLine,
        endLine: node.endLine,
        tokenEstimate: estimateTokens(node.contentMd),
        // 根节点存树指纹，作为整篇结构的缓存判定依据；其余节点存自身内容哈希。
        contentHash: node.position === 0 ? treeHash : createHash("sha256").update(node.contentMd).digest("hex"),
        createdAt: now,
        updatedAt: now,
    }))

    await db.transaction(async (tx) => {
        await tx.delete(knowledgeBaseWikiTreeNodes).where(eq(knowledgeBaseWikiTreeNodes.articleId, input.article.id))
        if (values.length > 0) {
            await tx.insert(knowledgeBaseWikiTreeNodes).values(values)
        }
    })

    return { nodeCount: values.length, rebuilt: true }
}

async function loadTreeNodes(userId: number, knowledgeBaseId: number, articleId?: number) {
    const db = getDb()
    const filters = [
        eq(knowledgeBaseWikiTreeNodes.userId, userId),
        eq(knowledgeBaseWikiTreeNodes.knowledgeBaseId, knowledgeBaseId),
    ]
    if (articleId != null) filters.push(eq(knowledgeBaseWikiTreeNodes.articleId, articleId))
    return await db
        .select()
        .from(knowledgeBaseWikiTreeNodes)
        .where(and(...filters))
        .orderBy(asc(knowledgeBaseWikiTreeNodes.articleId), asc(knowledgeBaseWikiTreeNodes.position))
}

function buildNodePath(node: KnowledgeBaseWikiTreeNodeRecord, byKey: Map<string, KnowledgeBaseWikiTreeNodeRecord>) {
    const titles: string[] = []
    let current: KnowledgeBaseWikiTreeNodeRecord | undefined = node
    const guard = new Set<string>()
    while (current && !guard.has(current.nodeKey)) {
        guard.add(current.nodeKey)
        titles.unshift(current.title)
        current = current.parentKey ? byKey.get(current.parentKey) : undefined
    }
    return titles.join(" › ")
}

function renderOutline(nodes: KnowledgeBaseWikiTreeNodeRecord[]) {
    return nodes
        .map((node) => {
            const indent = "  ".repeat(Math.max(0, node.depth))
            const summary = node.summary ? ` — ${node.summary}` : ""
            return `${indent}- [${node.nodeKey}] ${node.title}${summary}`
        })
        .join("\n")
}

function scoreTreeNode(node: KnowledgeBaseWikiTreeNodeRecord, query: string) {
    return scoreSearchFields({
        title: node.title,
        summary: node.summary,
        content: node.contentMd,
    }, query)
}

const MAX_OUTLINE_NODES = 200

export interface TreeRetrievalHit {
    nodeKey: string
    articleId: string
    title: string
    path: string
    summary: string | null
    contentMd: string
    reason?: string
    depth: number
}

/**
 * 推理式检索：让 LLM 在文档目录树上导航，选出与问题最相关的节点。
 * LLM 不可用或解析失败时退回到关键词打分（标题/摘要优先）。
 */
export async function retrieveTreeNodesForAgent(input: {
    userId: number
    knowledgeBaseId: number
    query: string
    limit?: number
    articleId?: number
    maxContentChars?: number
}): Promise<TreeRetrievalHit[]> {
    await assertKnowledgeBaseOwner(getDb(), input.userId, input.knowledgeBaseId)
    const limit = Math.min(Math.max(input.limit ?? 6, 1), 12)
    const maxContentChars = input.maxContentChars ?? 1600
    const nodes = await loadTreeNodes(input.userId, input.knowledgeBaseId, input.articleId)
    if (nodes.length === 0) return []
    const byKey = new Map(nodes.map((node) => [node.nodeKey, node]))

    const selectedKeys = await selectNodeKeys({
        userId: input.userId,
        query: input.query,
        nodes,
        limit,
    })

    const orderedNodes: Array<{ node: KnowledgeBaseWikiTreeNodeRecord; reason?: string }> = selectedKeys.length > 0
        ? selectedKeys.flatMap((entry) => {
            const node = byKey.get(entry.nodeKey)
            return node ? [{ node, reason: entry.reason }] : []
        })
        : keywordFallback(nodes, input.query, limit).map((node) => ({ node, reason: undefined }))

    return orderedNodes.slice(0, limit).map(({ node, reason }) => ({
        nodeKey: node.nodeKey,
        articleId: String(node.articleId),
        title: node.title,
        path: buildNodePath(node, byKey),
        summary: node.summary,
        contentMd: node.contentMd.length > maxContentChars ? `${node.contentMd.slice(0, maxContentChars)}…` : node.contentMd,
        reason,
        depth: node.depth,
    }))
}

// ===== 章节节点向量语义检索（pgvector）：作为 PageIndex 推理式导航的补充 =====

const KB_EMBED_BATCH_SIZE = 64
// 单次请求最多补写的节点数，避免超大知识库把接口拖到超时；剩余可再次触发或用 backfill 脚本。
const KB_MAX_EMBED_PER_REQUEST = 2000
const KB_EMBED_MAX_CHARS = 4000

function buildTreeNodeEmbedText(node: { title: string; summary: string | null; contentMd: string }) {
    return [node.title, node.summary ?? "", node.contentMd]
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n")
        .slice(0, KB_EMBED_MAX_CHARS)
}

// 把一批章节节点的向量写入 embedding 列（原生 SQL，不走 Drizzle 列引用）。返回实际写入条数。
async function writeTreeNodeEmbeddings(
    userId: number,
    rows: Array<{ id: number; title: string; summary: string | null; contentMd: string }>,
): Promise<number> {
    let written = 0
    for (let offset = 0; offset < rows.length; offset += KB_EMBED_BATCH_SIZE) {
        const batch = rows.slice(offset, offset + KB_EMBED_BATCH_SIZE)
        const vectors = await embedTexts(userId, batch.map((node) => buildTreeNodeEmbedText(node)))
        for (let i = 0; i < batch.length; i += 1) {
            const vector = vectors[i]
            if (!vector) continue
            const literal = `[${vector.join(",")}]`
            await getDb().execute(sql`
                update petrichor_kb_wiki_tree_node set embedding = ${literal}::vector where id = ${batch[i].id}
            `)
            written += 1
        }
    }
    return written
}

async function loadPendingTreeNodeRows(userId: number, knowledgeBaseId: number) {
    return await getDb()
        .select({
            id: knowledgeBaseWikiTreeNodes.id,
            title: knowledgeBaseWikiTreeNodes.title,
            summary: knowledgeBaseWikiTreeNodes.summary,
            contentMd: knowledgeBaseWikiTreeNodes.contentMd,
        })
        .from(knowledgeBaseWikiTreeNodes)
        .where(and(
            eq(knowledgeBaseWikiTreeNodes.userId, userId),
            eq(knowledgeBaseWikiTreeNodes.knowledgeBaseId, knowledgeBaseId),
            sql`${knowledgeBaseWikiTreeNodes.id} in (select id from petrichor_kb_wiki_tree_node where knowledge_base_id = ${knowledgeBaseId} and embedding is null)`,
        ))
        .orderBy(asc(knowledgeBaseWikiTreeNodes.articleId), asc(knowledgeBaseWikiTreeNodes.position))
        .limit(KB_MAX_EMBED_PER_REQUEST)
}

// 知识库维度的向量化状态：目录树总节点数 / 已向量化数 / 待处理数。SQLite 不支持时返回 supported=false。
export async function getKbWikiEmbeddingStatus(userId: number, knowledgeBaseId: number) {
    if (isSqliteDatabase()) {
        return { supported: false, total: 0, embedded: 0, pending: 0 }
    }
    await assertKnowledgeBaseOwner(getDb(), userId, knowledgeBaseId)
    const rows = await getDb().execute(sql`
        select count(*)::int as total, count(embedding)::int as embedded
        from petrichor_kb_wiki_tree_node
        where user_id = ${userId} and knowledge_base_id = ${knowledgeBaseId}
    `)
    const row = (rows as Iterable<Record<string, unknown>>)[Symbol.iterator]().next().value as
        | { total?: unknown; embedded?: unknown }
        | undefined
    const total = Number(row?.total ?? 0)
    const embedded = Number(row?.embedded ?? 0)
    return { supported: true, total, embedded, pending: Math.max(total - embedded, 0) }
}

// 为整个知识库尚未向量化的目录树节点补写向量（单次最多 KB_MAX_EMBED_PER_REQUEST 条）。供「生成向量」按钮调用，缺配置时抛错。
export async function embedKnowledgeBaseTreeNodes(userId: number, knowledgeBaseId: number) {
    if (isSqliteDatabase()) {
        throw badRequest("向量生成需要 PostgreSQL 数据库")
    }
    await assertKnowledgeBaseOwner(getDb(), userId, knowledgeBaseId)
    if (!(await hasEmbeddingConfig(userId))) {
        throw badRequest("未配置向量模型：请先在「AI 模型配置」新增并启用一条 EMBEDDING 配置（推荐 bge-m3）")
    }
    const pending = await loadPendingTreeNodeRows(userId, knowledgeBaseId)
    const embedded = await writeTreeNodeEmbeddings(userId, pending)
    const status = await getKbWikiEmbeddingStatus(userId, knowledgeBaseId)
    return { embedded, total: status.total, pending: status.pending }
}

// best-effort：编译 Wiki 后自动补写节点向量（无配置 / SQLite / 出错都静默跳过，绝不影响编译流程）。
export async function embedKnowledgeBaseTreeNodesBestEffort(userId: number, knowledgeBaseId: number) {
    if (isSqliteDatabase()) return
    if (!(await hasEmbeddingConfig(userId))) return
    const pending = await loadPendingTreeNodeRows(userId, knowledgeBaseId)
    if (pending.length === 0) return
    await writeTreeNodeEmbeddings(userId, pending)
}

/** 向量语义检索：对章节节点做余弦相似度召回。作为 search_document_tree（推理式导航）的补充。 */
export async function semanticSearchTreeNodes(input: {
    userId: number
    knowledgeBaseId: number
    query: string
    limit?: number
    articleId?: number
    maxContentChars?: number
}): Promise<TreeRetrievalHit[]> {
    if (isSqliteDatabase()) {
        throw badRequest("向量语义检索需要 PostgreSQL 数据库")
    }
    await assertKnowledgeBaseOwner(getDb(), input.userId, input.knowledgeBaseId)
    const keyword = input.query.trim()
    if (!keyword) return []
    const limit = Math.min(Math.max(input.limit ?? 6, 1), 12)
    const maxContentChars = input.maxContentChars ?? 1600

    const vec = await embedQuery(input.userId, keyword)
    const literal = `[${vec.join(",")}]`
    const rows = await getDb().execute(sql`
        select node_key
        from petrichor_kb_wiki_tree_node
        where user_id = ${input.userId} and knowledge_base_id = ${input.knowledgeBaseId} and embedding is not null
          ${input.articleId != null ? sql`and article_id = ${input.articleId}` : sql``}
        order by embedding <=> ${literal}::vector
        limit ${limit}
    `)
    const orderedKeys: string[] = []
    for (const raw of rows as Iterable<Record<string, unknown>>) {
        if (raw.node_key != null) orderedKeys.push(String(raw.node_key))
    }
    if (orderedKeys.length === 0) return []

    // 载入全量节点用于构造面包屑路径（同一知识库节点量有限）
    const nodes = await loadTreeNodes(input.userId, input.knowledgeBaseId, input.articleId)
    const byKey = new Map(nodes.map((node) => [node.nodeKey, node]))
    return orderedKeys.flatMap((key) => {
        const node = byKey.get(key)
        if (!node) return []
        return [{
            nodeKey: node.nodeKey,
            articleId: String(node.articleId),
            title: node.title,
            path: buildNodePath(node, byKey),
            summary: node.summary,
            contentMd: node.contentMd.length > maxContentChars ? `${node.contentMd.slice(0, maxContentChars)}…` : node.contentMd,
            depth: node.depth,
        }]
    })
}

function keywordFallback(nodes: KnowledgeBaseWikiTreeNodeRecord[], query: string, limit: number) {
    const normalized = query.trim()
    return nodes
        .map((node) => ({ node, score: scoreTreeNode(node, normalized) }))
        .filter((item) => item.score > 0 || !normalized)
        .sort((left, right) => right.score - left.score || left.node.position - right.node.position)
        .slice(0, limit)
        .map((item) => item.node)
}

async function selectNodeKeys(input: {
    userId: number
    query: string
    nodes: KnowledgeBaseWikiTreeNodeRecord[]
    limit: number
}): Promise<Array<{ nodeKey: string; reason?: string }>> {
    if (input.nodes.length > MAX_OUTLINE_NODES) return []
    try {
        const outline = renderOutline(input.nodes)
        const completion = await callChatCompletion({
            userId: input.userId,
            systemPrompt: [
                "你在用「推理式检索」浏览文档目录树来回答问题。",
                "目录里每个节点形如 `[nodeKey] 标题 — 摘要`。",
                "请基于问题推理出最相关的若干节点（按相关度排序，最多按要求数量），优先选信息密度高、能直接支撑答案的节点。",
                "只输出 JSON，不要 Markdown 围栏。",
                "JSON 结构：{\"nodes\": [{\"nodeKey\": \"...\", \"reason\": \"为什么相关\"}]}。nodeKey 必须来自目录里出现过的值。",
            ].join("\n"),
            message: [
                `问题：${input.query}`,
                `最多选择 ${input.limit} 个节点。`,
                "文档目录树：",
                outline,
            ].join("\n\n"),
        })
        return parseSelectionJson(completion.answer, new Set(input.nodes.map((node) => node.nodeKey)))
    } catch {
        return []
    }
}

function parseSelectionJson(raw: string, validKeys: Set<string>): Array<{ nodeKey: string; reason?: string }> {
    const start = raw.indexOf("{")
    const end = raw.lastIndexOf("}")
    if (start < 0 || end < start) return []
    let parsed: unknown
    try {
        parsed = JSON.parse(raw.slice(start, end + 1))
    } catch {
        return []
    }
    const list = (parsed as { nodes?: unknown })?.nodes
    if (!Array.isArray(list)) return []
    const seen = new Set<string>()
    const result: Array<{ nodeKey: string; reason?: string }> = []
    for (const item of list) {
        const nodeKey = (item as { nodeKey?: unknown })?.nodeKey
        if (typeof nodeKey !== "string" || !validKeys.has(nodeKey) || seen.has(nodeKey)) continue
        seen.add(nodeKey)
        const reason = (item as { reason?: unknown })?.reason
        result.push({ nodeKey, reason: typeof reason === "string" && reason.trim() ? reason.trim() : undefined })
    }
    return result
}

/** 读取单个目录节点的完整内容（含面包屑路径与媒体引用），供 Agent 深读。 */
export async function readTreeNodeForAgent(userId: number, knowledgeBaseId: number, nodeKey: string) {
    await assertKnowledgeBaseOwner(getDb(), userId, knowledgeBaseId)
    const db = getDb()
    const [node] = await db
        .select()
        .from(knowledgeBaseWikiTreeNodes)
        .where(and(
            eq(knowledgeBaseWikiTreeNodes.userId, userId),
            eq(knowledgeBaseWikiTreeNodes.knowledgeBaseId, knowledgeBaseId),
            eq(knowledgeBaseWikiTreeNodes.nodeKey, nodeKey),
        ))
        .limit(1)
    if (!node) {
        return null
    }
    const siblings = await loadTreeNodes(userId, knowledgeBaseId, node.articleId)
    const byKey = new Map(siblings.map((item) => [item.nodeKey, item]))
    const [article] = await db
        .select({ title: knowledgeBaseArticles.title })
        .from(knowledgeBaseArticles)
        .where(eq(knowledgeBaseArticles.id, node.articleId))
        .limit(1)
    const childTitles = siblings
        .filter((item) => item.parentKey === node.nodeKey)
        .map((item) => ({ nodeKey: item.nodeKey, title: item.title }))

    return {
        knowledgeBaseId: String(knowledgeBaseId),
        nodeKey: node.nodeKey,
        articleId: String(node.articleId),
        articleTitle: article?.title ?? null,
        title: node.title,
        path: buildNodePath(node, byKey),
        summary: node.summary,
        depth: node.depth,
        contentMd: node.contentMd,
        children: childTitles,
        media: extractAgentImageReferences(node.contentMd, {
            sourceArticleId: String(node.articleId),
            sourceArticleTitle: article?.title ?? undefined,
        }),
        updatedAt: formatDate(node.updatedAt),
    }
}

/** 列出某知识库（或单篇文章）的目录树轮廓，供前端/Agent 概览。 */
export async function loadDocumentTreeOutline(userId: number, knowledgeBaseId: number, articleId?: number) {
    await assertKnowledgeBaseOwner(getDb(), userId, knowledgeBaseId)
    const nodes = await loadTreeNodes(userId, knowledgeBaseId, articleId)
    return nodes.map((node) => ({
        nodeKey: node.nodeKey,
        articleId: String(node.articleId),
        parentKey: node.parentKey,
        depth: node.depth,
        title: node.title,
        summary: node.summary,
        tokenEstimate: node.tokenEstimate,
    }))
}

export async function deleteArticleTree(articleIds: number[]) {
    if (articleIds.length === 0) return
    await getDb().delete(knowledgeBaseWikiTreeNodes).where(inArray(knowledgeBaseWikiTreeNodes.articleId, articleIds))
}
