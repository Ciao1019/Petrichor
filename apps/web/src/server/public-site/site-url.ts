const LOCAL_FALLBACK_URL = "http://localhost:3000"

function normalizeUrl(value: string) {
    const trimmed = value.trim()
    if (!trimmed) {
        return ""
    }
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    try {
        const url = new URL(withProtocol)
        return url.origin
    } catch {
        return ""
    }
}

export function getPublicBaseUrl(env: Record<string, string | undefined> = process.env) {
    const configured = normalizeUrl(env.NEXT_PUBLIC_APP_URL ?? "")
    if (configured) return configured

    const appBaseUrl = normalizeUrl(env.APP_BASE_URL ?? "")
    if (appBaseUrl) return appBaseUrl

    const vercelUrl = normalizeUrl(env.VERCEL_URL ?? "")
    if (vercelUrl) return vercelUrl

    return LOCAL_FALLBACK_URL
}

export function toAbsolutePublicUrl(pathname: string, baseUrl = getPublicBaseUrl()) {
    return new URL(pathname, `${baseUrl}/`).toString()
}
