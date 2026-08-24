export type RequestCookie = {
    name: string
    value: string
}

class RequestCookieStore {
    private readonly values = new Map<string, string>()

    constructor(header: string | null) {
        for (const part of header?.split(";") ?? []) {
            const separator = part.indexOf("=")
            if (separator <= 0) continue
            const name = part.slice(0, separator).trim()
            const rawValue = part.slice(separator + 1).trim()
            if (!name) continue
            try {
                this.values.set(name, decodeURIComponent(rawValue))
            } catch {
                this.values.set(name, rawValue)
            }
        }
    }

    get(name: string): RequestCookie | undefined {
        const value = this.values.get(name)
        return value === undefined ? undefined : { name, value }
    }
}

/** Bun 服务端统一使用的 Web Request，仅补充已解析 URL 与 Cookie 读取能力。 */
export class AppRequest extends Request {
    readonly urlObject: URL
    readonly cookies: RequestCookieStore

    constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, init)
        this.urlObject = new URL(this.url)
        this.cookies = new RequestCookieStore(this.headers.get("cookie"))
    }
}

export function toAppRequest(request: Request) {
    return request instanceof AppRequest ? request : new AppRequest(request)
}

