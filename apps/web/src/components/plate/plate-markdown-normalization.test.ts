// @vitest-environment jsdom

import { H2Plugin, H3Plugin } from "@platejs/basic-nodes/react"
import { ListPlugin } from "@platejs/list-classic/react"
import { LinkPlugin } from "@platejs/link/react"
import { MarkdownPlugin } from "@platejs/markdown"
import { createPlateEditor, createPlatePlugin } from "platejs/react"
import { NodeApi } from "platejs"
import { describe, expect, it } from "vitest"
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit"
import { preparePublicWikiMarkdown } from "@/features/pages/knowledge/knowledge-wiki-markdown"
import { deserializeMarkdownWithRecovery } from "./plate-markdown-deserialize"
import { EMBED_CARD_TYPE, preprocessEmbedDirectives } from "./plate-embed-directives"

function createWikiEditor(markdown: string) {
    return createPlateEditor({
        // Plate 在 test 环境默认关闭节点 ID，必须显式开启才能覆盖线上初始化路径。
        nodeId: true,
        plugins: [
            H2Plugin, H3Plugin, ListPlugin, LinkPlugin,
            createPlatePlugin({ key: EMBED_CARD_TYPE, node: { isElement: true, isVoid: true } }),
            ...MarkdownKit,
        ],
        value: (editor) => deserializeMarkdownWithRecovery(editor, preprocessEmbedDirectives(markdown)),
    })
}

describe("Markdown 异常恢复", () => {
    it("保留命令占位符、Wiki 链接和长列表后的章节，初始化与更新均不崩溃", () => {
        const content = [
            "# 使用说明",
            "## 格式字符串",
            "- [[concept-format|格式字符串]]：{name}/{index} 占位符，用 -h <模块>-format 查看标签。",
            ...Array.from({ length: 24 }, (_, index) => `- [[concept-format|配置 ${index}]]：后续知识内容。`),
            "",
            "## 推荐问题",
            "### 自定义常量",
            "- 如何在配置文件中显示未配对的 { 字符？",
            "",
            "## 来源",
            "- 源文档 ID：2",
        ].join("\n")
        const markdown = preparePublicWikiMarkdown(content, "使用说明", "1", [
            { pageKey: "concept-format", title: "格式字符串" },
        ])
        const editor = createWikiEditor(markdown)
        const value = deserializeMarkdownWithRecovery(editor, markdown)
        expect(() => editor.tf.setValue(value)).not.toThrow()

        const text = NodeApi.string(editor)
        expect(text).toContain("{name}/{index}")
        expect(text).toContain("<模块>-format")
        expect(text).toContain("未配对的 { 字符")
        expect(text).toContain("源文档 ID：2")
        expect(editor.children.filter((node) => node.type === "h2").map(NodeApi.string))
            .toEqual(["格式字符串", "推荐问题", "来源"])
        const links = [...editor.api.nodes({ at: [], match: { type: "a" } })]
        expect(links).toHaveLength(25)
        expect(links.every(([node]) => node.url === "/wiki/1/concept-format")).toBe(true)
    })

    it("更新为含有花括号的另一页时完整替换正文", () => {
        const editor = createWikiEditor("## 旧页\n\n- 旧内容")
        editor.tf.setValue(deserializeMarkdownWithRecovery(editor, "## 新页\n\n- 使用 {name} 和 <参数>\n\n## 结尾\n\n正文结束"))
        expect(NodeApi.string(editor)).toBe("新页使用 {name} 和 <参数>结尾正文结束")
        expect(NodeApi.string(editor)).not.toContain("旧内容")
    })

    it("正常的 MDX 卡片、格式、表格和代码块与原解析结果完全一致", () => {
        const editor = createWikiEditor("")
        const markdown = preprocessEmbedDirectives([
            "## 内容",
            '::github{repo="Ciao1019/Petrichor"}',
            '<span style="color: red">彩色文字</span>',
            "**粗体** 和 `code` 与 [链接](https://example.com)",
            "| 名称 | 值 |\n| --- | --- |\n| A | 1 |",
            "```tsx\nconst node = <Card>{value}</Card>\n```",
        ].join("\n\n"))
        expect(deserializeMarkdownWithRecovery(editor, markdown))
            .toEqual(editor.getApi(MarkdownPlugin).markdown.deserialize(markdown))
    })

    it("损坏的占位符前后仍保留有效 MDX 卡片和行内样式", () => {
        const markdown = preprocessEmbedDirectives([
            '::github{repo="Ciao1019/Petrichor"}',
            '<span style="color: red">彩色文字</span>',
            "- 用 -h <模块>-format 查看命令\n- 输入未配对的 { 字符",
            "## 后续章节",
            '::html{url="/tools/example.html" title="交互图" height="500"}',
        ].join("\n\n"))
        const editor = createWikiEditor(markdown)
        expect(editor.children.filter((node) => node.type === EMBED_CARD_TYPE))
            .toMatchObject([
                { provider: "github", repo: "Ciao1019/Petrichor" },
                { provider: "html", url: "/tools/example.html", height: 500 },
            ])
        expect(JSON.stringify(editor.children)).toContain('"color":"red"')
        expect(NodeApi.string(editor)).toContain("后续章节")
    })
})
