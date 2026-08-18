/**
 * 内联引用 remark 插件（§162.17）。
 *
 * 把正文里的 [1] [2] 从纯文本转成可交互节点：
 *   text("结论 [1]。") → text("结论 ") + citation(index=1) + text("。")
 *
 * 与站内既有的 remarkStripDanglingMediaTags 同样是手写树遍历，
 * 不额外引入 unist 依赖。
 */

const CITATION_PATTERN = /\[(\d{1,2})\]/g

type MdNode = {
    type?: string
    value?: string
    children?: MdNode[]
    data?: Record<string, unknown>
    [key: string]: unknown
}

/** 这些节点内部的 [n] 不做转换：代码、链接文本、公式 */
const SKIP_PARENTS = new Set(["code", "inlineCode", "link", "linkReference", "definition", "math", "inlineMath"])

export function remarkCitations() {
    return (tree: unknown) => {
        transform(tree as MdNode, null)
    }
}

function transform(node: MdNode, parentType: string | null): void {
    if (!node || typeof node !== "object") return
    if (parentType && SKIP_PARENTS.has(parentType)) return
    if (!Array.isArray(node.children)) return

    const next: MdNode[] = []
    let changed = false

    for (const child of node.children) {
        if (child?.type === "text" && typeof child.value === "string" && CITATION_PATTERN.test(child.value)) {
            CITATION_PATTERN.lastIndex = 0
            const pieces = splitCitations(child.value)
            if (pieces.length > 1) {
                next.push(...pieces)
                changed = true
                continue
            }
        }
        CITATION_PATTERN.lastIndex = 0
        transform(child, child?.type ?? null)
        next.push(child)
    }

    if (changed) node.children = next
}

export function splitCitations(value: string): MdNode[] {
    const out: MdNode[] = []
    let cursor = 0
    CITATION_PATTERN.lastIndex = 0

    let match: RegExpExecArray | null
    while ((match = CITATION_PATTERN.exec(value)) != null) {
        const index = Number(match[1])
        // [0] 不是有效引用编号，原样保留
        if (!Number.isInteger(index) || index < 1) continue
        if (match.index > cursor) {
            out.push({ type: "text", value: value.slice(cursor, match.index) })
        }
        out.push({
            type: "citation",
            value: String(index),
            data: {
                hName: "citation",
                hProperties: { "data-citation-index": String(index) },
                hChildren: [{ type: "text", value: String(index) }],
            },
        })
        cursor = match.index + match[0].length
    }

    if (out.length === 0) return [{ type: "text", value }]
    if (cursor < value.length) out.push({ type: "text", value: value.slice(cursor) })
    return out
}
