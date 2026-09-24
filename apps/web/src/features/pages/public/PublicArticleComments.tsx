"use client"

import * as React from "react"
import { useTheme } from "@/components/theme-provider"

/**
 * giscus 评论区（GitHub Discussions 驱动）。
 *
 * 需要在环境变量里配置（去 https://giscus.app 按引导生成）：
 *   PETRICHOR_PUBLIC_GISCUS_REPO=owner/repo
 *   PETRICHOR_PUBLIC_GISCUS_REPO_ID=R_xxx
 *   PETRICHOR_PUBLIC_GISCUS_CATEGORY=Announcements
 *   PETRICHOR_PUBLIC_GISCUS_CATEGORY_ID=DIC_xxx
 *
 * 未配置时组件不渲染任何内容。
 */
const GISCUS_CONFIG = {
    repo: import.meta.env.PETRICHOR_PUBLIC_GISCUS_REPO ?? "",
    repoId: import.meta.env.PETRICHOR_PUBLIC_GISCUS_REPO_ID ?? "",
    category: import.meta.env.PETRICHOR_PUBLIC_GISCUS_CATEGORY ?? "",
    categoryId: import.meta.env.PETRICHOR_PUBLIC_GISCUS_CATEGORY_ID ?? "",
}

const GISCUS_ENABLED = Boolean(
    GISCUS_CONFIG.repo && GISCUS_CONFIG.repoId && GISCUS_CONFIG.category && GISCUS_CONFIG.categoryId,
)

function updateGiscusTheme(container: HTMLDivElement | null, theme: "light" | "dark") {
    container?.querySelector<HTMLIFrameElement>("iframe.giscus-frame")?.contentWindow?.postMessage(
        { giscus: { setConfig: { theme } } },
        "https://giscus.app",
    )
}

export function PublicArticleComments({ shareCode }: { shareCode: string | undefined }) {
    const { resolvedTheme } = useTheme()
    const containerRef = React.useRef<HTMLDivElement | null>(null)
    const themeRef = React.useRef(resolvedTheme)

    React.useEffect(() => {
        themeRef.current = resolvedTheme
        // 直接更新现有 iframe，保留用户尚未提交的评论内容。
        updateGiscusTheme(containerRef.current, resolvedTheme)
    }, [resolvedTheme])

    React.useEffect(() => {
        const container = containerRef.current
        if (!GISCUS_ENABLED || !container || !shareCode) return

        // 评论懒加载期间可能已切换主题，iframe 加载完成后同步最新值。
        const syncLoadedFrame = (event: Event) => {
            if (event.target instanceof HTMLIFrameElement) {
                updateGiscusTheme(container, themeRef.current)
            }
        }
        container.addEventListener("load", syncLoadedFrame, true)

        const script = document.createElement("script")
        script.src = "https://giscus.app/client.js"
        script.async = true
        script.crossOrigin = "anonymous"
        const attrs: Record<string, string> = {
            "data-repo": GISCUS_CONFIG.repo,
            "data-repo-id": GISCUS_CONFIG.repoId,
            "data-category": GISCUS_CONFIG.category,
            "data-category-id": GISCUS_CONFIG.categoryId,
            // 用 shareCode 做映射，避免路径变动导致讨论串丢失
            "data-mapping": "specific",
            "data-term": shareCode,
            "data-strict": "0",
            "data-reactions-enabled": "1",
            "data-emit-metadata": "0",
            "data-input-position": "top",
            "data-theme": themeRef.current,
            "data-lang": "zh-CN",
            "data-loading": "lazy",
        }
        for (const [key, value] of Object.entries(attrs)) {
            script.setAttribute(key, value)
        }
        container.appendChild(script)

        return () => {
            container.removeEventListener("load", syncLoadedFrame, true)
            container.replaceChildren()
        }
    }, [shareCode])

    if (!GISCUS_ENABLED) return null

    return (
        <section className="post-comments" aria-label="评论">
            <div className="post-comments-line" aria-hidden="true" />
            <div ref={containerRef} />
        </section>
    )
}
