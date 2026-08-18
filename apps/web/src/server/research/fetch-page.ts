/**
 * 网页抓取与正文提取（§39）。
 *
 * 只依赖标准 fetch，不引入额外解析库：
 * 去掉 script/style/nav/footer 等噪声块，再抽正文文本与元数据。
 * 抓取内容一律视为不可信数据（§88），调用方必须当作普通文本处理。
 */

export type FetchedPage = {
    ok: boolean
    url: string
    finalUrl: string
    title: string
    text: string
    /** 提取到的正文字符数 */
    length: number
    site: string
    publishedAt?: string
    fetchedAt: string
    contentType?: string
    errorCode?: "http_error" | "unsupported_content" | "timeout" | "network_error" | "blocked"
    message?: string
}

export type FetchPageOptions = {
    maxChars?: number
    timeoutMs?: number
    signal?: AbortSignal
}

const DEFAULT_MAX_CHARS = 12_000
const DEFAULT_TIMEOUT_MS = 15_000
const USER_AGENT = "PetrichorAgent/1.0 (+https://petrichor.local)"

export async function fetchPage(url: string, options: FetchPageOptions = {}): Promise<FetchedPage> {
    const fetchedAt = new Date().toISOString()
    const site = safeHost(url)
    const base: Pick<FetchedPage, "url" | "finalUrl" | "site" | "fetchedAt" | "title" | "text" | "length"> = {
        url,
        finalUrl: url,
        site,
        fetchedAt,
        title: "",
        text: "",
        length: 0,
    }

    if (!isFetchableUrl(url)) {
        return { ...base, ok: false, errorCode: "blocked", message: "仅支持 http/https 且非内网地址" }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    options.signal?.addEventListener("abort", () => controller.abort(), { once: true })

    try {
        const response = await fetch(url, {
            headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.9" },
            redirect: "follow",
            signal: controller.signal,
        })

        if (!response.ok) {
            return { ...base, ok: false, errorCode: "http_error", message: `目标返回 ${response.status}` }
        }

        const contentType = response.headers.get("content-type") ?? ""
        if (!/text\/html|text\/plain|application\/xhtml/i.test(contentType)) {
            return { ...base, ok: false, contentType, errorCode: "unsupported_content", message: `不支持的内容类型：${contentType}` }
        }

        const html = await response.text()
        const extracted = extractReadableText(html, options.maxChars ?? DEFAULT_MAX_CHARS)

        return {
            ...base,
            ok: extracted.text.length > 0,
            finalUrl: response.url || url,
            site: safeHost(response.url || url),
            title: extracted.title,
            text: extracted.text,
            length: extracted.text.length,
            contentType,
            ...(extracted.publishedAt ? { publishedAt: extracted.publishedAt } : {}),
            ...(extracted.text.length === 0
                ? { errorCode: "unsupported_content" as const, message: "页面没有可提取的正文" }
                : {}),
        }
    } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError"
        return {
            ...base,
            ok: false,
            errorCode: aborted ? "timeout" : "network_error",
            message: error instanceof Error ? error.message : String(error),
        }
    } finally {
        clearTimeout(timer)
    }
}

const NOISE_BLOCKS = /<(script|style|noscript|svg|iframe|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi
const SELF_CLOSING_NOISE = /<(?:link|meta|img|input|br|hr)\b[^>]*>/gi
const BLOCK_END = /<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi

export function extractReadableText(html: string, maxChars: number): {
    title: string
    text: string
    publishedAt?: string
} {
    const title = decodeEntities(
        (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
            .replace(/\s+/g, " ")
            .trim(),
    )
    const publishedAt = readMeta(html, [
        "article:published_time",
        "datePublished",
        "date",
        "og:updated_time",
        "article:modified_time",
    ])

    // 优先取 <main>/<article>，取不到再退回 <body>
    const main = html.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i)?.[1]
        ?? html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]
        ?? html

    const text = decodeEntities(
        main
            .replace(NOISE_BLOCKS, " ")
            .replace(SELF_CLOSING_NOISE, " ")
            .replace(BLOCK_END, "\n")
            .replace(/<[^>]+>/g, " ")
            .replace(/[ \t\u00a0\u3000]+/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim(),
    )

    return {
        title,
        text: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text,
        ...(publishedAt ? { publishedAt } : {}),
    }
}

/**
 * 与问题相关的要点抽取（§39 extract）。
 * 按段落打分取 TopN，避免把整页正文塞进 Context。
 */
export function extractRelevantExcerpts(
    text: string,
    query: string,
    options?: { maxExcerpts?: number; maxCharsPerExcerpt?: number },
): string[] {
    const maxExcerpts = options?.maxExcerpts ?? 5
    const maxChars = options?.maxCharsPerExcerpt ?? 500
    const terms = query
        .toLowerCase()
        .split(/[\s\p{P}\p{S}]+/u)
        .filter((term) => term.length >= 2)
    if (terms.length === 0) return [text.slice(0, maxChars)]

    const paragraphs = text
        .split(/\n{1,}/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 40)

    const scored = paragraphs.map((paragraph) => {
        const lower = paragraph.toLowerCase()
        let score = 0
        for (const term of terms) {
            if (lower.includes(term)) score += Math.min(3, term.length)
        }
        // 中文查询按 bigram 补充命中
        for (const gram of bigrams(query.toLowerCase())) {
            if (lower.includes(gram)) score += 0.5
        }
        return { paragraph, score }
    })

    return scored
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxExcerpts)
        .map((item) => (item.paragraph.length > maxChars ? `${item.paragraph.slice(0, maxChars)}…` : item.paragraph))
}

function bigrams(value: string): string[] {
    const cjk = value.match(/[一-鿿]{2,}/g) ?? []
    const out: string[] = []
    for (const run of cjk) {
        for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2))
    }
    return out
}

function readMeta(html: string, names: string[]): string | undefined {
    for (const name of names) {
        const pattern = new RegExp(
            `<meta[^>]+(?:property|name|itemprop)=["']${name}["'][^>]*content=["']([^"']+)["']`,
            "i",
        )
        const value = html.match(pattern)?.[1]
        if (value) return value
    }
    const timeTag = html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1]
    return timeTag
}

function decodeEntities(value: string): string {
    return value
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
}

/** 阻断内网与非 http(s) 地址，避免 SSRF */
export function isFetchableUrl(raw: string): boolean {
    let url: URL
    try {
        url = new URL(raw)
    } catch {
        return false
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    const host = url.hostname.toLowerCase()
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false
    if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.)/.test(host)) return false
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
    if (host === "[::1]" || host === "::1") return false
    if (/^metadata\./.test(host)) return false
    return true
}

export function safeHost(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, "")
    } catch {
        return ""
    }
}
