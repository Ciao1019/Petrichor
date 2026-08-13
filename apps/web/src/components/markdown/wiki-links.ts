/**
 * Wiki 双链渲染的文本预处理。
 *
 * Wiki 管线在正文里产出 `[[slug]]` 或 `[[slug|显示名]]` 形式的页面引用。
 * Markdown 本身不认识这个语法，所以在交给 react-markdown 之前先把它改写成
 * 普通链接 `[显示名](#wiki:slug)`：锚点链接能安全通过 rehype-sanitize，
 * 而 `#wiki:` 前缀让 a 组件可以把它识别回 Wiki 引用并接管点击。
 */

export const WIKI_LINK_HREF_PREFIX = "#wiki:"

/** 匹配 `[[slug]]` 与 `[[slug|显示名]]`，slug 内不允许出现 `]`。 */
const WIKI_LINK_PATTERN = /\[\[([^\]]+)\]\]/g

/** 代码块与行内代码里的 `[[...]]` 是字面量，不能改写。 */
const PROTECTED_PATTERN = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g

export interface WikiLinkRef {
    slug: string
    display: string
}

/** 拆出 `[[slug|显示名]]` 的两部分；没有显示名时回退到 slug 的末段。 */
export function parseWikiLinkTarget(inner: string): WikiLinkRef {
    const pipeIndex = inner.indexOf("|")
    const slug = (pipeIndex > 0 ? inner.slice(0, pipeIndex) : inner).trim()
    const display = pipeIndex > 0 ? inner.slice(pipeIndex + 1).trim() : ""
    return { slug, display: display || slugDisplayName(slug) }
}

/** `entity/zhang-san` → `zhang san`，用于没有显式显示名时的兜底文案。 */
export function slugDisplayName(slug: string): string {
    const tail = slug.split("/").at(-1) ?? slug
    return tail.replaceAll("-", " ").trim() || slug
}

/** Markdown 链接文本里的 `[`、`]`、`\` 需要转义，否则会截断链接语法。 */
function escapeLinkText(value: string): string {
    return value.replace(/([\\[\]])/g, "\\$1")
}

/**
 * 把正文里的 `[[...]]` 改写成锚点链接，代码块与行内代码内的内容保持原样。
 * `resolveDisplay` 可以把 slug 换成页面的真实标题。
 */
export function preprocessWikiLinks(content: string, resolveDisplay?: (slug: string) => string | undefined): string {
    if (!content.includes("[[")) return content

    // 先定位受保护区间，改写时跳过落在其中的匹配。
    const protectedSpans: Array<[number, number]> = []
    for (const match of content.matchAll(PROTECTED_PATTERN)) {
        const start = match.index ?? 0
        protectedSpans.push([start, start + match[0].length])
    }
    const isProtected = (index: number) => protectedSpans.some(([start, end]) => index >= start && index < end)

    return content.replace(WIKI_LINK_PATTERN, (raw, inner: string, index: number) => {
        if (isProtected(index)) return raw
        const { slug, display } = parseWikiLinkTarget(inner)
        if (!slug) return raw
        const label = resolveDisplay?.(slug) || display
        return `[${escapeLinkText(label)}](${WIKI_LINK_HREF_PREFIX}${encodeURIComponent(slug)})`
    })
}

/** 从 a 标签的 href 还原 Wiki slug；不是 Wiki 引用时返回 null。 */
export function wikiSlugFromHref(href: string | undefined): string | null {
    if (typeof href !== "string" || !href.startsWith(WIKI_LINK_HREF_PREFIX)) return null
    const raw = href.slice(WIKI_LINK_HREF_PREFIX.length)
    try {
        return decodeURIComponent(raw) || null
    } catch {
        return raw || null
    }
}
