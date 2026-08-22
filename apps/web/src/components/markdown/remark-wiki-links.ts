const WIKI_LINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?]]/g

/** mdast 最小结构类型（避免直接依赖未安装的 @types/mdast）。 */
type WikiAstNode = { type: string; value?: string; children?: WikiAstNode[]; url?: string }
type WikiTextNode = WikiAstNode & { type: "text"; value: string }

/**
 * 把回答文本中的 [[pageKey]] / [[pageKey|别名]] 转成 #wiki-page= 链接节点。
 *
 * assistant-ui 的 MarkdownTextPrimitive 直接从消息 part 取文本，没有字符串
 * 预处理入口，所以在 mdast 层做转换；未闭合的 `[[`（流式中途）匹配不上会
 * 保持原样，下一帧补齐。代码块/行内代码是独立节点类型，天然不受影响。
 */
export function remarkWikiLinks() {
  return (tree: unknown) => {
    visitTextNodes(tree as WikiAstNode)
  }
}

function visitTextNodes(node: WikiAstNode | undefined) {
  if (!node || !Array.isArray(node.children)) return
  const children = node.children
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (child.type === "text") {
      const replacement = splitWikiLinkText(child as WikiTextNode)
      if (replacement.length > 0) {
        children.splice(index, 1, ...replacement)
        index += replacement.length - 1
      }
      continue
    }
    // 不进入 link 子树，避免把已有链接的文案再包一层
    if (child.type === "link") continue
    visitTextNodes(child)
  }
}

function splitWikiLinkText(node: WikiTextNode): Array<WikiAstNode> {
  const value = node.value
  if (!value || !value.includes("[[")) return []
  const parts: Array<WikiAstNode> = []
  let lastIndex = 0
  for (const match of value.matchAll(WIKI_LINK_PATTERN)) {
    const pageKey = match[1].trim()
    const alias = match[2]?.trim()
    if (!pageKey) continue
    const label = alias && alias !== pageKey ? alias : pageKey
    const matchStart = match.index ?? 0
    const matchEnd = matchStart + match[0].length
    if (matchStart > lastIndex) {
      parts.push({ type: "text", value: value.slice(lastIndex, matchStart) })
    }
    parts.push({
      type: "link",
      url: `#wiki-page=${encodeURIComponent(pageKey)}`,
      children: [{ type: "text", value: label }],
    })
    lastIndex = matchEnd
  }
  if (parts.length === 0) return []
  if (lastIndex < value.length) {
    parts.push({ type: "text", value: value.slice(lastIndex) })
  }
  return parts
}
