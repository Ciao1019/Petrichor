/** 普通问答里可画 Wiki 波浪线的实体/概念。来源角标仍单独使用 [n]。 */
export type WikiMentionTarget = {
  pageKey: string
  title: string
  aliases: string[]
  kind: string | null
  citationIndex: number | null
}

const WIKI_LINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?]]/g
const MARKDOWN_PROTECTED_PATTERN = /(`+[^`]*`+|!?\[[^\]]*]\([^)]*\)|\[\[[^\]]+]]|<[^>]+>)/g
const SENTENCE_END_PATTERN = /^[ \t]*(?:[。！？.!?]|$)/
const MENTIONABLE_KINDS = new Set(["concept", "entity"])

function inferKind(pageKey: string): string | null {
  const match = pageKey.match(/^(concept|entity)(?:[-/]|$)/i)
  return match?.[1]?.toLowerCase() ?? null
}

function isMentionable(target: Pick<WikiMentionTarget, "kind" | "pageKey">): boolean {
  return MENTIONABLE_KINDS.has(target.kind ?? inferKind(target.pageKey) ?? "")
}

/** 合并“Wiki 全量词典”和“本轮检索证据”；证据里的稳定 [n] 编号优先保留。 */
export function mergeWikiMentionTargets(...lists: WikiMentionTarget[][]): WikiMentionTarget[] {
  const store = new Map<string, WikiMentionTarget>()
  for (const list of lists) {
    for (const target of list) {
      const pageKey = target.pageKey.trim()
      const title = target.title.trim()
      if (!pageKey || !title) continue
      const aliases = target.aliases.map((alias) => alias.trim()).filter(Boolean)
      const current = store.get(pageKey)
      if (current) {
        current.aliases = [...new Set([...current.aliases, ...aliases])]
        if (!current.kind && target.kind) current.kind = target.kind
        if (current.citationIndex == null && target.citationIndex != null) {
          current.citationIndex = target.citationIndex
        }
        continue
      }
      store.set(pageKey, {
        pageKey,
        title,
        aliases,
        kind: target.kind || inferKind(pageKey),
        citationIndex: target.citationIndex,
      })
    }
  }
  return [...store.values()].filter(isMentionable)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function escapeWikiLabel(value: string) {
  return value.replace(/([\\[\]|])/g, "\\$1")
}

function mentionForms(target: WikiMentionTarget): string[] {
  return [...new Set([target.title, ...target.aliases]
    .map((value) => value.trim())
    .filter((value) => value.length >= 2))]
    .sort((left, right) => right.length - left.length)
}

function hasWordBoundary(text: string, index: number, length: number, form: string): boolean {
  const asciiStart = /^[a-z0-9_]/i.test(form)
  const asciiEnd = /[a-z0-9_]$/i.test(form)
  if (asciiStart && index > 0 && /[a-z0-9_]/i.test(text[index - 1] ?? "")) return false
  if (asciiEnd && index + length < text.length && /[a-z0-9_]/i.test(text[index + length] ?? "")) return false
  return true
}

function findMention(text: string, target: WikiMentionTarget): { index: number; label: string } | null {
  let best: { index: number; label: string } | null = null
  for (const form of mentionForms(target)) {
    const pattern = new RegExp(escapeRegExp(form), "igu")
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? -1
      if (index < 0 || !hasWordBoundary(text, index, match[0].length, form)) continue
      if (!best || index < best.index || (index === best.index && match[0].length > best.label.length)) {
        best = { index, label: match[0] }
      }
      break
    }
  }
  return best
}

function sentenceStart(markdown: string, index: number): number {
  const prefix = markdown.slice(0, index)
  return Math.max(
    prefix.lastIndexOf("。"),
    prefix.lastIndexOf("！"),
    prefix.lastIndexOf("？"),
    prefix.lastIndexOf("."),
    prefix.lastIndexOf("!"),
    prefix.lastIndexOf("?"),
    prefix.lastIndexOf("\n"),
  ) + 1
}

/** 把旧提示词生成的句末 Wiki 伪角标恢复成 [n]，波浪线随后移到正文实体上。 */
function replaceTrailingWikiCitations(markdown: string, targets: WikiMentionTarget[]): string {
  const byKey = new Map(targets.map((target) => [target.pageKey, target]))
  let output = ""
  let cursor = 0
  for (const match of markdown.matchAll(WIKI_LINK_PATTERN)) {
    const index = match.index ?? 0
    const target = byKey.get(match[1]?.trim() ?? "")
    if (!target || !/^[ \t]+$/.test(markdown.slice(Math.max(cursor, index - 1), index))) continue
    if (!SENTENCE_END_PATTERN.test(markdown.slice(index + match[0].length))) continue
    if (!findMention(markdown.slice(sentenceStart(markdown, index), index), target)) continue

    const whitespaceStart = index > 0 && /[ \t]/.test(markdown[index - 1] ?? "") ? index - 1 : index
    output += markdown.slice(cursor, whitespaceStart)
    output += target.citationIndex != null ? ` [${target.citationIndex}]` : ""
    cursor = index + match[0].length
  }
  return cursor === 0 ? markdown : output + markdown.slice(cursor)
}

function existingWikiPageKeys(markdown: string): Set<string> {
  const keys = new Set<string>()
  for (const match of markdown.matchAll(WIKI_LINK_PATTERN)) {
    const pageKey = match[1]?.trim()
    if (pageKey) keys.add(pageKey)
  }
  return keys
}

function annotatePlainText(text: string, targets: WikiMentionTarget[], usedPageKeys: Set<string>): string {
  let remaining = text
  let output = ""
  while (remaining) {
    let best: { target: WikiMentionTarget; index: number; label: string } | null = null
    for (const target of targets) {
      if (usedPageKeys.has(target.pageKey)) continue
      const mention = findMention(remaining, target)
      if (!mention) continue
      if (!best
        || mention.index < best.index
        || (mention.index === best.index && mention.label.length > best.label.length)) {
        best = { target, ...mention }
      }
    }
    if (!best) return output + remaining
    output += remaining.slice(0, best.index)
    output += `[[${best.target.pageKey}|${escapeWikiLabel(best.label)}]]`
    usedPageKeys.add(best.target.pageKey)
    remaining = remaining.slice(best.index + best.label.length)
  }
  return output
}

/**
 * 普通问答的答案归一化：来源继续用 [n]，Wiki 波浪线只包住真实实体/概念的首次提及。
 * 代码、已有 Markdown 链接、HTML 和 fenced code 保持原样。
 */
export function annotateNormalQaWikiMentions(markdown: string, targets: WikiMentionTarget[]): string {
  const mentionable = targets.filter(isMentionable)
  if (!markdown || mentionable.length === 0) return markdown
  const normalized = replaceTrailingWikiCitations(markdown, mentionable)
  const usedPageKeys = existingWikiPageKeys(normalized)
  let inFence = false

  return normalized.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return line
    }
    if (inFence) return line
    return line.split(MARKDOWN_PROTECTED_PATTERN).map((part, index) => (
      index % 2 === 1 ? part : annotatePlainText(part, mentionable, usedPageKeys)
    )).join("")
  }).join("\n")
}
