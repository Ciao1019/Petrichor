import { createStep, createWorkflow } from "@mastra/core/workflows"
import { z } from "zod"

import { callChatCompletion } from "@/server/ai/generation"

const KNOWLEDGE_CHUNK_MAX_CHARS = 3_200
const KNOWLEDGE_CHUNK_OVERLAP_CHARS = 180
const KNOWLEDGE_CHUNK_LIMIT = 60
const QUESTION_BATCH_SIZE = 8
const QUESTION_BATCH_CONCURRENCY = 3
const WIKI_DOCUMENT_MAX_CHARS = 72_000
const WIKI_ITEM_LIMIT = 24
const WIKI_PAGE_BATCH_SIZE = 4
const WIKI_PAGE_BATCH_CONCURRENCY = 3

export const ARTICLE_KNOWLEDGE_BUILD_VERSION = 4

const existingWikiPageSchema = z.object({
    pageKey: z.string(),
    title: z.string(),
    kind: z.enum(["entity", "concept"]),
    aliases: z.array(z.string()),
    summary: z.string(),
    categoryPath: z.array(z.string()).max(2),
    buildVersion: z.number().int().nonnegative(),
})

const workflowInputSchema = z.object({
    userId: z.number().int().positive(),
    knowledgeBaseId: z.number().int().positive(),
    knowledgeBaseName: z.string(),
    articleId: z.number().int().positive(),
    articleTitle: z.string(),
    contentMd: z.string(),
    existingPages: z.array(existingWikiPageSchema),
})

const knowledgeChunkSchema = z.object({
    chunkKey: z.string(),
    position: z.number().int().nonnegative(),
    heading: z.string(),
    contentMd: z.string(),
    contentHash: z.string(),
})

const preparedDocumentSchema = workflowInputSchema.extend({
    chunks: z.array(knowledgeChunkSchema),
})

const chunkQuestionsSchema = z.object({
    chunkKey: z.string(),
    questions: z.array(z.string()).length(3),
})

const knowledgeCandidateSchema = z.object({
    kind: z.enum(["entity", "concept"]),
    name: z.string(),
    pageKey: z.string(),
    aliases: z.array(z.string()),
    summary: z.string(),
    categoryPath: z.array(z.string()).max(2),
})

const knowledgeRelationSchema = z.object({
    fromPageKey: z.string(),
    toPageKey: z.string(),
    relationType: z.string(),
    description: z.string(),
})

const knowledgeItemSchema = knowledgeCandidateSchema.extend({
    contentMd: z.string(),
    relatedPageKeys: z.array(z.string()),
    relations: z.array(knowledgeRelationSchema),
})

const questionOutputSchema = z.object({
    chunks: z.array(chunkQuestionsSchema),
    warnings: z.array(z.string()),
})

const extractionOutputSchema = z.object({
    documentSummary: z.string(),
    candidates: z.array(knowledgeCandidateSchema),
    relations: z.array(knowledgeRelationSchema),
    warnings: z.array(z.string()),
})

const wikiMaterializationInputSchema = preparedDocumentSchema.extend({
    chunks: z.array(knowledgeChunkSchema.extend({ recommendedQuestions: z.array(z.string()).length(3) })),
    documentSummary: z.string(),
    candidates: z.array(knowledgeCandidateSchema),
    relations: z.array(knowledgeRelationSchema),
    warnings: z.array(z.string()),
})

const workflowOutputSchema = z.object({
    chunks: z.array(knowledgeChunkSchema.extend({ recommendedQuestions: z.array(z.string()).length(3) })),
    documentSummary: z.string(),
    items: z.array(knowledgeItemSchema),
    relations: z.array(knowledgeRelationSchema),
    warnings: z.array(z.string()),
})

export type KnowledgeBuildChunk = z.infer<typeof workflowOutputSchema>["chunks"][number]
export type ExtractedKnowledgeItem = z.infer<typeof knowledgeItemSchema>
export type ExtractedKnowledgeRelation = z.infer<typeof knowledgeRelationSchema>
export type KnowledgeBuildWorkflowResult = z.infer<typeof workflowOutputSchema>
export type ExistingKnowledgePage = z.infer<typeof existingWikiPageSchema>

type KnowledgeCandidate = z.infer<typeof knowledgeCandidateSchema>
type RawChunk = z.infer<typeof knowledgeChunkSchema>
type WorkflowInput = z.infer<typeof workflowInputSchema>

const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const FENCE_PATTERN = /^\s*(```|~~~)/

/**
 * 按 Markdown 标题与段落边界切片。切片仅服务于检索和推荐问题，
 * Wiki 的候选抽取与页面正文生成始终读取整篇 Markdown。
 */
export function splitMarkdownForKnowledgeBuild(
    markdown: string,
    articleTitle: string,
    maxChars = KNOWLEDGE_CHUNK_MAX_CHARS,
): Omit<RawChunk, "contentHash">[] {
    const normalized = markdown.replace(/\r\n?/g, "\n").trim()
    if (!normalized) return []

    const lines = normalized.split("\n")
    const sections: Array<{ heading: string; text: string }> = []
    let heading = articleTitle.trim() || "文档正文"
    let buffer: string[] = []
    let inFence = false

    const flush = () => {
        const text = buffer.join("\n").trim()
        if (text) sections.push({ heading, text })
        buffer = []
    }

    for (const line of lines) {
        if (FENCE_PATTERN.test(line)) {
            inFence = !inFence
            buffer.push(line)
            continue
        }
        const match = inFence ? null : line.match(HEADING_PATTERN)
        if (match) {
            flush()
            heading = match[2].trim() || articleTitle
            buffer.push(line)
            continue
        }
        buffer.push(line)
    }
    flush()

    const result: Omit<RawChunk, "contentHash">[] = []
    for (const section of sections) {
        const pieces = splitLongSection(section.text, maxChars, KNOWLEDGE_CHUNK_OVERLAP_CHARS)
        for (const piece of pieces) {
            if (result.length >= KNOWLEDGE_CHUNK_LIMIT) break
            const position = result.length
            result.push({
                chunkKey: `chunk-${String(position + 1).padStart(3, "0")}`,
                position,
                heading: section.heading,
                contentMd: piece,
            })
        }
        if (result.length >= KNOWLEDGE_CHUNK_LIMIT) break
    }
    return result
}

function splitLongSection(text: string, maxChars: number, overlapChars: number): string[] {
    if (text.length <= maxChars) return [text]
    const chunks: string[] = []
    let cursor = 0
    while (cursor < text.length) {
        const hardEnd = Math.min(text.length, cursor + maxChars)
        let end = hardEnd
        if (hardEnd < text.length) {
            const paragraphBreak = text.lastIndexOf("\n\n", hardEnd)
            const lineBreak = text.lastIndexOf("\n", hardEnd)
            const candidate = Math.max(paragraphBreak, lineBreak)
            if (candidate > cursor + Math.floor(maxChars * 0.55)) end = candidate
        }
        const value = text.slice(cursor, end).trim()
        if (value) chunks.push(value)
        if (end >= text.length) break
        cursor = Math.max(end - overlapChars, cursor + 1)
    }
    return chunks
}

export function normalizeRecommendedQuestions(values: unknown, heading: string): [string, string, string] {
    const normalized = normalizeStringList(values).slice(0, 3)
    const fallbacks = [
        `${heading} 主要讲了什么？`,
        `${heading} 中有哪些关键结论？`,
        `如何理解并应用 ${heading}？`,
    ]
    for (const fallback of fallbacks) {
        if (normalized.length >= 3) break
        if (!normalized.includes(fallback)) normalized.push(fallback)
    }
    return [normalized[0], normalized[1], normalized[2]]
}

export function normalizeKnowledgeCategoryPath(value: unknown): string[] {
    const raw = Array.isArray(value)
        ? value
        : typeof value === "string"
            ? value.split(/[/／|｜>]+/)
            : []
    return normalizeStringList(raw)
        .map((part) => part.replace(/[/／|｜>]/g, "").trim())
        .filter((part) => !/^(实体|概念|entity|concept)$/i.test(part))
        .slice(0, 2)
}

function localDocumentSummary(contentMd: string) {
    const plain = contentMd
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
        .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
        .replace(/[-#>*_`~|]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    return plain.length <= 260 ? plain : `${plain.slice(0, 260).trim()}…`
}

function normalizePageKey(raw: unknown, kind: "entity" | "concept", name: string) {
    const base = typeof raw === "string" && raw.trim() ? raw.trim() : `${kind}-${name}`
    const withoutPrefix = base.replace(/^(entity|concept)[/\-:]+/i, "")
    const slug = withoutPrefix
        .toLowerCase()
        .replace(/[\s/\\#?&=]+/g, "-")
        .replace(/[^a-z0-9\u4e00-\u9fa5._-]+/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
    return `${kind}-${slug || simpleHash(name).slice(0, 12)}`
}

function inferPageKind(value: unknown): "entity" | "concept" {
    return typeof value === "string" && /^concept[/\-:]/i.test(value.trim()) ? "concept" : "entity"
}

function simpleHash(value: string) {
    let hash = 2166136261
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16).padStart(8, "0")
}

function normalizeStringList(values: unknown): string[] {
    if (!Array.isArray(values)) return []
    return [...new Set(values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean))]
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
    const start = raw.indexOf("{")
    const end = raw.lastIndexOf("}")
    if (start < 0 || end < start) return null
    try {
        const value = JSON.parse(raw.slice(start, end + 1)) as unknown
        return value && typeof value === "object" && !Array.isArray(value)
            ? value as Record<string, unknown>
            : null
    } catch {
        return null
    }
}

async function mapWithConcurrency<T, R>(
    values: T[],
    concurrency: number,
    mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(values.length)
    let cursor = 0
    const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (cursor < values.length) {
            const index = cursor
            cursor += 1
            results[index] = await mapper(values[index], index)
        }
    })
    await Promise.all(workers)
    return results
}

function batchValues<T>(values: T[], size: number): T[][] {
    const batches: T[][] = []
    for (let index = 0; index < values.length; index += size) {
        batches.push(values.slice(index, index + size))
    }
    return batches
}

function buildWholeDocumentContext(contentMd: string) {
    const normalized = contentMd.replace(/\r\n?/g, "\n").trim()
    if (normalized.length <= WIKI_DOCUMENT_MAX_CHARS) return normalized
    const headLength = Math.floor(WIKI_DOCUMENT_MAX_CHARS * 0.62)
    const tailLength = WIKI_DOCUMENT_MAX_CHARS - headLength
    return [
        normalized.slice(0, headLength),
        "\n\n<!-- 文档过长，中间内容已省略；以下继续保留文档末尾 -->\n\n",
        normalized.slice(-tailLength),
    ].join("")
}

function renderExistingPageCatalog(pages: ExistingKnowledgePage[]) {
    if (pages.length === 0) return "（暂无既有页面）"
    return pages.slice(0, 300).map((page) => [
        `- ${page.pageKey} | ${page.kind} | ${page.title}`,
        page.aliases.length > 0 ? ` | 别名：${page.aliases.join("、")}` : "",
        page.summary ? ` | 摘要：${page.summary.slice(0, 180)}` : "",
        page.categoryPath.length > 0 ? ` | 目录：${page.categoryPath.join(" / ")}` : "",
    ].join("")).join("\n")
}

async function generateChunkQuestions(input: z.infer<typeof preparedDocumentSchema>) {
    const warnings: string[] = []
    const batches = batchValues(input.chunks, QUESTION_BATCH_SIZE)
    const outputs = await mapWithConcurrency(batches, QUESTION_BATCH_CONCURRENCY, async (batch) => {
        const fallback = batch.map((chunk) => ({
            chunkKey: chunk.chunkKey,
            questions: normalizeRecommendedQuestions([], chunk.heading),
        }))
        try {
            const result = await callChatCompletion({
                userId: input.userId,
                systemPrompt: [
                    "你是知识库问题生成器。为每个 Markdown 切片生成恰好 3 个用户可能提出的推荐问题。",
                    "问题必须能仅依据对应切片回答，具体、互不重复，不要输出答案。",
                    "只输出 JSON：{\"questions\":{\"chunk-001\":[\"问题1\",\"问题2\",\"问题3\"]}}。",
                ].join("\n"),
                message: batch.map((chunk) => [
                    `<chunk id="${chunk.chunkKey}" heading="${chunk.heading}">`,
                    chunk.contentMd,
                    "</chunk>",
                ].join("\n")).join("\n\n"),
            })
            const parsed = extractJsonObject(result.answer)
            const questions = parsed?.questions
            if (!questions || typeof questions !== "object" || Array.isArray(questions)) return fallback
            const byKey = questions as Record<string, unknown>
            return batch.map((chunk) => ({
                chunkKey: chunk.chunkKey,
                questions: normalizeRecommendedQuestions(byKey[chunk.chunkKey], chunk.heading),
            }))
        } catch (error) {
            warnings.push(error instanceof Error ? `推荐问题生成失败：${error.message}` : "推荐问题生成失败，已使用本地问题")
            return fallback
        }
    })
    return { chunks: outputs.flat(), warnings: [...new Set(warnings)].slice(0, 5) }
}

async function extractDocumentCandidates(input: z.infer<typeof preparedDocumentSchema>) {
    const fallback = {
        documentSummary: localDocumentSummary(input.contentMd),
        candidates: [] as KnowledgeCandidate[],
        relations: [] as ExtractedKnowledgeRelation[],
        warnings: [] as string[],
    }
    try {
        const result = await callChatCompletion({
            userId: input.userId,
            systemPrompt: [
                "你是 Wiki 候选抽取器。必须从整篇 Markdown 识别被实质讨论的实体、概念及它们之间的关系；不要根据预先切片分别抽取。",
                "实体（entity）是具有独立身份、可以被明确指代的具体对象：人物、组织、产品、应用/工具、平台、操作系统、地点、协议、具名技术/服务或事件。例如 Mole、Homebrew、终端属于实体。",
                "概念（concept）是可以被解释、学习或复用的知识点：功能/能力、方法、流程、规则、原理、配置方式、安全机制、理论或抽象主题。例如 Shell 自动补全、Touch ID 授权、智能卸载、深度清理属于概念。",
                "章节标题或聚合标签（如‘产品介绍’‘功能说明’‘关联工具’‘安全’‘配置’）只适合作为目录，不得抽成页面；通用名词和一带而过的技术名也不要抽取。",
                "只保留正文有专门段落、多项列表、独立小节或至少 2-3 句具体说明的条目。目标是紧凑、可阅读的知识集合，通常 5-20 项，最多 24 项，不追求穷举。",
                "若一个名称表示具体产品/工具本身，即使它属于某类技术，也只能放入 entities；只有功能、方法、机制、规则等抽象知识才放入 concepts。不得跨两类重复。",
                "existing_pages 中若存在同一对象，必须复用其 pageKey；相关不等于相同，不得为了复用而错误合并。",
                "relations 只描述本次 candidates 之间有原文依据的关系。relationType 使用简短中文动词或关系词，例如：属于、使用、实现、依赖、组成、对比、关联。",
                "这一阶段只输出候选骨架；不要规划目录，不输出页面正文，不输出 chunk id。",
                "只输出 JSON，不要 Markdown 围栏。结构：",
                "{\"documentSummary\":\"...\",\"entities\":[{\"name\":\"\",\"pageKey\":\"entity/...\",\"aliases\":[],\"summary\":\"\"}],\"concepts\":[同结构],\"relations\":[{\"fromPageKey\":\"entity/...\",\"toPageKey\":\"concept/...\",\"relationType\":\"实现\",\"description\":\"原文支持的一句话关系说明\"}]}。",
            ].join("\n"),
            message: [
                `知识库：${input.knowledgeBaseName}`,
                `文档标题：${input.articleTitle}`,
                "<existing_pages>",
                renderExistingPageCatalog(input.existingPages),
                "</existing_pages>",
                "<document_markdown>",
                buildWholeDocumentContext(input.contentMd),
                "</document_markdown>",
            ].join("\n\n"),
        })
        const parsed = extractJsonObject(result.answer)
        if (!parsed) return { ...fallback, warnings: ["Wiki 候选抽取结果不是有效 JSON"] }
        const candidates = limitKnowledgeCandidates(
            normalizeKnowledgeCandidates(parsed.entities, "entity"),
            normalizeKnowledgeCandidates(parsed.concepts, "concept"),
            WIKI_ITEM_LIMIT,
        )
        const candidateKeys = new Set(candidates.map((item) => item.pageKey))
        const relations = normalizeKnowledgeRelations(parsed.relations, candidateKeys)
        return {
            documentSummary: typeof parsed.documentSummary === "string" && parsed.documentSummary.trim()
                ? parsed.documentSummary.trim().slice(0, 800)
                : fallback.documentSummary,
            candidates,
            relations,
            warnings: [],
        }
    } catch (error) {
        return {
            ...fallback,
            warnings: [error instanceof Error ? `Wiki 候选抽取失败：${error.message}` : "Wiki 候选抽取失败"],
        }
    }
}

function normalizeKnowledgeCandidates(values: unknown, kind: "entity" | "concept"): KnowledgeCandidate[] {
    if (!Array.isArray(values)) return []
    const seen = new Set<string>()
    const candidates: KnowledgeCandidate[] = []
    for (const raw of values) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
        const value = raw as Record<string, unknown>
        const name = typeof value.name === "string" ? value.name.trim() : ""
        if (!name) continue
        const pageKey = normalizePageKey(value.pageKey, kind, name)
        if (seen.has(pageKey)) continue
        seen.add(pageKey)
        const summary = typeof value.summary === "string" ? value.summary.trim().slice(0, 500) : ""
        candidates.push({
            kind,
            name,
            pageKey,
            aliases: normalizeStringList(value.aliases).filter((alias) => alias !== name).slice(0, 12),
            summary,
            categoryPath: [],
        })
    }
    return candidates
}

function limitKnowledgeCandidates(
    entities: KnowledgeCandidate[],
    concepts: KnowledgeCandidate[],
    limit: number,
) {
    const result: KnowledgeCandidate[] = []
    const seenNames = new Set<string>()
    const maxLength = Math.max(entities.length, concepts.length)
    for (let index = 0; index < maxLength && result.length < limit; index += 1) {
        for (const candidate of [entities[index], concepts[index]]) {
            if (!candidate || result.length >= limit) continue
            const identity = candidate.name
                .toLocaleLowerCase("zh-CN")
                .replace(/[\s\p{P}\p{S}]+/gu, "")
            if (identity && seenNames.has(identity)) continue
            if (identity) seenNames.add(identity)
            result.push(candidate)
        }
    }
    return result
}

export function normalizeKnowledgeRelations(values: unknown, candidateKeys: Set<string>): ExtractedKnowledgeRelation[] {
    if (!Array.isArray(values)) return []
    const seen = new Set<string>()
    const relations: ExtractedKnowledgeRelation[] = []
    for (const raw of values) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
        const value = raw as Record<string, unknown>
        const rawFrom = typeof value.fromPageKey === "string" ? value.fromPageKey : ""
        const rawTo = typeof value.toPageKey === "string" ? value.toPageKey : ""
        const fromPageKey = normalizePageKey(rawFrom, inferPageKind(rawFrom), rawFrom)
        const toPageKey = normalizePageKey(rawTo, inferPageKind(rawTo), rawTo)
        if (!candidateKeys.has(fromPageKey) || !candidateKeys.has(toPageKey) || fromPageKey === toPageKey) continue
        const relationType = typeof value.relationType === "string" && value.relationType.trim()
            ? value.relationType.trim().slice(0, 60)
            : "关联"
        const description = typeof value.description === "string"
            ? value.description.trim().slice(0, 300)
            : ""
        const key = `${fromPageKey}|${toPageKey}|${relationType}`
        if (seen.has(key)) continue
        seen.add(key)
        relations.push({ fromPageKey, toPageKey, relationType, description })
    }
    return relations.slice(0, 160)
}

function renderExistingTaxonomy(pages: ExistingKnowledgePage[]) {
    const paths = pages
        .filter((page) => page.buildVersion >= ARTICLE_KNOWLEDGE_BUILD_VERSION)
        .map((page) => normalizeKnowledgeCategoryPath(page.categoryPath))
        .filter((path) => path.length > 0)
    const uniquePaths = [...new Set(paths.map((path) => path.join(" / ")))].sort((left, right) => (
        left.localeCompare(right, "zh-CN")
    ))
    return uniquePaths.length > 0
        ? uniquePaths.slice(0, 120).map((path) => `- ${path}`).join("\n")
        : "（暂无可复用目录）"
}

function parseTaxonomyAssignments(values: unknown, candidates: KnowledgeCandidate[]) {
    if (!Array.isArray(values)) return new Map<string, string[]>()
    const candidateByKey = new Map(candidates.map((candidate) => [candidate.pageKey, candidate]))
    const assignments = new Map<string, string[]>()
    for (const raw of values) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
        const value = raw as Record<string, unknown>
        const rawPageKey = typeof value.pageKey === "string"
            ? value.pageKey.trim()
            : typeof value.slug === "string"
                ? value.slug.trim()
                : ""
        if (!rawPageKey) continue
        const pageKey = candidateByKey.has(rawPageKey)
            ? rawPageKey
            : normalizePageKey(rawPageKey, inferPageKind(rawPageKey), rawPageKey)
        if (!candidateByKey.has(pageKey) || assignments.has(pageKey)) continue
        assignments.set(pageKey, normalizeKnowledgeCategoryPath(value.path ?? value.categoryPath))
    }
    return assignments
}

/**
 * 参考 WeKnora 的 batch taxonomy：候选确定后再用一次全局规划统一分组，
 * 避免每个候选在抽取时各自发明目录。实体/概念只是页面类型，不参与目录层级。
 */
async function planKnowledgeTaxonomy(input: z.infer<typeof wikiMaterializationInputSchema>) {
    if (input.candidates.length === 0) return input

    const existingCategoryByKey = new Map(input.existingPages
        .filter((page) => (
            page.buildVersion >= ARTICLE_KNOWLEDGE_BUILD_VERSION
            && normalizeKnowledgeCategoryPath(page.categoryPath).length > 0
        ))
        .map((page) => [page.pageKey, normalizeKnowledgeCategoryPath(page.categoryPath)]))

    try {
        const result = await callChatCompletion({
            userId: input.userId,
            systemPrompt: [
                "你是 Wiki 导航目录规划器。候选实体和概念已经抽取完成，请一次性为整批候选规划一棵统一、浅层、可复用的中文目录树。",
                "目录只负责语义分组；entity/concept 是页面类型元数据，绝不能建立‘实体’‘概念’两个类型根目录。两类页面必须混合出现在同一棵知识目录中，并由界面图标区分。",
                "每项输出从宽到窄的 category path，最多 2 级，优先只用 1 级。一级目录通常不超过 6 个；只有多个同类页面确实需要细分时才建立二级目录。",
                "目录数量必须显著少于页面数量。禁止一页一目录，禁止把页面标题原样再建成叶子目录，禁止同义目录、单复数目录或不同措辞的重复目录。",
                "优先复用 existing_folders 的完整原标签。新建目录时用稳定、清晰的知识分组；不要按某个条目在一句话里的临时角色随意发明层级。",
                "产品/工具说明文档可以用主产品或领域作一级目录，再用‘产品介绍’‘功能说明’‘关联工具’等作为二级分组：产品/工具本身与相关工具是 entity，功能、能力、配置和机制通常是 concept。",
                "每个 requested_items 的 pageKey 必须恰好出现一次。只输出 JSON，不要 Markdown 围栏。",
                "输出结构：{\"assignments\":[{\"pageKey\":\"entity-xxx\",\"path\":[\"一级\",\"二级\"]}]}。",
            ].join("\n"),
            message: [
                `知识库：${input.knowledgeBaseName}`,
                `当前文档：${input.articleTitle}`,
                "<existing_folders>",
                renderExistingTaxonomy(input.existingPages),
                "</existing_folders>",
                "<requested_items>",
                input.candidates.map((candidate) => [
                    `- pageKey: ${candidate.pageKey}`,
                    ` | type: ${candidate.kind}`,
                    ` | title: ${candidate.name}`,
                    candidate.summary ? ` | about: ${candidate.summary}` : "",
                ].join("")).join("\n"),
                "</requested_items>",
            ].join("\n\n"),
        })
        const parsed = extractJsonObject(result.answer)
        const assignments = parseTaxonomyAssignments(parsed?.assignments, input.candidates)
        return {
            ...input,
            candidates: input.candidates.map((candidate) => ({
                ...candidate,
                categoryPath: existingCategoryByKey.get(candidate.pageKey)
                    ?? assignments.get(candidate.pageKey)
                    ?? [],
            })),
            warnings: parsed
                ? input.warnings
                : [...input.warnings, "知识目录规划结果不是有效 JSON"].slice(0, 8),
        }
    } catch (error) {
        return {
            ...input,
            candidates: input.candidates.map((candidate) => ({
                ...candidate,
                categoryPath: existingCategoryByKey.get(candidate.pageKey) ?? [],
            })),
            warnings: [...input.warnings, error instanceof Error
                ? `知识目录规划失败：${error.message}`
                : "知识目录规划失败"].slice(0, 8),
        }
    }
}

function renderWikiCandidateCatalog(candidates: KnowledgeCandidate[]) {
    return candidates.map((candidate) => [
        `- ${candidate.pageKey} | ${candidate.kind} | ${candidate.name}`,
        candidate.aliases.length > 0 ? ` | 别名：${candidate.aliases.join("、")}` : "",
        candidate.summary ? ` | 摘要：${candidate.summary}` : "",
    ].join("")).join("\n")
}

function renderRelationCatalog(relations: ExtractedKnowledgeRelation[]) {
    if (relations.length === 0) return "（未抽取到有依据的页面关系）"
    return relations.map((relation) => [
        `${relation.fromPageKey} --${relation.relationType}--> ${relation.toPageKey}`,
        relation.description ? `：${relation.description}` : "",
    ].join("")).join("\n")
}

function buildFallbackWikiPage(candidate: KnowledgeCandidate, relations: ExtractedKnowledgeRelation[]) {
    const related = relations.filter((relation) => (
        relation.fromPageKey === candidate.pageKey || relation.toPageKey === candidate.pageKey
    ))
    return [
        `# ${candidate.name}`,
        "",
        candidate.summary || "暂无足够的原文信息生成详细页面。",
        ...(related.length > 0 ? [
            "",
            "## 相关知识",
            ...related.map((relation) => {
                const target = relation.fromPageKey === candidate.pageKey
                    ? relation.toPageKey
                    : relation.fromPageKey
                return `- [[${target}|${target}]]：${relation.description || relation.relationType}`
            }),
        ] : []),
    ].join("\n")
}

function normalizeGeneratedPageContent(value: unknown, candidate: KnowledgeCandidate) {
    const raw = typeof value === "string" ? value.trim() : ""
    if (!raw) return `# ${candidate.name}\n\n${candidate.summary || "暂无详细说明。"}`
    const withoutProcessingMetadata = raw
        .replace(/^SUMMARY:\s*[^\n]*\n+/i, "")
        .replace(/^依据切片[^\n]*\n?/gim, "")
        .replace(/`?chunk-\d+`?/gi, "")
        .trim()
    if (/^#\s+/m.test(withoutProcessingMetadata)) return withoutProcessingMetadata
    return `# ${candidate.name}\n\n${withoutProcessingMetadata}`
}

async function materializeWikiPages(input: z.infer<typeof wikiMaterializationInputSchema>) {
    if (input.candidates.length === 0) {
        return {
            chunks: input.chunks,
            documentSummary: input.documentSummary,
            items: [] as ExtractedKnowledgeItem[],
            relations: input.relations,
            warnings: input.warnings,
        }
    }

    const warnings = [...input.warnings]
    const batches = batchValues(input.candidates, WIKI_PAGE_BATCH_SIZE)
    const outputs = await mapWithConcurrency(batches, WIKI_PAGE_BATCH_CONCURRENCY, async (batch) => {
        const fallback = batch.map((candidate) => ({
            pageKey: candidate.pageKey,
            summary: candidate.summary,
            contentMd: buildFallbackWikiPage(candidate, input.relations),
        }))
        try {
            const result = await callChatCompletion({
                userId: input.userId,
                systemPrompt: [
                    "你是 Wiki 页面编译器。候选已经由整篇文档抽取完成，现在为每个候选生成一篇独立、完整、可直接阅读的 Markdown 页面。",
                    "页面正文必须依据整篇 document_markdown 中与该候选直接相关的内容，禁止补充外部事实、禁止把邻近对象的事实混入本页。",
                    "不要输出 chunk id、切片编号、处理过程、‘来自某文档’分段或候选抽取说明；来源由系统单独保存。",
                    "保留原文已有的合理结构；以 '# 页面标题' 开头，可使用段落、列表、代码块和二三级标题。",
                    "正文凡提到 relations 中相关页面的名称，首次出现必须使用 [[pageKey|显示名称]] 链接；不得发明页面 key，不得自链接。",
                    "对每个 requested_pages 条目返回一项，只输出 JSON：{\"pages\":[{\"pageKey\":\"\",\"summary\":\"15-80字独立摘要\",\"contentMd\":\"完整 Markdown\"}]}。",
                    "JSON 字符串中的换行必须使用转义字符。",
                ].join("\n"),
                message: [
                    "<valid_wiki_pages>",
                    renderWikiCandidateCatalog(input.candidates),
                    "</valid_wiki_pages>",
                    "<relations>",
                    renderRelationCatalog(input.relations),
                    "</relations>",
                    "<requested_pages>",
                    renderWikiCandidateCatalog(batch),
                    "</requested_pages>",
                    "<document_markdown>",
                    buildWholeDocumentContext(input.contentMd),
                    "</document_markdown>",
                ].join("\n\n"),
            })
            const parsed = extractJsonObject(result.answer)
            const rawPages = Array.isArray(parsed?.pages) ? parsed.pages : []
            const pageByKey = new Map<string, Record<string, unknown>>()
            for (const raw of rawPages) {
                if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
                const value = raw as Record<string, unknown>
                const rawKey = typeof value.pageKey === "string" ? value.pageKey : ""
                const key = normalizePageKey(rawKey, inferPageKind(rawKey), rawKey)
                pageByKey.set(key, value)
            }
            return batch.map((candidate, index) => {
                const value = pageByKey.get(candidate.pageKey)
                if (!value) return fallback[index]
                return {
                    pageKey: candidate.pageKey,
                    summary: typeof value.summary === "string" && value.summary.trim()
                        ? value.summary.trim().slice(0, 500)
                        : candidate.summary,
                    contentMd: normalizeGeneratedPageContent(value.contentMd, candidate),
                }
            })
        } catch (error) {
            warnings.push(error instanceof Error ? `Wiki 页面生成失败：${error.message}` : "Wiki 页面生成失败，已使用候选摘要")
            return fallback
        }
    })

    const generatedByKey = new Map(outputs.flat().map((page) => [page.pageKey, page]))
    const items = input.candidates.map((candidate) => {
        const pageRelations = input.relations.filter((relation) => (
            relation.fromPageKey === candidate.pageKey || relation.toPageKey === candidate.pageKey
        ))
        const relatedPageKeys = [...new Set(pageRelations.map((relation) => (
            relation.fromPageKey === candidate.pageKey ? relation.toPageKey : relation.fromPageKey
        )))]
        const generated = generatedByKey.get(candidate.pageKey)
        return {
            ...candidate,
            summary: generated?.summary || candidate.summary,
            contentMd: generated?.contentMd || buildFallbackWikiPage(candidate, input.relations),
            relatedPageKeys,
            relations: pageRelations,
        }
    })

    return {
        chunks: input.chunks,
        documentSummary: input.documentSummary,
        items,
        relations: input.relations,
        warnings: [...new Set(warnings)].slice(0, 8),
    }
}

const prepareChunksStep = createStep({
    id: "prepare-markdown-chunks",
    inputSchema: workflowInputSchema,
    outputSchema: preparedDocumentSchema,
    execute: async ({ inputData }) => ({
        ...inputData,
        chunks: splitMarkdownForKnowledgeBuild(inputData.contentMd, inputData.articleTitle).map((chunk) => ({
            ...chunk,
            contentHash: simpleHash(chunk.contentMd),
        })),
    }),
})

const generateQuestionsStep = createStep({
    id: "generate-chunk-questions",
    inputSchema: preparedDocumentSchema,
    outputSchema: questionOutputSchema,
    execute: async ({ inputData }) => generateChunkQuestions(inputData),
})

const extractCandidatesStep = createStep({
    id: "extract-document-candidates",
    inputSchema: preparedDocumentSchema,
    outputSchema: extractionOutputSchema,
    execute: async ({ inputData }) => extractDocumentCandidates(inputData),
})

const combineKnowledgeStep = createStep({
    id: "combine-knowledge-build",
    inputSchema: z.object({
        "generate-chunk-questions": questionOutputSchema,
        "extract-document-candidates": extractionOutputSchema,
    }),
    outputSchema: wikiMaterializationInputSchema,
    execute: async ({ inputData, getStepResult }) => {
        const prepared = getStepResult(prepareChunksStep)
        const questionResult = inputData["generate-chunk-questions"]
        const extractionResult = inputData["extract-document-candidates"]
        const questionsByChunk = new Map(questionResult.chunks.map((chunk) => [chunk.chunkKey, chunk.questions]))
        return {
            ...prepared,
            chunks: prepared.chunks.map((chunk) => ({
                ...chunk,
                recommendedQuestions: questionsByChunk.get(chunk.chunkKey)
                    ?? normalizeRecommendedQuestions([], chunk.heading),
            })),
            documentSummary: extractionResult.documentSummary,
            candidates: extractionResult.candidates,
            relations: extractionResult.relations,
            warnings: [...new Set([...questionResult.warnings, ...extractionResult.warnings])].slice(0, 8),
        }
    },
})

const planKnowledgeTaxonomyStep = createStep({
    id: "plan-knowledge-taxonomy",
    inputSchema: wikiMaterializationInputSchema,
    outputSchema: wikiMaterializationInputSchema,
    execute: async ({ inputData }) => planKnowledgeTaxonomy(inputData),
})

const materializeWikiPagesStep = createStep({
    id: "materialize-wiki-pages",
    inputSchema: wikiMaterializationInputSchema,
    outputSchema: workflowOutputSchema,
    execute: async ({ inputData }) => materializeWikiPages(inputData),
})

export const articleKnowledgeBuildWorkflow = createWorkflow({
    id: "article-knowledge-build",
    inputSchema: workflowInputSchema,
    outputSchema: workflowOutputSchema,
})
    .then(prepareChunksStep)
    .parallel([generateQuestionsStep, extractCandidatesStep])
    .then(combineKnowledgeStep)
    .then(planKnowledgeTaxonomyStep)
    .then(materializeWikiPagesStep)
    .commit()

export async function runArticleKnowledgeBuildWorkflow(input: WorkflowInput): Promise<KnowledgeBuildWorkflowResult> {
    const run = await articleKnowledgeBuildWorkflow.createRun()
    const result = await run.start({ inputData: input })
    if (result.status !== "success") {
        if (result.status === "failed") throw result.error
        throw new Error(`知识构建流程未完成：${result.status}`)
    }
    return result.result
}
