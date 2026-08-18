import { describe, expect, it } from "vitest"
import { remarkCitations, splitCitations } from "./remark-citations"

type Node = { type?: string; value?: string; children?: Node[]; data?: Record<string, unknown> }

function paragraph(text: string): Node {
    return { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: text }] }] }
}

function run(tree: Node): Node {
    remarkCitations()(tree)
    return tree
}

describe("splitCitations", () => {
    it("把 [1] 拆成独立引用节点", () => {
        const parts = splitCitations("结论是这样 [1]。")
        expect(parts.map((part) => part.type)).toEqual(["text", "citation", "text"])
        expect(parts[1].value).toBe("1")
        expect(parts[1].data?.hName).toBe("citation")
    })

    it("支持一句里多个引用", () => {
        const parts = splitCitations("A [1] 和 B [2] 都成立")
        expect(parts.filter((part) => part.type === "citation")).toHaveLength(2)
    })

    it("没有引用时原样返回单个文本节点", () => {
        const parts = splitCitations("普通文本")
        expect(parts).toEqual([{ type: "text", value: "普通文本" }])
    })

    it("[0] 不是有效编号，保持纯文本", () => {
        const parts = splitCitations("数组下标 [0] 的说明")
        expect(parts.every((part) => part.type === "text")).toBe(true)
    })

    it("引用编号写进 hProperties，供组件读取", () => {
        const [, citation] = splitCitations("x [7]")
        expect((citation.data?.hProperties as Record<string, string>)["data-citation-index"]).toBe("7")
    })
})

describe("remarkCitations", () => {
    it("段落内的引用被转换", () => {
        const tree = run(paragraph("现有部署仍使用旧版本 [2]。"))
        const children = tree.children![0].children!
        expect(children.map((child) => child.type)).toEqual(["text", "citation", "text"])
    })

    it("代码块内的方括号不被转换", () => {
        const tree = run({
            type: "root",
            children: [{ type: "paragraph", children: [{ type: "inlineCode", children: [{ type: "text", value: "arr[1]" }] }] }],
        })
        const code = tree.children![0].children![0]
        expect(code.children![0].type).toBe("text")
    })

    it("链接文本内的方括号不被转换", () => {
        const tree = run({
            type: "root",
            children: [{ type: "paragraph", children: [{ type: "link", children: [{ type: "text", value: "见 [1]" }] }] }],
        })
        expect(tree.children![0].children![0].children![0].type).toBe("text")
    })

    it("没有引用的文档结构不变", () => {
        const tree = paragraph("完全没有引用")
        const before = JSON.stringify(tree)
        run(tree)
        expect(JSON.stringify(tree)).toBe(before)
    })

    it("嵌套结构（列表项）内的引用也会被处理", () => {
        const tree = run({
            type: "root",
            children: [{
                type: "list",
                children: [{
                    type: "listItem",
                    children: [{ type: "paragraph", children: [{ type: "text", value: "要点 [3]" }] }],
                }],
            }],
        })
        const inner = tree.children![0].children![0].children![0].children!
        expect(inner.some((child) => child.type === "citation")).toBe(true)
    })
})
