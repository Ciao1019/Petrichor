import { createHash } from "node:crypto"
import { badRequest } from "@/server/http/response"

export type MindmapMode = "MINDMAP" | "KNOWLEDGE_GRAPH"

export interface MindmapGenerateInput {
    articleId: number
    mode: MindmapMode
    forceRebuild: boolean
}

export interface MindmapNode {
    id?: string
    topic: string
    root?: boolean
    expanded?: boolean
    direction?: 0 | 1
    children?: MindmapNode[]
}

export interface MindmapData {
    nodeData: MindmapNode
    arrows?: Array<{
        id?: string
        label: string
        from: string
        to: string
        bidirectional?: boolean
    }>
}

const mindmapMaxModelInputChars = 12000
const mindmapMaxNodeCount = 120
const mindmapMaxDepth = 6
const mindmapMaxTopicLength = 80
const mindmapMaxArrowCount = 20
const mindmapMaxArrowLabelLength = 20

export function validateMindmapGenerateInput(raw: unknown): MindmapGenerateInput {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    const articleId = String(value.articleId ?? "").trim()
    if (!articleId) {
        throw badRequest("不能为空")
    }
    if (!/^\d+$/.test(articleId)) {
        throw badRequest("需要匹配正则表达式\"\\d+\"")
    }

    const mode = String(value.mode ?? "").trim()
    if (mode && mode !== "MINDMAP" && mode !== "KNOWLEDGE_GRAPH") {
        throw badRequest("mode 非法")
    }

    return {
        articleId: Number(articleId),
        mode: mode === "KNOWLEDGE_GRAPH" ? "KNOWLEDGE_GRAPH" : "MINDMAP",
        forceRebuild: Boolean(value.forceRebuild),
    }
}

export function buildMindmapContentHash(title: string, contentMd: string) {
    return createHash("sha256")
        .update(`${title.trim()}\n${contentMd.trim()}`)
        .digest("hex")
}

export function buildMindmapSystemPrompt(mode: MindmapMode) {
    if (mode === "KNOWLEDGE_GRAPH") {
        return `
你是一个“文章 → 知识图谱”转换器。

请根据用户提供的文章标题与 Markdown 内容，输出一个 JSON 对象（不要输出任何解释文字、不要使用 Markdown 代码块/三个反引号包裹）。
JSON 必须符合 Mind Elixir 的 MindElixirData 结构，并包含 nodeData + arrows：
{
  "nodeData": {
    "id": "root",
    "topic": "根主题",
    "root": true,
    "children": [
      { "id": "n1", "topic": "概念A", "direction": 0, "children": [ ... ] },
      { "id": "n2", "topic": "概念B", "direction": 1, "children": [ ... ] }
    ]
  },
  "arrows": [
    { "label": "关系", "from": "n1", "to": "n2", "bidirectional": false }
  ]
}

规则：
- 仅使用字段：id / topic / children / root / direction / arrows
- 总层级不超过 6 层
- 总节点数不超过 120 个
- arrows 不超过 20 条
- topic 必须是简短中文短语（每个不超过 80 字符）
- arrow label 不超过 20 字符
- 不要虚构文章中不存在的具体事实
`
    }

    return `
你是一个“文章 → 思维导图”转换器。

请根据用户提供的文章标题与 Markdown 内容，输出一个 JSON 对象（不要输出任何解释文字、不要使用 Markdown 代码块/三个反引号包裹）。
JSON 必须符合 Mind Elixir 的 MindElixirData 最小结构：
{
  "nodeData": {
    "topic": "根主题",
    "root": true,
    "children": [
      { "topic": "子主题", "children": [ ... ] }
    ]
  }
}

规则：
- 仅使用字段：topic / children（可选）/ root（仅根节点）
- 总层级不超过 6 层
- 总节点数不超过 120 个
- topic 必须是简短中文短语（每个不超过 80 字符）
- 如果信息不足，可适度归纳，但不要虚构不存在的具体事实
`
}

export function buildMindmapUserMessage(input: {
    knowledgeBaseName: string
    title: string
    contentMd: string
}) {
    const content = input.contentMd.length > mindmapMaxModelInputChars
        ? `${input.contentMd.slice(0, mindmapMaxModelInputChars)}\n\n[内容已截断]`
        : input.contentMd

    return [
        `知识库：${input.knowledgeBaseName}`,
        `文章标题：${input.title}`,
        "",
        "文章 Markdown 内容：",
        content,
    ].join("\n")
}

export function extractJsonObjectText(raw: string) {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start < 0 || end < start) {
        throw badRequest("模型未返回合法 JSON")
    }
    return text.slice(start, end + 1)
}

export function normalizeMindmapModelOutput(raw: unknown, fallbackTitle: string, mode: MindmapMode): MindmapData {
    const rootSource = readObject(raw)?.nodeData ?? raw
    const counter = { value: 0 }
    const root = normalizeNode(rootSource, fallbackTitle || "未命名", 1, counter, mode)
    root.id = "root"
    root.root = true
    root.expanded = true

    const data: MindmapData = { nodeData: root }
    if (mode === "KNOWLEDGE_GRAPH") {
        data.arrows = normalizeArrows(readObject(raw)?.arrows, collectNodeIds(root))
    }
    return data
}

export function isMindmapCacheHit(input: {
    currentHash: string
    storedHash: string | null | undefined
    storedJson: string | null | undefined
}) {
    return Boolean(input.storedJson?.trim()) &&
        Boolean(input.storedHash?.trim()) &&
        input.storedHash === input.currentHash
}

export function buildSimpleMindmapData(title: string, contentMd: string, mode: MindmapMode): MindmapData {
    const root: MindmapNode = {
        id: "root",
        topic: title.trim() || "未命名",
        root: true,
        expanded: true,
        children: extractHeadingNodes(contentMd),
    }

    if (!root.children || root.children.length === 0) {
        root.children = [{ id: "n1", topic: "内容概要" }]
    }

    if (mode === "KNOWLEDGE_GRAPH") {
        root.children = root.children.map((node, index) => ({
            ...node,
            direction: index % 2 === 0 ? 0 : 1,
        }))
        return {
            nodeData: root,
            arrows: root.children.length > 1
                ? root.children.slice(1, 8).map((node, index) => ({
                    id: `a${index + 1}`,
                    label: "关联",
                    from: root.children?.[index]?.id ?? "root",
                    to: node.id ?? `n${index + 2}`,
                    bidirectional: false,
                }))
                : [],
        }
    }

    return { nodeData: root }
}

export function parseJsonOrNull(value: string | null | undefined) {
    const text = value?.trim() ?? ""
    if (!text) {
        return null
    }
    try {
        return JSON.parse(text) as unknown
    } catch {
        return null
    }
}

function normalizeNode(raw: unknown, fallbackTopic: string, depth: number, counter: { value: number }, mode: MindmapMode): MindmapNode {
    const source = readObject(raw)
    const topic = trimTopic(typeof source?.topic === "string" ? source.topic : fallbackTopic)
    const id = counter.value === 0 ? "root" : `n${counter.value}`
    counter.value += 1

    const node: MindmapNode = {
        id,
        topic,
    }
    if (mode === "KNOWLEDGE_GRAPH" && typeof source?.direction === "number") {
        node.direction = source.direction === 1 ? 1 : 0
    }

    const children = Array.isArray(source?.children) ? source.children : []
    if (depth < mindmapMaxDepth && counter.value < mindmapMaxNodeCount) {
        const normalizedChildren: MindmapNode[] = []
        for (const child of children) {
            if (counter.value >= mindmapMaxNodeCount) {
                break
            }
            normalizedChildren.push(normalizeNode(child, "未命名", depth + 1, counter, mode))
        }
        if (normalizedChildren.length > 0) {
            node.children = normalizedChildren
        }
    }
    return node
}

function normalizeArrows(raw: unknown, nodeIds: Set<string>) {
    if (!Array.isArray(raw)) {
        return []
    }
    return raw
        .map((item) => readObject(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .map((item, index) => ({
            id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `a${index + 1}`,
            label: trimTopic(typeof item.label === "string" ? item.label : "关联").slice(0, mindmapMaxArrowLabelLength),
            from: typeof item.from === "string" ? item.from.trim() : "",
            to: typeof item.to === "string" ? item.to.trim() : "",
            bidirectional: Boolean(item.bidirectional),
        }))
        .filter((item) => nodeIds.has(item.from) && nodeIds.has(item.to))
        .slice(0, mindmapMaxArrowCount)
}

function collectNodeIds(root: MindmapNode) {
    const ids = new Set<string>()
    const walk = (node: MindmapNode) => {
        if (node.id) {
            ids.add(node.id)
        }
        for (const child of node.children ?? []) {
            walk(child)
        }
    }
    walk(root)
    return ids
}

function trimTopic(value: string) {
    return (value.trim() || "未命名").slice(0, mindmapMaxTopicLength)
}

function readObject(raw: unknown) {
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null
}

function extractHeadingNodes(contentMd: string) {
    const headings = contentMd
        .split(/\r?\n/)
        .map((line) => line.match(/^(#{1,6})\s+(.+?)\s*$/))
        .filter((match): match is RegExpMatchArray => Boolean(match))
        .slice(0, 120)

    if (headings.length === 0) {
        return []
    }

    const rootChildren: MindmapNode[] = []
    const stack: Array<{ level: number; node: MindmapNode }> = []

    headings.forEach((match, index) => {
        const level = match[1].length
        const node: MindmapNode = {
            id: `n${index + 1}`,
            topic: match[2].trim().slice(0, 80) || "未命名",
        }

        while (stack.length > 0 && stack[stack.length - 1].level >= level) {
            stack.pop()
        }
        const parent = stack[stack.length - 1]?.node
        if (!parent) {
            rootChildren.push(node)
        } else {
            parent.children ??= []
            parent.children.push(node)
        }
        stack.push({ level, node })
    })

    return rootChildren
}
