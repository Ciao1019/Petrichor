import { AsyncLocalStorage } from "node:async_hooks"

type RequestContext = {
    pendingCookies: string[]
}

const requestContext = new AsyncLocalStorage<RequestContext>()

export function runWithRequestContext<T>(handler: () => T): T {
    return requestContext.run({ pendingCookies: [] }, handler)
}

export function appendPendingCookie(cookie: string) {
    requestContext.getStore()?.pendingCookies.push(cookie)
}

export function finalizeResponse(response: Response) {
    const pendingCookies = requestContext.getStore()?.pendingCookies ?? []
    if (pendingCookies.length === 0) return response

    const headers = new Headers(response.headers)
    for (const cookie of pendingCookies) {
        headers.append("set-cookie", cookie)
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    })
}

