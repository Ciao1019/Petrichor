import { KEYS, type Value } from "platejs"

const TRANSIENT_NODE_TYPES = new Set<string>([KEYS.placeholder])

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}

function isTransientNode(node: unknown) {
    return (
        isRecord(node) &&
        typeof node.type === "string" &&
        TRANSIENT_NODE_TYPES.has(node.type)
    )
}

function hasChildren(node: unknown): node is Record<string, unknown> & { children: unknown[] } {
    return isRecord(node) && Array.isArray(node.children)
}

function createEmptyParagraph(): Value[number] {
    return {
        type: KEYS.p,
        children: [{ text: "" }],
    } as Value[number]
}

function sanitizeNode<T>(node: T): T | null {
    if (isTransientNode(node)) {
        return null
    }

    if (!hasChildren(node)) {
        return node
    }

    const children = node.children
        .map((child) => sanitizeNode(child))
        .filter((child): child is NonNullable<typeof child> => child !== null)

    return {
        ...node,
        children: children.length > 0 ? children : [{ text: "" }],
    } as T
}

/**
 * Plate 上传流程会插入 placeholder 这类临时 UI 节点。
 * 持久化前必须剔除它们，避免 Markdown 序列化命中未知节点，也避免草稿保存临时状态。
 */
export function sanitizeEditorContentForPersistence(value: Value): Value {
    const nodes = value
        .map((node) => sanitizeNode(node))
        .filter((node): node is Value[number] => node !== null)

    return nodes.length > 0 ? nodes : [createEmptyParagraph()]
}
