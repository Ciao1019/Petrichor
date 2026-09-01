import type {
    MdMdxJsxFlowElement,
    MdRules,
} from "@platejs/markdown"

export const EMBED_CARD_TYPE = "embed_card"

export const EMBED_CARD_PROVIDERS = ["tweet", "github", "spotify", "html"] as const

export type EmbedCardProvider = (typeof EMBED_CARD_PROVIDERS)[number]

/** 自托管 HTML 可视化 iframe 默认高度（px） */
export const DEFAULT_HTML_EMBED_HEIGHT = 640

export const MIN_HTML_EMBED_HEIGHT = 200
export const MAX_HTML_EMBED_HEIGHT = 2400

export type EmbedCardElement = {
    type: typeof EMBED_CARD_TYPE
    provider: EmbedCardProvider
    url?: string
    repo?: string
    /** html provider：iframe title */
    title?: string
    /** html provider：iframe 高度（px） */
    height?: number
    children: [{ text: "" }]
}

type DirectiveAttributes = Record<string, string>

const DIRECTIVE_LINE_PATTERN =
    /^::(?<provider>tweet|github|spotify|html)\{(?<attributes>[^}]*)\}\s*$/
const ATTRIBUTE_PATTERN = /([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s}]+))/g
const SUPPORTED_SPOTIFY_TYPES = new Set([
    "album",
    "artist",
    "episode",
    "playlist",
    "show",
    "track",
])

function isEmbedCardProvider(value: string): value is EmbedCardProvider {
    return (EMBED_CARD_PROVIDERS as readonly string[]).includes(value)
}

function parseDirectiveAttributes(raw: string): DirectiveAttributes {
    const attributes: DirectiveAttributes = {}
    for (const match of raw.matchAll(ATTRIBUTE_PATTERN)) {
        const [, name, doubleQuoted, singleQuoted, bare] = match
        if (!name) continue
        attributes[name] = doubleQuoted ?? singleQuoted ?? bare ?? ""
    }
    return attributes
}

function escapeMdxAttribute(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;")
}

function toMdxAttributes(attributes: DirectiveAttributes): string {
    return Object.entries(attributes)
        .filter(([, value]) => value.trim().length > 0)
        .map(([name, value]) => `${name}="${escapeMdxAttribute(value.trim())}"`)
        .join(" ")
}

function parseMdxAttributes(attributes?: MdMdxJsxFlowElement["attributes"]) {
    const result: DirectiveAttributes = {}
    for (const attribute of attributes ?? []) {
        if (!("name" in attribute) || typeof attribute.name !== "string") continue
        if (typeof attribute.value === "string") {
            result[attribute.name] = attribute.value
        }
    }
    return result
}

function getDirectiveNode(
    provider: EmbedCardProvider,
    attributes: DirectiveAttributes
): EmbedCardElement | null {
    if (provider === "github") {
        const repo = normalizeGitHubRepo(attributes.repo ?? "")
        if (!repo) return null
        return {
            type: EMBED_CARD_TYPE,
            provider,
            repo,
            children: [{ text: "" }],
        }
    }

    const url = (attributes.url ?? "").trim()
    if (!url) return null

    if (provider === "tweet" && !getTweetId(url)) {
        return null
    }

    if (provider === "spotify" && !getSpotifyEmbedUrl(url)) {
        return null
    }

    if (provider === "html") {
        const src = getHtmlEmbedSrc(url)
        if (!src) return null
        const title = sanitizeHtmlEmbedTitle(attributes.title ?? "")
        const height = (attributes.height ?? "").trim()
        return {
            type: EMBED_CARD_TYPE,
            provider,
            url: src,
            ...(title ? { title } : {}),
            ...(height ? { height: clampHtmlEmbedHeight(height) } : {}),
            children: [{ text: "" }],
        }
    }

    return {
        type: EMBED_CARD_TYPE,
        provider,
        url,
        children: [{ text: "" }],
    }
}

/** 只放行站内相对路径（如 /tools/visualizations/architecture.html），杜绝 iframe 任意外站 */
export function getHtmlEmbedSrc(url: string): string | null {
    const trimmed = url.trim()
    return /^\/(?!\/)\S+$/.test(trimmed) ? trimmed : null
}

export function clampHtmlEmbedHeight(value: unknown): number {
    const parsed =
        typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10)
    if (!Number.isFinite(parsed)) return DEFAULT_HTML_EMBED_HEIGHT
    return Math.min(MAX_HTML_EMBED_HEIGHT, Math.max(MIN_HTML_EMBED_HEIGHT, Math.round(parsed)))
}

/** 去掉会破坏 ::html{...} 单行 directive 语法的字符 */
function sanitizeHtmlEmbedTitle(value: string): string {
    return value.replace(/["{}]/g, "").trim()
}

function getEmbedCardAttributes(
    node: Partial<EmbedCardElement>
): DirectiveAttributes | null {
    if (!node.provider || !isEmbedCardProvider(node.provider)) return null

    if (node.provider === "github") {
        const repo = normalizeGitHubRepo(node.repo ?? "")
        return repo ? { provider: node.provider, repo } : null
    }

    const url = (node.url ?? "").trim()
    if (!url) return null

    const attributes: DirectiveAttributes = { provider: node.provider, url }
    if (node.provider === "html") {
        const title = sanitizeHtmlEmbedTitle(node.title ?? "")
        if (title) attributes.title = title
        if (node.height != null) {
            attributes.height = String(clampHtmlEmbedHeight(node.height))
        }
    }
    return attributes
}

export function normalizeGitHubRepo(value: string): string | null {
    const raw = value.trim().replace(/^https?:\/\/github\.com\//i, "")
    const [owner, repo] = raw.split("/").filter(Boolean)
    if (!owner || !repo) return null
    const normalized = `${owner}/${repo.replace(/\.git$/i, "")}`
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)
        ? normalized
        : null
}

export function getGitHubRepoUrl(repo: string): string | null {
    const normalized = normalizeGitHubRepo(repo)
    return normalized ? `https://github.com/${normalized}` : null
}

export function getTweetId(url: string): string | null {
    try {
        const parsed = new URL(url)
        const host = parsed.hostname.toLowerCase().replace(/^www\./, "")
        if (host !== "x.com" && host !== "twitter.com") return null
        const parts = parsed.pathname.split("/").filter(Boolean)
        const statusIndex = parts.findIndex((part) => part === "status")
        const id = statusIndex >= 0 ? parts[statusIndex + 1] : null
        return id && /^\d+$/.test(id) ? id : null
    } catch {
        return null
    }
}

export function getSpotifyEmbedUrl(url: string): string | null {
    const spotifyUriMatch = /^spotify:(album|artist|episode|playlist|show|track):([A-Za-z0-9]+)$/i.exec(
        url.trim()
    )
    if (spotifyUriMatch) {
        const [, type, id] = spotifyUriMatch
        if (!type || !id) return null
        return `https://open.spotify.com/embed/${type.toLowerCase()}/${id}`
    }

    try {
        const parsed = new URL(url)
        if (parsed.hostname.toLowerCase().replace(/^www\./, "") !== "open.spotify.com") {
            return null
        }

        const parts = parsed.pathname.split("/").filter(Boolean)
        const typeIndex = parts.findIndex((part) => SUPPORTED_SPOTIFY_TYPES.has(part))
        const type = parts[typeIndex]
        const id = parts[typeIndex + 1]
        if (!type || !id) return null
        return `https://open.spotify.com/embed/${type}/${id}`
    } catch {
        return null
    }
}

export function getSpotifyEmbedHeight(url: string): number {
    const embedUrl = getSpotifyEmbedUrl(url)
    if (!embedUrl) return 152
    if (embedUrl.includes("/embed/track/") || embedUrl.includes("/embed/episode/")) {
        return 152
    }
    return 352
}

export function preprocessEmbedDirectives(markdown: string): string {
    return markdown
        .split(/\r?\n/)
        .map((line) => {
            if (line !== line.trimStart()) return line
            const match = DIRECTIVE_LINE_PATTERN.exec(line.trimEnd())
            const provider = match?.groups?.provider
            if (!provider || !isEmbedCardProvider(provider)) return line

            const attributes = parseDirectiveAttributes(match.groups?.attributes ?? "")
            const node = getDirectiveNode(provider, attributes)
            if (!node) return line

            const nodeAttributes = getEmbedCardAttributes(node)
            if (!nodeAttributes) return line
            return `<${EMBED_CARD_TYPE} ${toMdxAttributes(nodeAttributes)} />`
        })
        .join("\n")
}

export function serializeEmbedCardDirective(node: Partial<EmbedCardElement>): string | null {
    const attributes = getEmbedCardAttributes(node)
    if (!attributes) return null

    const { provider, ...rest } = attributes
    const body = Object.entries(rest)
        .map(([name, value]) => `${name}="${value}"`)
        .join(" ")
    return `::${provider}{${body}}`
}

export function postprocessEmbedDirectives(markdown: string): string {
    const tagPattern = /<embed_card\b([^>]*)\/>|<embed_card\b([^>]*)>\s*<\/embed_card>/g
    return markdown.replace(tagPattern, (raw, selfClosingAttributes, pairedAttributes) => {
        const attributes = parseDirectiveAttributes(selfClosingAttributes ?? pairedAttributes ?? "")
        const provider = attributes.provider
        if (!provider || !isEmbedCardProvider(provider)) return raw
        const node = getDirectiveNode(provider, attributes)
        return node ? (serializeEmbedCardDirective(node) ?? raw) : raw
    })
}

export const embedCardMarkdownRules: MdRules = {
    [EMBED_CARD_TYPE]: {
        deserialize(mdastNode: MdMdxJsxFlowElement) {
            const attributes = parseMdxAttributes(mdastNode.attributes)
            const provider = attributes.provider
            if (!provider || !isEmbedCardProvider(provider)) {
                return {
                    type: "p",
                    children: [{ text: "" }],
                }
            }
            return (
                getDirectiveNode(provider, attributes) ?? {
                    type: "p",
                    children: [{ text: "" }],
                }
            )
        },
        serialize(node: EmbedCardElement): MdMdxJsxFlowElement {
            const attributes =
                getEmbedCardAttributes(node) ??
                (node.provider === "github"
                    ? { provider: node.provider, repo: node.repo ?? "" }
                    : { provider: node.provider, url: node.url ?? "" })
            return {
                type: "mdxJsxFlowElement",
                name: EMBED_CARD_TYPE,
                attributes: Object.entries(attributes)
                    .filter(([, value]) => value.trim().length > 0)
                    .map(([name, value]) => ({
                        type: "mdxJsxAttribute",
                        name,
                        value,
                    })),
                children: [],
            }
        },
    },
}
