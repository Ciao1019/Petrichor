/**
 * 🚀 性能优化工具集合
 */

/**
 * 预加载资源
 * @param href 资源 URL
 * @param as 资源类型
 */
export function preloadResource(
    href: string,
    as: "script" | "style" | "image" | "font" = "script"
) {
    if (typeof document === "undefined") return

    const link = document.createElement("link")
    link.rel = "preload"
    link.href = href
    link.as = as

    if (as === "font") {
        link.crossOrigin = "anonymous"
    }

    document.head.appendChild(link)
}

/**
 * 预连接到域名
 * @param url 域名 URL
 */
export function preconnect(url: string) {
    if (typeof document === "undefined") return

    const link = document.createElement("link")
    link.rel = "preconnect"
    link.href = url
    document.head.appendChild(link)
}

/**
 * 测量首屏性能
 */
export function measurePageLoadPerformance() {
    if (typeof window === "undefined" || !window.performance) {
        return null
    }

    const navigation = performance.getEntriesByType(
        "navigation"
    )[0] as PerformanceNavigationTiming

    if (!navigation) {
        return null
    }

    return {
        // DNS 解析时间
        dns: navigation.domainLookupEnd - navigation.domainLookupStart,
        // TCP 连接时间
        tcp: navigation.connectEnd - navigation.connectStart,
        // 请求时间
        request: navigation.responseStart - navigation.requestStart,
        // 响应时间
        response: navigation.responseEnd - navigation.responseStart,
        // DOM 解析时间
        domParsing: navigation.domInteractive - navigation.responseEnd,
        // 资源加载时间
        resourceLoad: navigation.loadEventStart - navigation.domContentLoadedEventEnd,
        // 总加载时间
        total: navigation.loadEventEnd - navigation.fetchStart,
    }
}

/**
 * 报告 Web Vitals
 * 注意：需要安装 web-vitals 包: bun add web-vitals
 */
export async function reportWebVitals(onPerfEntry?: (metric: any) => void) {
    if (onPerfEntry && typeof window !== "undefined") {
        try {
            // 动态导入，如果包不存在则忽略
            // @ts-ignore - web-vitals 可能未安装
            const webVitals = await import("web-vitals").catch(() => null)
            if (!webVitals) {
                console.warn("web-vitals 包未安装，跳过 Web Vitals 报告")
                return
            }

            const { onCLS, onFID, onFCP, onLCP, onTTFB } = webVitals
            onCLS(onPerfEntry)
            onFID(onPerfEntry)
            onFCP(onPerfEntry)
            onLCP(onPerfEntry)
            onTTFB(onPerfEntry)
        } catch (error) {
            // 忽略错误
        }
    }
}

/**
 * 图片懒加载
 */
export function setupImageLazyLoading() {
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) {
        return
    }

    const imageObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                const img = entry.target as HTMLImageElement
                const src = img.dataset.src

                if (src) {
                    img.src = src
                    img.removeAttribute("data-src")
                    observer.unobserve(img)
                }
            }
        })
    })

    document.querySelectorAll("img[data-src]").forEach((img) => {
        imageObserver.observe(img)
    })
}

/**
 * 资源优先级提示
 */
export function setResourcePriority(
    selector: string,
    priority: "high" | "low" | "auto"
) {
    if (typeof document === "undefined") return

    const elements = document.querySelectorAll(selector)
    elements.forEach((el) => {
        if (el instanceof HTMLImageElement || el instanceof HTMLLinkElement) {
            el.fetchPriority = priority
        }
    })
}
