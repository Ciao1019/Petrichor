import { describe, expect, it } from "vitest"

import { extractArticleIdFromTreeNodeKey, parseMarkdownTree } from "./wiki-tree"

describe("parseMarkdownTree", () => {
    it("把引言归入根节点，并按标题层级建立父子关系", () => {
        const md = [
            "开篇说明。",
            "",
            "# 一级标题",
            "一级正文。",
            "## 二级标题 A",
            "二级正文 A。",
            "## 二级标题 B",
            "二级正文 B。",
            "# 另一个一级",
            "结尾。",
        ].join("\n")

        const nodes = parseMarkdownTree(md, "我的文档")

        // 根 + 4 个标题节点
        expect(nodes).toHaveLength(5)

        const root = nodes[0]
        expect(root.depth).toBe(0)
        expect(root.title).toBe("我的文档")
        expect(root.parentPosition).toBeNull()
        expect(root.contentMd).toBe("开篇说明。")

        const h1 = nodes[1]
        expect(h1.depth).toBe(1)
        expect(h1.title).toBe("一级标题")
        expect(h1.parentPosition).toBe(0)
        expect(h1.contentMd).toBe("一级正文。")

        const h2a = nodes[2]
        expect(h2a.depth).toBe(2)
        expect(h2a.title).toBe("二级标题 A")
        expect(h2a.parentPosition).toBe(1)

        const h2b = nodes[3]
        expect(h2b.parentPosition).toBe(1)

        const secondH1 = nodes[4]
        expect(secondH1.depth).toBe(1)
        expect(secondH1.parentPosition).toBe(0)
        expect(secondH1.contentMd).toBe("结尾。")
    })

    it("忽略围栏代码块内的伪标题", () => {
        const md = [
            "# 真标题",
            "```bash",
            "# 这是注释，不是标题",
            "echo hi",
            "```",
            "正文。",
        ].join("\n")

        const nodes = parseMarkdownTree(md, "doc")

        // 根 + 1 个真标题；代码块里的 # 不算标题
        expect(nodes).toHaveLength(2)
        expect(nodes[1].title).toBe("真标题")
        expect(nodes[1].contentMd).toContain("# 这是注释，不是标题")
    })

    it("处理标题层级跳跃（h1 直接到 h3）时父节点取最近的更浅节点", () => {
        const md = ["# A", "## B", "#### D"].join("\n")
        const nodes = parseMarkdownTree(md, "doc")

        const d = nodes.find((node) => node.title === "D")
        const b = nodes.find((node) => node.title === "B")
        expect(d?.parentPosition).toBe(b?.position)
    })

    it("无标题文档全部内容归入根节点", () => {
        const nodes = parseMarkdownTree("只有一段纯文本，没有任何标题。", "纯文本")
        expect(nodes).toHaveLength(1)
        expect(nodes[0].depth).toBe(0)
        expect(nodes[0].contentMd).toBe("只有一段纯文本，没有任何标题。")
    })
})

describe("extractArticleIdFromTreeNodeKey", () => {
    it("从 nodeKey 解析 articleId", () => {
        expect(extractArticleIdFromTreeNodeKey("a42-3")).toBe(42)
        expect(extractArticleIdFromTreeNodeKey("a7-0")).toBe(7)
    })

    it("非法 nodeKey 返回 null", () => {
        expect(extractArticleIdFromTreeNodeKey("source-1")).toBeNull()
        expect(extractArticleIdFromTreeNodeKey("nope")).toBeNull()
    })
})
