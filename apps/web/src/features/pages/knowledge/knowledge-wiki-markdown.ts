export type WikiMarkdownLinkTarget = {
  pageKey: string
  title: string
}

/** 按 pageKey 取展示标题；查不到返回空值即可（会回退到 pageKey 原文）。 */
export type WikiPageTitleResolver = (pageKey: string) => string | null | undefined

const WIKI_LINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?]]/g
const MARKDOWN_PROTECTED_PATTERN = /(`+[^`]*`+|!?\[[^\]]*]\([^)]*\)|<[^>]+>)/g

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function escapeMarkdownLabel(value: string) {
  return value.replace(/([\\[\]_*`])/g, "\\$1")
}

function readLinkedPageKeys(markdown: string) {
  const keys = new Set<string>()
  for (const match of markdown.matchAll(/\(#wiki-page=([^)]+)\)/g)) {
    try {
      keys.add(decodeURIComponent(match[1]))
    } catch {
      keys.add(match[1])
    }
  }
  return keys
}

/**
 * 把 [[pageKey]] / [[pageKey|标题]] 展开成页内链接，链接文案优先用页面标题。
 *
 * pageKey 是给 Agent 用的寻址锚点（源文档页固定是 `source-<articleId>`），直接展示
 * 会变成一串 `source-9`，所以这里按 key 反查标题；查不到才回退显示 key 原文。
 * 别名与 key 相同时（知识关系段落就是这么生成的）同样按未命名处理。
 */
function replaceWikiLinks(markdown: string, resolveLabel: (pageKey: string) => string) {
  const pattern = new RegExp(WIKI_LINK_PATTERN.source, "g")
  let result = ""
  let lastIndex = 0
  for (let match = pattern.exec(markdown); match != null; match = pattern.exec(markdown)) {
    const pageKey = match[1].trim()
    const alias = match[2]?.trim()
    const label = alias && alias !== pageKey ? alias : resolveLabel(pageKey)
    result += markdown.slice(lastIndex, match.index)
    result += `[${escapeMarkdownLabel(label)}](#wiki-page=${encodeURIComponent(pageKey)})`
    lastIndex = match.index + match[0].length

    // 索引页正文是 `[[key]] 标题：摘要`，key 换成标题后会和后面那截重复，顺手吃掉
    if (label !== pageKey) {
      const duplicate = markdown.slice(lastIndex).match(new RegExp(`^[ \\t]*${escapeRegExp(label)}`))
      if (duplicate) lastIndex += duplicate[0].length
    }
  }
  return result + markdown.slice(lastIndex)
}

/**
 * 把正文中的显式 [[pageKey|标题]] 和相关知识的首次裸文本提及统一转换为页内 Wiki 链接。
 * 代码块、行内代码、已有 Markdown 链接、图片和 HTML 标签保持原样。
 */
export function prepareWikiMarkdown(
  contentMd: string,
  title: string,
  relatedKnowledge: WikiMarkdownLinkTarget[] = [],
  resolvePageTitle?: WikiPageTitleResolver,
) {
  // 调用方给的 pageKey→标题优先；没给就退回相关知识里带的标题（索引页会链到全部页面）
  const relatedTitleByKey = new Map(relatedKnowledge.map((target) => [target.pageKey, target.title]))
  const resolveLabel = (pageKey: string) => (
    resolvePageTitle?.(pageKey)?.trim() || relatedTitleByKey.get(pageKey)?.trim() || pageKey
  )

  const escapedTitle = escapeRegExp(title)
  const markdown = replaceWikiLinks(
    contentMd
      .trim()
      .replace(new RegExp(`^#\\s+${escapedTitle}\\s*\\n+`, "i"), ""),
    resolveLabel,
  )

  const linkedPageKeys = readLinkedPageKeys(markdown)
  const targets = relatedKnowledge
    .filter((target) => target.pageKey.trim() && target.title.trim() && !linkedPageKeys.has(target.pageKey))
    .filter((target, index, values) => values.findIndex((item) => item.pageKey === target.pageKey) === index)
    .sort((left, right) => right.title.length - left.title.length)

  if (targets.length === 0) return markdown

  let inFence = false
  return markdown.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return line
    }
    if (inFence) return line

    const parts = line.split(MARKDOWN_PROTECTED_PATTERN)
    return parts.map((part, index) => {
      if (index % 2 === 1) return part
      let value = part
      for (const target of targets) {
        if (linkedPageKeys.has(target.pageKey)) continue
        const pattern = new RegExp(escapeRegExp(target.title), "iu")
        if (!pattern.test(value)) continue
        value = value.replace(pattern, (label) => (
          `[${escapeMarkdownLabel(label)}](#wiki-page=${encodeURIComponent(target.pageKey)})`
        ))
        linkedPageKeys.add(target.pageKey)
      }
      return value
    }).join("")
  }).join("\n")
}
