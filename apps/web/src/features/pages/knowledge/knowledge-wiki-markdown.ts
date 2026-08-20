export type WikiMarkdownLinkTarget = {
  pageKey: string
  title: string
}

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
 * 把正文中的显式 [[pageKey|标题]] 和相关知识的首次裸文本提及统一转换为页内 Wiki 链接。
 * 代码块、行内代码、已有 Markdown 链接、图片和 HTML 标签保持原样。
 */
export function prepareWikiMarkdown(
  contentMd: string,
  title: string,
  relatedKnowledge: WikiMarkdownLinkTarget[] = [],
) {
  const escapedTitle = escapeRegExp(title)
  const markdown = contentMd
    .trim()
    .replace(new RegExp(`^#\\s+${escapedTitle}\\s*\\n+`, "i"), "")
    .replace(WIKI_LINK_PATTERN, (_match, pageKey: string, label?: string) => (
      `[${escapeMarkdownLabel(label?.trim() || pageKey.trim())}](#wiki-page=${encodeURIComponent(pageKey.trim())})`
    ))

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
