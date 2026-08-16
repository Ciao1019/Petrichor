import { callChatCompletion } from "@/server/ai/generation"

import {
    SiteGraphEntityRegistry,
    isAlignableKind,
    type EntityMergeCandidate,
    type EntityRegistryEntry,
} from "./entity-registry"
import {
    SITE_GRAPH_LIMITS,
    SITE_GRAPH_ROOT_KEY,
    buildArticleNodeKey,
    buildSectionNodeKey,
    buildTagNodeKey,
    consolidateDraft,
    extractJsonObjectText,
    normalizeDraftEdge,
    normalizeDraftNode,
    normalizeNodeKey,
} from "./normalize"
import type {
    SiteGraphArticleInput,
    SiteGraphDraft,
    SiteGraphDraftEdge,
    SiteGraphDraftNode,
} from "./types"

/** 概念与标签各自挂在一个固定的顶层分类下，保证点群里有清晰的聚簇 */
export const SITE_GRAPH_CONCEPT_SECTION_KEY = buildSectionNodeKey("概念")
export const SITE_GRAPH_TAG_SECTION_KEY = buildSectionNodeKey("标签")

/** 每次模型调用处理的文章数：太大容易超上下文并降低抽取质量 */
export const SITE_GRAPH_BATCH_SIZE = 5
/** 单篇文章送入模型的正文上限 */
const ARTICLE_CONTENT_LIMIT = 2600

export interface SiteGraphExtractionContext {
    /** 本批次允许被关系引用的文章节点键 */
    articleKeys: Set<string>
}

export interface SiteGraphExtractionResult {
    draft: SiteGraphDraft
    warnings: string[]
    modelName: string | null
    /** 名称相近但不能确定同一实体的对子，交由后台人工确认 */
    mergeCandidates: EntityMergeCandidate[]
    /** 精确命中注册表而被自动合并的次数 */
    autoAlignedCount: number
}

/** 回喂给模型提示词的已知实体条数上限，避免提示词无限膨胀 */
const KNOWN_ENTITY_PROMPT_LIMIT = 60

export function chunkArticles(articles: SiteGraphArticleInput[], size = SITE_GRAPH_BATCH_SIZE) {
    const batches: SiteGraphArticleInput[][] = []
    const step = Math.max(1, size)
    for (let index = 0; index < articles.length; index += step) {
        batches.push(articles.slice(index, index + step))
    }
    return batches
}

/**
 * 结构骨架：root → 知识库分类 → 文章，外加「概念」「标签」两个固定分类。
 * 这部分完全确定性生成，不依赖模型，保证即使模型全挂图谱也有可用骨架。
 */
export function buildSkeletonDraft(articles: SiteGraphArticleInput[]): SiteGraphDraft {
    const nodes: SiteGraphDraftNode[] = [{
        nodeKey: SITE_GRAPH_ROOT_KEY,
        parentKey: null,
        kind: "root",
        name: "全站星图",
        summary: "站点全部公开内容的星图根节点",
        route: "/",
        articleId: null,
        attributes: [{ name: "文章数", value: String(articles.length) }],
        aliases: [],
        weight: 10,
        confidence: 100,
        source: "SYSTEM",
    }]
    const edges: SiteGraphDraftEdge[] = []
    const sectionSeen = new Set<string>()
    const tagSeen = new Set<string>()
    let hasTag = false

    for (const article of articles) {
        const sectionName = article.knowledgeBaseName.trim() || "未分类"
        const sectionKey = buildSectionNodeKey(sectionName)
        if (!sectionSeen.has(sectionKey)) {
            sectionSeen.add(sectionKey)
            nodes.push({
                nodeKey: sectionKey,
                parentKey: SITE_GRAPH_ROOT_KEY,
                kind: "section",
                name: sectionName,
                summary: `分类：${sectionName}`,
                route: null,
                articleId: null,
                attributes: [],
                aliases: [],
                weight: 4,
                confidence: 100,
                source: "SYSTEM",
            })
        }

        nodes.push({
            nodeKey: buildArticleNodeKey(article.articleId),
            parentKey: sectionKey,
            kind: "article",
            name: article.title,
            summary: article.excerpt,
            route: article.route,
            articleId: article.articleId,
            attributes: [
                { name: "分类", value: sectionName },
                { name: "更新时间", value: article.updatedAt.slice(0, 10) },
                ...(article.tags.length > 0 ? [{ name: "标签", value: article.tags.slice(0, 5).join("、") }] : []),
            ],
            aliases: [],
            weight: 2,
            confidence: 100,
            source: "SYSTEM",
        })

        for (const tag of article.tags.slice(0, 5)) {
            const tagKey = buildTagNodeKey(tag)
            if (!tagSeen.has(tagKey)) {
                tagSeen.add(tagKey)
                hasTag = true
                nodes.push({
                    nodeKey: tagKey,
                    parentKey: SITE_GRAPH_TAG_SECTION_KEY,
                    kind: "tag",
                    name: tag,
                    summary: `标签：${tag}`,
                    route: `/tags?tag=${encodeURIComponent(tag)}`,
                    articleId: null,
                    attributes: [],
                    aliases: [],
                    weight: 1,
                    confidence: 100,
                    source: "SYSTEM",
                })
            }
            edges.push({
                fromKey: buildArticleNodeKey(article.articleId),
                toKey: tagKey,
                relation: "标注",
                kind: "reference",
                attributes: [],
                weight: 1,
                directed: true,
                confidence: 100,
                source: "SYSTEM",
            })
        }
    }

    nodes.push({
        nodeKey: SITE_GRAPH_CONCEPT_SECTION_KEY,
        parentKey: SITE_GRAPH_ROOT_KEY,
        kind: "section",
        name: "概念",
        summary: "由抽取 Agent 从公开文章中归纳出的概念与实体",
        route: null,
        articleId: null,
        attributes: [],
        aliases: [],
        weight: 4,
        confidence: 100,
        source: "SYSTEM",
    })

    if (hasTag) {
        nodes.push({
            nodeKey: SITE_GRAPH_TAG_SECTION_KEY,
            parentKey: SITE_GRAPH_ROOT_KEY,
            kind: "section",
            name: "标签",
            summary: "文章标签",
            route: "/tags",
            articleId: null,
            attributes: [],
            aliases: [],
            weight: 4,
            confidence: 100,
            source: "SYSTEM",
        })
    }

    return { nodes, edges }
}

export function buildExtractionSystemPrompt() {
    return `你是「站点知识图谱抽取器」。输入是若干篇公开文章，输出这些文章共同构成的概念图谱。

只输出一个 JSON 对象，不要任何解释文字，不要用 Markdown 代码块包裹。结构固定为：
{
  "nodes": [
    {
      "nodeKey": "concept-向量检索",
      "name": "向量检索",
      "kind": "concept",
      "summary": "一句话说明这个概念在这些文章里指什么",
      "aliases": ["vector search"],
      "attributes": [
        { "name": "类别", "value": "检索技术" },
        { "name": "典型场景", "value": "RAG 问答" }
      ],
      "confidence": 88
    }
  ],
  "edges": [
    {
      "fromKey": "article-12",
      "toKey": "concept-向量检索",
      "relation": "阐述",
      "kind": "reference",
      "attributes": [{ "name": "依据", "value": "文中第 2 节" }],
      "confidence": 90
    }
  ]
}

节点规则：
- kind 只能是 concept（抽象概念）或 entity（具体实体：产品、库、人物、组织、协议等）
- nodeKey 用 "concept-" 或 "entity-" 前缀加中文/英文短名，同一事物在不同文章里必须复用同一个 nodeKey
- name 不超过 ${SITE_GRAPH_LIMITS.nameLength} 字；summary 不超过 ${SITE_GRAPH_LIMITS.summaryLength} 字
- attributes 是该节点的结构化属性，最多 ${SITE_GRAPH_LIMITS.attributesPerItem} 条，属性名不超过 ${SITE_GRAPH_LIMITS.attributeNameLength} 字、属性值不超过 ${SITE_GRAPH_LIMITS.attributeValueLength} 字
- aliases 是同义写法（中英文别名、缩写），最多 ${SITE_GRAPH_LIMITS.aliasesPerNode} 个
- 每批最多产出 12 个节点，只保留真正有信息量的，不要把段落标题当概念
- 不要输出文章节点，文章节点由系统生成

关系规则：
- fromKey / toKey 必须是本次输入中给出的文章节点键（article-数字），或本次 nodes 里定义的 nodeKey
- relation 是不超过 ${SITE_GRAPH_LIMITS.relationLength} 字的中文短语，例如：阐述、依赖、对比、属于、演进自、替代
- kind 只能是 reference（文章引用概念）、semantic（概念之间语义关联）、derived（由前者衍生）
- confidence 是 0~100 的整数，表示你对这条判断的把握
- 每批最多 20 条关系；不要给出自己指向自己的关系
- 不要虚构文章中不存在的事实`
}

export function buildExtractionUserMessage(
    articles: SiteGraphArticleInput[],
    knownEntities: EntityRegistryEntry[] = [],
) {
    const blocks = articles.map((article) => {
        const content = article.contentMd.length > ARTICLE_CONTENT_LIMIT
            ? `${article.contentMd.slice(0, ARTICLE_CONTENT_LIMIT)}\n[内容已截断]`
            : article.contentMd
        return [
            `### 文章节点键：${buildArticleNodeKey(article.articleId)}`,
            `标题：${article.title}`,
            `分类：${article.knowledgeBaseName || "未分类"}`,
            article.tags.length > 0 ? `标签：${article.tags.join("、")}` : "标签：（无）",
            "正文：",
            content,
        ].join("\n")
    })

    // 把已知实体清单回喂给模型，让它直接复用规范键，从源头减少同义分裂
    const knownEntityBlock = knownEntities.length === 0
        ? []
        : [
            "站点已有的概念/实体（如本批内容涉及其中任何一个，必须直接复用它的 nodeKey，不要另起新名）：",
            knownEntities
                .map((entry) => {
                    const aliasText = entry.aliases.length > 0 ? `，别名：${entry.aliases.join("、")}` : ""
                    return `- ${entry.canonicalKey}（${entry.name}${aliasText}）`
                })
                .join("\n"),
            "",
        ]

    return [
        `本批共 ${articles.length} 篇公开文章，请抽取它们共同的概念/实体节点及关系。`,
        "可被关系引用的文章节点键：",
        articles.map((article) => `- ${buildArticleNodeKey(article.articleId)}（${article.title}）`).join("\n"),
        "",
        ...knownEntityBlock,
        blocks.join("\n\n---\n\n"),
    ].join("\n")
}

/**
 * 解析单批模型输出。
 * 概念/实体节点一律挂到「概念」分类下；关系两端必须落在本批文章键或本批新节点上，
 * 否则直接丢弃并计一条 warning——这是拦截模型幻觉的第一道闸。
 */
export function parseExtractionResult(rawText: string, context: SiteGraphExtractionContext) {
    const warnings: string[] = []
    const jsonText = extractJsonObjectText(rawText)
    if (!jsonText) {
        return { nodes: [], edges: [], warnings: ["模型未返回合法 JSON，本批已跳过"] }
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(jsonText)
    } catch {
        return { nodes: [], edges: [], warnings: ["模型返回的 JSON 无法解析，本批已跳过"] }
    }

    const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}
    const rawNodes = Array.isArray(record.nodes) ? record.nodes : []
    const rawEdges = Array.isArray(record.edges) ? record.edges : []

    const nodes: SiteGraphDraftNode[] = []
    for (const raw of rawNodes) {
        const node = normalizeDraftNode(raw)
        if (!node) continue
        if (node.kind !== "concept" && node.kind !== "entity") {
            // 模型偶尔会回写文章/分类节点，这些由系统骨架负责，直接忽略
            continue
        }
        nodes.push({
            ...node,
            parentKey: SITE_GRAPH_CONCEPT_SECTION_KEY,
            route: null,
            articleId: null,
            source: "AGENT",
        })
    }

    const knownKeys = new Set<string>([...context.articleKeys, ...nodes.map((node) => node.nodeKey)])
    const edges: SiteGraphDraftEdge[] = []
    let droppedEdges = 0
    for (const raw of rawEdges) {
        const edge = normalizeDraftEdge(raw)
        if (!edge) {
            droppedEdges += 1
            continue
        }
        if (!knownKeys.has(edge.fromKey) || !knownKeys.has(edge.toKey)) {
            droppedEdges += 1
            continue
        }
        edges.push({ ...edge, source: "AGENT" })
    }

    if (droppedEdges > 0) {
        warnings.push(`本批丢弃 ${droppedEdges} 条指向未知节点的关系`)
    }

    return { nodes, edges, warnings }
}

/**
 * 抽取 Agent 主流程：确定性骨架 + 分批模型抽取，逐批容错。
 * 任何一批失败都只记 warning 并继续，保证整体产出。
 */
export async function runSiteGraphExtraction(input: {
    userId: number
    articles: SiteGraphArticleInput[]
    modelRefId?: number | null
    /** 库里已有的概念/实体，用于跨次运行保持同一套规范键 */
    existingEntities?: EntityRegistryEntry[]
}): Promise<SiteGraphExtractionResult> {
    const skeleton = buildSkeletonDraft(input.articles)
    const warnings: string[] = []
    const nodes = [...skeleton.nodes]
    const edges = [...skeleton.edges]
    let modelName: string | null = null
    let autoAlignedCount = 0

    // 注册表跨批次累积：上一批抽出的实体会立刻成为下一批的对齐基准
    const registry = new SiteGraphEntityRegistry(input.existingEntities ?? [])

    const batches = chunkArticles(input.articles)
    for (const [index, batch] of batches.entries()) {
        try {
            const response = await callChatCompletion({
                userId: input.userId,
                modelRefId: input.modelRefId ?? null,
                messages: [
                    { role: "system", content: buildExtractionSystemPrompt() },
                    {
                        role: "user",
                        content: buildExtractionUserMessage(batch, registry.topEntries(KNOWN_ENTITY_PROMPT_LIMIT)),
                    },
                ],
            })
            modelName ??= response.modelName
            const parsed = parseExtractionResult(response.answer, {
                articleKeys: new Set(batch.map((article) => buildArticleNodeKey(article.articleId))),
            })

            const aligned = alignNodesWithRegistry(parsed.nodes, registry)
            autoAlignedCount += aligned.autoAlignedCount
            nodes.push(...aligned.nodes)
            // 关系两端可能引用了被改写的键，同步重写
            edges.push(...rewriteEdgeKeys(parsed.edges, aligned.keyRewrites))
            warnings.push(...parsed.warnings.map((warning) => `第 ${index + 1} 批：${warning}`))
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "未知错误"
            warnings.push(`第 ${index + 1} 批抽取失败：${message}`)
        }
    }

    // 概念节点可能引用了别的批次才定义的键，这里统一收敛一次
    const draft = consolidateDraft({ nodes, edges })
    ensureConceptSectionUsed(draft)

    const mergeCandidates = registry
        .mergeCandidates()
        .filter((candidate) => candidate.sourceKey !== candidate.targetKey)

    return {
        draft,
        warnings: [...new Set(warnings)].slice(0, 20),
        modelName,
        mergeCandidates,
        autoAlignedCount,
    }
}

/**
 * 把一批新抽取的概念/实体对齐到注册表：
 * 精确命中（键 / 名称 / 别名）→ 改写为已有规范键并计入自动合并；
 * 未命中 → 注册为新实体，同时可能产出一条待确认的合并候选。
 */
export function alignNodesWithRegistry(
    parsedNodes: SiteGraphDraftNode[],
    registry: SiteGraphEntityRegistry,
) {
    const nodes: SiteGraphDraftNode[] = []
    const keyRewrites = new Map<string, string>()
    let autoAlignedCount = 0

    for (const node of parsedNodes) {
        if (!isAlignableKind(node.kind)) {
            nodes.push(node)
            continue
        }

        const resolved = registry.resolve(node)
        if (resolved.match !== "none" && resolved.canonicalKey !== node.nodeKey) {
            autoAlignedCount += 1
            keyRewrites.set(node.nodeKey, resolved.canonicalKey)
        }

        const canonicalNode: SiteGraphDraftNode = {
            ...node,
            nodeKey: resolved.canonicalKey,
            // 原名在被改写时降级成别名，保留同义写法供下次匹配
            aliases: resolved.canonicalKey === node.nodeKey
                ? node.aliases
                : [...node.aliases, node.name],
        }
        nodes.push(canonicalNode)

        registry.register({
            canonicalKey: canonicalNode.nodeKey,
            name: canonicalNode.name,
            aliases: canonicalNode.aliases,
            kind: canonicalNode.kind,
            weight: canonicalNode.weight,
        })
    }

    return { nodes, keyRewrites, autoAlignedCount }
}

function rewriteEdgeKeys(edges: SiteGraphDraftEdge[], keyRewrites: Map<string, string>) {
    if (keyRewrites.size === 0) return edges
    return edges
        .map((edge) => ({
            ...edge,
            fromKey: keyRewrites.get(edge.fromKey) ?? edge.fromKey,
            toKey: keyRewrites.get(edge.toKey) ?? edge.toKey,
        }))
        .filter((edge) => edge.fromKey !== edge.toKey)
}

/** 没有任何概念节点时移除空的「概念」分类，避免前台出现孤立空簇 */
function ensureConceptSectionUsed(draft: SiteGraphDraft) {
    const hasConcept = draft.nodes.some((node) => node.parentKey === SITE_GRAPH_CONCEPT_SECTION_KEY)
    if (hasConcept) return
    const index = draft.nodes.findIndex((node) => node.nodeKey === SITE_GRAPH_CONCEPT_SECTION_KEY)
    if (index >= 0) {
        draft.nodes.splice(index, 1)
    }
}

/** 后台手工新增节点时复用同一套键归一化 */
export function buildManualNodeKey(name: string, kind: string) {
    return normalizeNodeKey(`${kind}-${name}`)
}
