import { describe, expect, it } from "vitest"

import { remarkWikiLinks } from "./remark-wiki-links"

type Node = { type: string; value?: string; url?: string; children?: Node[] }

function run(text: string): Node {
  const tree: Node = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: text }] }] }
  remarkWikiLinks()(tree)
  return tree
}

describe("remarkWikiLinks", () => {
  it("把 [[pageKey|别名]] 转成 #wiki-page 链接节点", () => {
    const tree = run("详见 [[concept-rag|RAG 概念]] 说明。")
    const paragraph = tree.children![0]!
    expect(paragraph.children).toEqual([
      { type: "text", value: "详见 " },
      { type: "link", url: "#wiki-page=concept-rag", children: [{ type: "text", value: "RAG 概念" }] },
      { type: "text", value: " 说明。" },
    ])
  })

  it("无别名时用 pageKey 当文案，并对 pageKey 做 URI 编码", () => {
    const tree = run("[[概念/检索]]")
    const link = tree.children![0]!.children![0]!
    expect(link.type).toBe("link")
    expect(link.url).toBe("#wiki-page=%E6%A6%82%E5%BF%B5%2F%E6%A3%80%E7%B4%A2")
    expect(link.children![0]!.value).toBe("概念/检索")
  })

  it("流式中途未闭合的 [[ 保持原样", () => {
    const tree = run("详见 [[concept-ra")
    expect(tree.children![0]!.children).toEqual([{ type: "text", value: "详见 [[concept-ra" }])
  })

  it("不进入已有链接的子树", () => {
    const tree: Node = {
      type: "root",
      children: [{
        type: "link",
        url: "https://example.com",
        children: [{ type: "text", value: "见 [[concept-x|X]]" }],
      }],
    }
    remarkWikiLinks()(tree)
    expect(tree.children![0]!.children![0]!.value).toBe("见 [[concept-x|X]]")
  })
})
