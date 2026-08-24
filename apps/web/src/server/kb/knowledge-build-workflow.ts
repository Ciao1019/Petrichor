import { createStep, createWorkflow } from "@mastra/core/workflows"
import { z } from "zod"

import { createLogger, toLogError } from "@/lib/logger"
import { callChatCompletion } from "@/server/ai/generation"

const log = createLogger("knowledge-build-workflow")

const KNOWLEDGE_CHUNK_MAX_CHARS = 3_200
/** 贪心合并的目标尺寸；对齐 RAGFlow 512 token / LlamaIndex 1024 的主流区间 */
const KNOWLEDGE_CHUNK_TARGET_CHARS = 1_200
/** 贪心扫完后过小的尾块向前合并的阈值 */
const KNOWLEDGE_CHUNK_MIN_TAIL_CHARS = 400
/** 短标题守卫：不足此长度的段落不得独立成片（对标 RAGFlow _is_short_header 的 <50 token） */
const KNOWLEDGE_SHORT_HEADING_CHARS = 120
/** 合并后沿用某一段标题所需的字符占比 */
const HEADING_DOMINANCE_RATIO = 0.6
const KNOWLEDGE_CHUNK_OVERLAP_CHARS = 320
const KNOWLEDGE_CHUNK_LIMIT = 120
/**
 * 问题生成的分批预算。按字符数而非固定条数分批：分片放大后，固定 8 条会让单次
 * 请求塞进近万字并要求一次输出 24 个问题，模型的 JSON 会被截断，多数分片只能
 * 生成不完整。条数上限只作兜底。
 */
const QUESTION_BATCH_MAX_CHARS = 4_000
const QUESTION_BATCH_MAX_ITEMS = 4
const QUESTION_BATCH_CONCURRENCY = 3
const WIKI_DOCUMENT_MAX_CHARS = 72_000
const WIKI_ITEM_LIMIT = 24
const WIKI_PAGE_BATCH_SIZE = 4
const WIKI_PAGE_BATCH_CONCURRENCY = 3

/**
 * v5 统一 Wiki 一级目录：文章名/产品名不再作为目录根节点，旧路径会在文章重建时重新规划。
 */
export const ARTICLE_KNOWLEDGE_BUILD_VERSION = 5

export const KNOWLEDGE_TOP_LEVEL_CATEGORIES = [
    "工具介绍",
    "安装与环境",
    "核心功能",
    "配置与定制",
    "使用技巧",
    "安全与兼容",
] as const

type KnowledgeTopLevelCategory = typeof KNOWLEDGE_TOP_LEVEL_CATEGORIES[number]

const KNOWLEDGE_TOP_LEVEL_CATEGORY_SET = new Set<string>(KNOWLEDGE_TOP_LEVEL_CATEGORIES)

const KNOWLEDGE_CATEGORY_ALIASES: Array<{
    category: KnowledgeTopLevelCategory
    pattern: RegExp
}> = [
    { category: "工具介绍", pattern: /^(工具|产品|软件)(介绍|概览|信息|说明)?$|^(相关|同类)工具$|^软件工具$|^平台$/i },
    { category: "安装与环境", pattern: /安装|部署|运行环境|使用环境|操作系统|包管理/i },
    { category: "核心功能", pattern: /核心功能|功能说明|主要功能|清理对象/i },
    { category: "配置与定制", pattern: /配置|定制|自定义/i },
    { category: "使用技巧", pattern: /使用技巧|进阶功能|高级技巧|命令用法|操作技巧/i },
    { category: "安全与兼容", pattern: /安全|兼容|工具支持|生态支持|权限|隐私/i },
]

type KnowledgeCategoryFallback = Pick<KnowledgeCandidate, "kind" | "name" | "summary">

/**
 * 分片算法版本。与 ARTICLE_KNOWLEDGE_BUILD_VERSION 解耦：后者只用于筛选可复用的
 * Wiki 目录路径，升它会让模型重新发明目录树。切分逻辑变更只应动这个常量。
 * 存量数据没有该字段，读取时按 0 处理，从而被判定为过期并引导重建。
 */
export const CHUNK_ALGORITHM_VERSION = 2

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
    /** 完整标题路径，如 ["架构", "存储"]；导语段为空数组 */
    headingPath: z.array(z.string()),
    contentMd: z.string(),
    contentHash: z.string(),
})

const preparedDocumentSchema = workflowInputSchema.extend({
    chunks: z.array(knowledgeChunkSchema),
    /** 分片阶段产生的告警（如触达数量上限被截断），并入最终 warnings */
    chunkWarnings: z.array(z.string()),
})

const chunkQuestionsSchema = z.object({
    chunkKey: z.string(),
    questions: z.array(z.string()).max(3),
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
    chunks: z.array(knowledgeChunkSchema.extend({ recommendedQuestions: z.array(z.string()).max(3) })),
    documentSummary: z.string(),
    candidates: z.array(knowledgeCandidateSchema),
    relations: z.array(knowledgeRelationSchema),
    warnings: z.array(z.string()),
})

const workflowOutputSchema = z.object({
    chunks: z.array(knowledgeChunkSchema.extend({ recommendedQuestions: z.array(z.string()).max(3) })),
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

async function runLoggedStage<T>(
    input: Pick<WorkflowInput, "userId" | "knowledgeBaseId" | "articleId">,
    stage: string,
    task: () => Promise<T>,
): Promise<T> {
    const startedAt = performance.now()
    const stageLog = log.child({
        stage,
        userId: input.userId,
        knowledgeBaseId: input.knowledgeBaseId,
        articleId: input.articleId,
    })
    stageLog.debug("知识构建阶段开始")
    try {
        const result = await task()
        stageLog.info({ durationMs: Math.round(performance.now() - startedAt) }, "知识构建阶段完成")
        return result
    } catch (error) {
        stageLog.error({
            err: toLogError(error),
            durationMs: Math.round(performance.now() - startedAt),
        }, "知识构建阶段失败")
        throw error
    }
}

const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const FENCE_PATTERN = /^\s*(```|~~~)/

export type MarkdownSection = {
    /** 完整标题路径（不含文章标题），导语段为空数组 */
    headingPath: string[]
    heading: string
    text: string
}

/** 围栏区间 [start, end)，断点不得落在其中，避免代码块被拦腰截断 */
type FenceSpan = { start: number; end: number }

function collectFenceSpans(text: string): FenceSpan[] {
    const spans: FenceSpan[] = []
    let offset = 0
    let openAt: number | null = null
    for (const line of text.split("\n")) {
        if (FENCE_PATTERN.test(line)) {
            if (openAt == null) openAt = offset
            else {
                spans.push({ start: openAt, end: offset + line.length })
                openAt = null
            }
        }
        offset += line.length + 1
    }
    // 未闭合围栏保护到文末
    if (openAt != null) spans.push({ start: openAt, end: text.length })
    return spans
}

function fenceSpanAt(spans: FenceSpan[], index: number): FenceSpan | null {
    return spans.find((span) => index > span.start && index < span.end) ?? null
}

/**
 * 阶段 ①：结构解析。所有 h1–h6 都是候选边界（层级无关，不假设作者的标题习惯），
 * 围栏内的 # 不算标题；每段记录完整标题路径，供合并后归属与问题生成定位使用。
 */
export function parseMarkdownSections(markdown: string, articleTitle: string): MarkdownSection[] {
    const normalized = markdown.replace(/\r\n?/g, "\n").trim()
    if (!normalized) return []

    const sections: MarkdownSection[] = []
    const stack: Array<{ level: number; title: string }> = []
    let buffer: string[] = []
    let inFence = false

    const flush = () => {
        const text = buffer.join("\n").trim()
        buffer = []
        if (!text) return
        sections.push({
            headingPath: stack.map((item) => item.title),
            heading: stack.at(-1)?.title ?? (articleTitle.trim() || "文档正文"),
            text,
        })
    }

    for (const line of normalized.split("\n")) {
        if (FENCE_PATTERN.test(line)) {
            inFence = !inFence
            buffer.push(line)
            continue
        }
        const match = inFence ? null : line.match(HEADING_PATTERN)
        if (match) {
            flush()
            const level = match[1].length
            while (stack.length > 0 && stack.at(-1)!.level >= level) stack.pop()
            stack.push({ level, title: match[2].trim() || articleTitle })
        }
        buffer.push(line)
    }
    flush()
    return sections
}

/** 纯标题、正文极短的段落不得独立成片（对标 RAGFlow naive.py 的 _is_short_header） */
function isShortHeadingOnly(section: MarkdownSection) {
    return section.text.length <= KNOWLEDGE_SHORT_HEADING_CHARS
}

/**
 * 合并后的身份归属：某一段占绝对多数（≥60% 字符）时沿用它的标题，
 * 否则锚定到分片里第一个有实质内容的段落——分片从哪里开始就叫什么。
 *
 * 这里刻意不用最近公共祖先：文档顶层常常是 h2 而非单一 h1，跨同级标题合并时
 * 公共祖先会退化成空路径，绝大多数分片都会掉回文章标题，等于没有路径。
 */
function resolveMergedHeading(group: MarkdownSection[], articleTitle: string) {
    if (group.length === 1) return { heading: group[0].heading, headingPath: group[0].headingPath }
    const total = group.reduce((sum, section) => sum + section.text.length, 0)
    const dominant = group.find((section) => section.text.length >= total * HEADING_DOMINANCE_RATIO)
    // 纯标题存根不配定义分片身份，锚点落到第一个有实质内容的段落
    const anchor = dominant ?? group.find((section) => !isShortHeadingOnly(section)) ?? group[0]
    return {
        heading: anchor.headingPath.at(-1) ?? (articleTitle.trim() || "文档正文"),
        headingPath: anchor.headingPath,
    }
}

/** 顶层主题锚点：导语段（空路径）用哨兵值，保证只与导语自身合并 */
function topLevelOf(section: MarkdownSection) {
    return section.headingPath[0] ?? "\u0000导语"
}

function groupLength(group: MarkdownSection[]) {
    return group.reduce((sum, section) => sum + section.text.length, 0)
}

/**
 * 阶段 ②：贪心合并。相邻小节累加到接近 TARGET 为止；只含短标题的累积块
 * 无条件继续吸收。两条硬约束：
 * 1. 顶层主题边界（headingPath[0] 不同的两个小节不得同片）——否则「安装指南」
 *    尾部会和「快速开始」缝在一起，身份标签也会随机落在中间主题上；
 * 2. 兜底合并同样不得跨顶层主题、不得超过硬上限。
 */
function mergeSections(sections: MarkdownSection[], articleTitle: string) {
    const groups: MarkdownSection[][] = []
    let current: MarkdownSection[] = []
    let currentLength = 0

    for (const section of sections) {
        if (current.length === 0) {
            current = [section]
            currentLength = section.text.length
            continue
        }
        const sameTop = topLevelOf(section) === topLevelOf(current[0])
        const onlyShortHeading = current.every(isShortHeadingOnly)
        const projected = currentLength + section.text.length + 1
        // 对标 RAGFlow 的 OVER_CAP：累积块还不达标时允许越过目标值一次，
        // 否则「小节 + 紧随其后的大节」会把前面那个小块留成孤儿。
        const mayOverflow = currentLength < KNOWLEDGE_CHUNK_MIN_TAIL_CHARS && projected <= KNOWLEDGE_CHUNK_MAX_CHARS
        if (!sameTop || (!onlyShortHeading && !mayOverflow && projected > KNOWLEDGE_CHUNK_TARGET_CHARS)) {
            groups.push(current)
            current = [section]
            currentLength = section.text.length
            continue
        }
        current.push(section)
        currentLength = projected
    }
    if (current.length > 0) groups.push(current)

    // 小组兜底：不足 MIN 的组优先向后并入同主题邻组，其次向前并；均受硬上限约束。
    // 只兜尾块不够：顶层主题切换处随时可能产生百来字的孤立小组。
    for (let index = groups.length - 1; index >= 0; index -= 1) {
        const group = groups[index]
        if (groupLength(group) >= KNOWLEDGE_CHUNK_MIN_TAIL_CHARS) continue
        const next = groups[index + 1]
        const prev = groups[index - 1]
        const length = groupLength(group)
        if (next && topLevelOf(next[0]) === topLevelOf(group[0]) && length + groupLength(next) <= KNOWLEDGE_CHUNK_MAX_CHARS) {
            groups.splice(index, 2, [...group, ...next])
        } else if (prev && topLevelOf(prev[0]) === topLevelOf(group[0]) && length + groupLength(prev) <= KNOWLEDGE_CHUNK_MAX_CHARS) {
            groups.splice(index - 1, 2, [...prev, ...group])
        }
    }

    return groups.map((group) => ({
        ...resolveMergedHeading(group, articleTitle),
        text: group.map((section) => section.text).join("\n\n"),
    }))
}

const SENTENCE_END_PATTERN = /[。！？；!?;]/g

/** 在 [from, to) 内找最靠后的、不落在围栏中的分隔点；优先级 \n\n > \n > 句终符 */
function findBreakPoint(text: string, from: number, to: number, spans: FenceSpan[]): number | null {
    const candidates: number[] = []
    const paragraph = text.lastIndexOf("\n\n", to)
    if (paragraph > from) candidates.push(paragraph)
    const line = text.lastIndexOf("\n", to)
    if (line > from) candidates.push(line)
    SENTENCE_END_PATTERN.lastIndex = 0
    let sentence = -1
    for (const match of text.slice(from, to).matchAll(SENTENCE_END_PATTERN)) {
        sentence = from + match.index + match[0].length
    }
    if (sentence > from) candidates.push(sentence)
    for (const candidate of candidates) {
        if (!fenceSpanAt(spans, candidate)) return candidate
    }
    return null
}

/**
 * 阶段 ③：超长回退切分。仅对单段就超过硬上限的内容生效；断点按分隔符优先级降级，
 * 落在代码围栏内则改用围栏结束位（宁可超长也不切碎代码块）。
 */
function splitLongSection(text: string, maxChars: number, overlapChars: number): string[] {
    if (text.length <= maxChars) return [text]
    const spans = collectFenceSpans(text)
    const chunks: string[] = []
    let cursor = 0
    while (cursor < text.length) {
        const hardEnd = Math.min(text.length, cursor + maxChars)
        let end = hardEnd
        if (hardEnd < text.length) {
            const floor = cursor + Math.floor(maxChars * 0.55)
            const candidate = findBreakPoint(text, floor, hardEnd, spans)
            if (candidate != null) end = candidate
            else {
                // 找不到合法断点：若硬切点落在围栏内，顺延到围栏结束，保住代码块完整
                const span = fenceSpanAt(spans, hardEnd)
                end = span ? span.end : hardEnd
            }
        }
        const value = text.slice(cursor, end).trim()
        if (value) chunks.push(value)
        if (end >= text.length) break
        // 重叠区对齐到行边界，避免半句重叠；回退点落在围栏内则放弃重叠，
        // 否则下一个切片会从代码块中间开始，围栏标记不成对。
        let next = Math.max(end - overlapChars, cursor + 1)
        const overlapSpan = fenceSpanAt(spans, next)
        if (overlapSpan) next = Math.max(overlapSpan.end, cursor + 1)
        const aligned = text.indexOf("\n", next)
        cursor = aligned > next && aligned < end ? aligned + 1 : next
    }
    return chunks
}

/**
 * 按 Markdown 结构切片：结构解析 → 贪心合并 → 超长回退 → 组装。
 * 切片服务于检索和推荐问题；Wiki 的候选抽取与页面正文生成始终读取整篇 Markdown。
 */
export function splitMarkdownForKnowledgeBuild(
    markdown: string,
    articleTitle: string,
    maxChars = KNOWLEDGE_CHUNK_MAX_CHARS,
): { chunks: Omit<RawChunk, "contentHash">[]; truncated: boolean } {
    const sections = parseMarkdownSections(markdown, articleTitle)
    if (sections.length === 0) return { chunks: [], truncated: false }

    const chunks: Omit<RawChunk, "contentHash">[] = []
    let truncated = false
    for (const merged of mergeSections(sections, articleTitle)) {
        for (const piece of splitLongSection(merged.text, maxChars, KNOWLEDGE_CHUNK_OVERLAP_CHARS)) {
            if (chunks.length >= KNOWLEDGE_CHUNK_LIMIT) {
                truncated = true
                return { chunks, truncated }
            }
            const position = chunks.length
            chunks.push({
                chunkKey: `chunk-${String(position + 1).padStart(3, "0")}`,
                position,
                heading: merged.heading,
                headingPath: merged.headingPath,
                contentMd: piece,
            })
        }
    }
    return { chunks, truncated }
}

export function normalizeRecommendedQuestions(values: unknown): string[] {
    return normalizeStringList(values).slice(0, 3)
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

function resolveKnowledgeTopLevelCategory(value: string): KnowledgeTopLevelCategory | null {
    const normalized = value.trim()
    if (KNOWLEDGE_TOP_LEVEL_CATEGORY_SET.has(normalized)) {
        return normalized as KnowledgeTopLevelCategory
    }
    return KNOWLEDGE_CATEGORY_ALIASES.find(({ pattern }) => pattern.test(normalized))?.category ?? null
}

function inferKnowledgeTopLevelCategory(
    fallback: KnowledgeCategoryFallback,
): KnowledgeTopLevelCategory {
    const text = `${fallback.name} ${fallback.summary}`.toLocaleLowerCase("zh-CN")
    if (/安装|部署|包管理|运行环境|操作系统|homebrew|macports|chocolatey|scoop|winget|termux|终端|terminal/.test(text)) {
        return "安装与环境"
    }
    if (/配置|定制|自定义|格式|schema|常量|logo|模块/.test(text)) return "配置与定制"
    if (/安全|隐私|授权|白名单|兼容|支持|权限/.test(text)) return "安全与兼容"
    if (/技巧|补全|更新|性能|命令|自动化|预览/.test(text)) return "使用技巧"
    return fallback.kind === "entity" ? "工具介绍" : "核心功能"
}

/**
 * 把模型目录收敛到全知识库共享的六个一级主题。
 * - 模型按旧规则返回 `Mole / 核心功能` 时，丢弃文章根目录并提升为 `核心功能`；
 * - 返回旧同义目录（如“配置指南”）时映射到统一名称；
 * - 缺失或无法识别时依据候选语义给出稳定兜底，避免页面落入“未分类”。
 */
export function normalizeUnifiedKnowledgeCategoryPath(
    value: unknown,
    fallback: KnowledgeCategoryFallback,
): string[] {
    const rawPath = normalizeKnowledgeCategoryPath(value)
    let matchedIndex = -1
    let topLevel: KnowledgeTopLevelCategory | null = null
    for (const [index, part] of rawPath.entries()) {
        const resolved = resolveKnowledgeTopLevelCategory(part)
        if (!resolved) continue
        matchedIndex = index
        topLevel = resolved
        break
    }
    topLevel ??= inferKnowledgeTopLevelCategory(fallback)

    // 只有模型第一段已经表达统一主题时才保留第二级；如果主题是从 `产品名 / 主题`
    // 的第二段纠正出来的，产品名必须彻底移除，不能换个层级继续残留。
    const rawDetail = matchedIndex === 0 ? rawPath[1] : null
    const detail = rawDetail
        && !resolveKnowledgeTopLevelCategory(rawDetail)
        && rawDetail.localeCompare(fallback.name, "zh-CN", { sensitivity: "base" }) !== 0
        ? rawDetail
        : null
    return detail ? [topLevel, detail] : [topLevel]
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

/** 按字符预算分批，单片超预算时自成一批 */
export function batchChunksByBudget<T extends { contentMd: string }>(
    chunks: T[],
    maxChars: number,
    maxItems: number,
): T[][] {
    const batches: T[][] = []
    let current: T[] = []
    let currentChars = 0
    for (const chunk of chunks) {
        const size = chunk.contentMd.length
        if (current.length > 0 && (current.length >= maxItems || currentChars + size > maxChars)) {
            batches.push(current)
            current = []
            currentChars = 0
        }
        current.push(chunk)
        currentChars += size
    }
    if (current.length > 0) batches.push(current)
    return batches
}

/** 渲染切片的标题路径，如「架构 > 存储 > Redis」；导语段回落到叶子标题 */
function renderHeadingTrail(chunk: { heading: string; headingPath: string[] }) {
    return chunk.headingPath.length > 0 ? chunk.headingPath.join(" > ") : chunk.heading
}

async function generateChunkQuestions(input: z.infer<typeof preparedDocumentSchema>) {
    const batches = batchChunksByBudget(input.chunks, QUESTION_BATCH_MAX_CHARS, QUESTION_BATCH_MAX_ITEMS)
    const questionLog = log.child({
        stage: "generate-chunk-questions",
        userId: input.userId,
        knowledgeBaseId: input.knowledgeBaseId,
        articleId: input.articleId,
    })

    const requestQuestions = async (batch: RawChunk[]) => {
        // 调用异常直接向上抛出，由工作流把任务标记为失败；模型正常返回但没有给某个
        // 切片生成问题时保留空数组，不能用本地模板伪装成模型结果。
        const result = await callChatCompletion({
            userId: input.userId,
            systemPrompt: [
                "你是知识库问题生成器。为每个 Markdown 切片生成最多 3 个用户可能提出的推荐问题。",
                "尽量生成 3 个；只有切片内容确实无法形成问题时才允许少于 3 个或返回空数组。",
                "heading 是该切片在文档中的完整标题路径（用 > 分隔），可据此判断切片所处的语境层级。",
                "问题必须能仅依据对应切片回答，具体、互不重复，不要输出答案。",
                "只输出 JSON：{\"questions\":{\"chunk-001\":[\"问题1\",\"问题2\",\"问题3\"]}}。",
            ].join("\n"),
            message: batch.map((chunk) => [
                `<chunk id="${chunk.chunkKey}" heading="${renderHeadingTrail(chunk)}">`,
                chunk.contentMd,
                "</chunk>",
            ].join("\n")).join("\n\n"),
        })
        const parsed = extractJsonObject(result.answer)
        const questions = parsed?.questions
        const byKey = questions && typeof questions === "object" && !Array.isArray(questions)
            ? questions as Record<string, unknown>
            : {}
        const chunks = batch.map((chunk) => ({
            chunkKey: chunk.chunkKey,
            questions: normalizeRecommendedQuestions(byKey[chunk.chunkKey]),
        }))
        const emptyChunkKeys = chunks
            .filter((chunk) => chunk.questions.length === 0)
            .map((chunk) => chunk.chunkKey)
        if (emptyChunkKeys.length > 0) {
            questionLog.info({
                emptyCount: emptyChunkKeys.length,
                chunkKeys: emptyChunkKeys,
            }, "模型未给部分切片生成推荐问题，按空问题列表继续构建")
        }
        return chunks
    }

    const outputs = await mapWithConcurrency(
        batches,
        QUESTION_BATCH_CONCURRENCY,
        requestQuestions,
    )
    return {
        chunks: outputs.flat(),
        warnings: [] as string[],
    }
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
        .map((page) => normalizeUnifiedKnowledgeCategoryPath(page.categoryPath, {
            kind: page.kind,
            name: page.title,
            summary: page.summary,
        }))
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
        assignments.set(
            pageKey,
            normalizeUnifiedKnowledgeCategoryPath(value.path ?? value.categoryPath, candidateByKey.get(pageKey)!),
        )
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
            && page.categoryPath.length > 0
        ))
        .map((page) => [
            page.pageKey,
            normalizeUnifiedKnowledgeCategoryPath(page.categoryPath, {
                kind: page.kind,
                name: page.title,
                summary: page.summary,
            }),
        ]))

    try {
        const result = await callChatCompletion({
            userId: input.userId,
            systemPrompt: [
                "你是 Wiki 导航目录规划器。候选实体和概念已经抽取完成，请把整批候选放入全知识库统一、稳定的中文主题目录。",
                "目录只负责语义分组；entity/concept 是页面类型元数据，绝不能建立‘实体’‘概念’两个类型根目录。两类页面必须混合出现在同一棵知识目录中，并由界面图标区分。",
                `一级目录必须且只能从以下六项中选择：${KNOWLEDGE_TOP_LEVEL_CATEGORIES.join("、")}。不得创造其他一级目录。`,
                "文章标题、产品名、工具名、品牌名和来源文档名永远不能作为目录；它们本身应该是‘工具介绍’中的知识页。即使整篇文章只讲一个产品，也必须按知识主题分散归类。",
                "每项输出从宽到窄的 category path，最多 2 级，优先只用 1 级。只有同一一级主题下确有多个稳定子群时才使用简短的二级目录。",
                "目录数量必须显著少于页面数量。禁止一页一目录，禁止把页面标题原样再建成叶子目录，禁止同义目录、单复数目录或不同措辞的重复目录。",
                "existing_folders 只用于复用已经符合上述六类的二级标签，不能据此恢复产品名根目录或创造新的一级目录。",
                "归类参考：产品及相关工具→工具介绍；安装方式、包管理器、终端和运行平台→安装与环境；主要能力→核心功能；配置文件、格式和外观定制→配置与定制；命令、进阶操作和效率方法→使用技巧；权限、隐私、防误操作、兼容性和编辑器/终端支持→安全与兼容。",
                "每个 requested_items 的 pageKey 必须恰好出现一次。只输出 JSON，不要 Markdown 围栏。",
                "输出结构：{\"assignments\":[{\"pageKey\":\"entity-xxx\",\"path\":[\"配置与定制\",\"格式\"]}]}。",
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
                    ?? normalizeUnifiedKnowledgeCategoryPath([], candidate),
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
                categoryPath: existingCategoryByKey.get(candidate.pageKey)
                    ?? normalizeUnifiedKnowledgeCategoryPath([], candidate),
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
    execute: async ({ inputData }) => {
        const { chunks, truncated } = splitMarkdownForKnowledgeBuild(inputData.contentMd, inputData.articleTitle)
        return {
            ...inputData,
            chunks: chunks.map((chunk) => ({ ...chunk, contentHash: simpleHash(chunk.contentMd) })),
            // 截断必须显式上报，不能像旧实现那样静默丢掉文档尾部
            chunkWarnings: truncated
                ? [`文档过长，仅前 ${KNOWLEDGE_CHUNK_LIMIT} 个切片参与了知识构建，后续内容未生成推荐问题`]
                : [],
        }
    },
})

const generateQuestionsStep = createStep({
    id: "generate-chunk-questions",
    inputSchema: preparedDocumentSchema,
    outputSchema: questionOutputSchema,
    execute: async ({ inputData }) => runLoggedStage(
        inputData,
        "generate-chunk-questions",
        () => generateChunkQuestions(inputData),
    ),
})

const extractCandidatesStep = createStep({
    id: "extract-document-candidates",
    inputSchema: preparedDocumentSchema,
    outputSchema: extractionOutputSchema,
    execute: async ({ inputData }) => runLoggedStage(
        inputData,
        "extract-document-candidates",
        () => extractDocumentCandidates(inputData),
    ),
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
        const chunks = prepared.chunks.map((chunk) => {
            const recommendedQuestions = questionsByChunk.get(chunk.chunkKey)
            if (!recommendedQuestions) {
                throw new Error(`推荐问题生成结果缺少切片：${chunk.chunkKey}`)
            }
            return { ...chunk, recommendedQuestions }
        })
        return {
            ...prepared,
            chunks,
            documentSummary: extractionResult.documentSummary,
            candidates: extractionResult.candidates,
            relations: extractionResult.relations,
            warnings: [...new Set([
                ...prepared.chunkWarnings,
                ...questionResult.warnings,
                ...extractionResult.warnings,
            ])].slice(0, 8),
        }
    },
})

const planKnowledgeTaxonomyStep = createStep({
    id: "plan-knowledge-taxonomy",
    inputSchema: wikiMaterializationInputSchema,
    outputSchema: wikiMaterializationInputSchema,
    execute: async ({ inputData }) => runLoggedStage(
        inputData,
        "plan-knowledge-taxonomy",
        () => planKnowledgeTaxonomy(inputData),
    ),
})

const materializeWikiPagesStep = createStep({
    id: "materialize-wiki-pages",
    inputSchema: wikiMaterializationInputSchema,
    outputSchema: workflowOutputSchema,
    execute: async ({ inputData }) => runLoggedStage(
        inputData,
        "materialize-wiki-pages",
        () => materializeWikiPages(inputData),
    ),
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
    const startedAt = performance.now()
    const workflowLog = log.child({
        userId: input.userId,
        knowledgeBaseId: input.knowledgeBaseId,
        articleId: input.articleId,
    })
    workflowLog.info("Mastra 知识构建工作流开始")
    try {
        const run = await articleKnowledgeBuildWorkflow.createRun()
        const result = await run.start({ inputData: input })
        if (result.status !== "success") {
            if (result.status === "failed") throw result.error
            throw new Error(`知识构建流程未完成：${result.status}`)
        }
        workflowLog.info({
            runId: run.runId,
            durationMs: Math.round(performance.now() - startedAt),
            chunkCount: result.result.chunks.length,
            itemCount: result.result.items.length,
            warningCount: result.result.warnings.length,
        }, "Mastra 知识构建工作流完成")
        return result.result
    } catch (error) {
        workflowLog.error({
            err: toLogError(error),
            durationMs: Math.round(performance.now() - startedAt),
        }, "Mastra 知识构建工作流失败")
        throw error
    }
}
