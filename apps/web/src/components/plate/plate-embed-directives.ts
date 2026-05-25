import type {
    MdMdxJsxFlowElement,
    MdRules,
} from "@platejs/markdown"

export const EMBED_CARD_TYPE = "embed_card"

export const EMBED_CARD_PROVIDERS = ["tweet", "github", "spotify"] as const

export type EmbedCardProvider = (typeof EMBED_CARD_PROVIDERS)[number]

export type EmbedCardElement = {
    type: typeof EMBED_CARD_TYPE
    provider: EmbedCardProvider
    url?: string
    repo?: string
    children: [{ text: "" }]
}

type DirectiveAttributes = Record<string, string>

const DIRECTIVE_LINE_PATTERN =
    /^::(?<provider>tweet|github|spotify)\{(?<attributes>[^}]*)\}\s*$/
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

    return {
        type: EMBED_CARD_TYPE,
        provider,
        url,
        children: [{ text: "" }],
    }
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

            const mdxAttributes =
                node.provider === "github"
                    ? toMdxAttributes({ provider: node.provider, repo: node.repo ?? "" })
                    : toMdxAttributes({ provider: node.provider, url: node.url ?? "" })
            return `<${EMBED_CARD_TYPE} ${mdxAttributes} />`
        })
        .join("\n")
}

export function serializeEmbedCardDirective(node: Partial<EmbedCardElement>): string | null {
    if (!node.provider || !isEmbedCardProvider(node.provider)) return null

    if (node.provider === "github") {
        const repo = normalizeGitHubRepo(node.repo ?? "")
        return repo ? `::github{repo="${repo}"}` : null
    }

    const url = (node.url ?? "").trim()
    if (!url) return null
    return `::${node.provider}{url="${url}"}`
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
                node.provider === "github"
                    ? { provider: node.provider, repo: node.repo ?? "" }
                    : { provider: node.provider, url: node.url ?? "" }
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
