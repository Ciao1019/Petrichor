import * as React from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import rehypeSanitize from "rehype-sanitize"
import rehypeSlug from "rehype-slug"
import remarkGfm from "remark-gfm"

import { createAnchorComponent, createMarkdownComponents } from "@/components/markdown/markdown-preview-components"
import { preprocessWikiLinks, wikiSlugFromHref } from "@/components/markdown/wiki-links"
import { cn } from "@/lib/utils"

/**
 * react-markdown 的 Components["a"] 是包含所有内置标签名的 ElementType 联合类型，
 * 直接当 JSX 组件用会让 TS 选中错误的联合分支。这里收窄成普通函数组件后再调用。
 */
type AnchorRenderer = (props: React.ComponentPropsWithoutRef<"a"> & { node?: unknown }) => React.ReactNode

type WikiMarkdownProps = {
    value: string
    className?: string
    /** 返回该 slug 对应页面的标题；返回 undefined 表示页面不存在（断链）。 */
    resolveTitle: (slug: string) => string | undefined
    onOpenPage: (slug: string) => void
}

/**
 * Wiki 正文渲染：在标准 Markdown 之上把 `[[slug]]` 引用渲染成可点击的关联高亮。
 * 已存在的页面用主色 + 虚线下划线（hover 变实线）标出，断链降级为灰色不可点，
 * 让读者一眼看出哪些引用真的能跳过去。
 */
export function WikiMarkdown({ value, className, resolveTitle, onOpenPage }: WikiMarkdownProps) {
    const processed = React.useMemo(() => preprocessWikiLinks(value, resolveTitle), [resolveTitle, value])

    const components = React.useMemo<Components>(() => {
        const base = createMarkdownComponents("typography")
        const renderAnchor = createAnchorComponent("typography") as AnchorRenderer
        return {
            ...base,
            a: (props) => {
                const slug = wikiSlugFromHref(props.href)
                if (!slug) return renderAnchor(props)

                const title = resolveTitle(slug)
                if (!title) {
                    return (
                        <span
                            className="cursor-not-allowed font-medium text-muted-foreground/80 decoration-dotted underline underline-offset-4"
                            title={`Wiki 页面「${slug}」不存在`}
                        >
                            {props.children}
                        </span>
                    )
                }
                return (
                    <button
                        type="button"
                        title={title}
                        className="cursor-pointer font-medium text-primary underline decoration-dashed decoration-primary/60 underline-offset-4 transition-colors hover:decoration-solid hover:text-primary/80"
                        onClick={(event) => {
                            event.preventDefault()
                            onOpenPage(slug)
                        }}
                    >
                        {props.children}
                    </button>
                )
            },
        }
    }, [onOpenPage, resolveTitle])

    return (
        <div className={cn("md-typography text-[15px] text-foreground/95", className)}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize, rehypeSlug]} components={components}>
                {processed}
            </ReactMarkdown>
        </div>
    )
}
