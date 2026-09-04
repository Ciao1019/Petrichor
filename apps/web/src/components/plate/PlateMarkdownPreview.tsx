import * as React from "react"
import { Plate, PlateContent, usePlateEditor } from "platejs/react"

import {
    createPlateMarkdownPlugins,
    deserializeEditorContent,
    parseContentMetaJson,
} from "@/components/plate/plate-markdown"
import { SignedUrlPublicAccessProvider } from "@/hooks/use-signed-url"
import { cn } from "@/lib/utils"

type PlateHeading = {
    id: string
    level: number
}

type PlateMarkdownPreviewProps = {
    className?: string
    contentJson?: string | null
    contentMetaJson?: string | null
    headings?: PlateHeading[]
    markdown: string
    publicMediaAccess?: boolean
    publicMediaAccessToken?: string | null
}

function syncHeadingIds(root: HTMLElement | null, headings: PlateHeading[]) {
    if (!root) return

    const nodes = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))
    if (nodes.length === 0 || headings.length === 0) return

    const matchedIds = new Map<HTMLElement, string>()
    let cursor = 0
    for (const node of nodes) {
        const level = Number.parseInt(node.tagName.slice(1), 10)
        while (cursor < headings.length && headings[cursor]?.level !== level) {
            cursor += 1
        }
        if (cursor >= headings.length) {
            break
        }
        const heading = headings[cursor]
        if (!heading) break
        matchedIds.set(node, heading.id)
        cursor += 1
    }

    for (const node of nodes) {
        const id = matchedIds.get(node)
        if (id) {
            if (node.id !== id) node.id = id
        } else if (node.hasAttribute("id")) {
            node.removeAttribute("id")
        }
    }
}

export function PlateMarkdownPreview({
    className,
    contentJson,
    contentMetaJson,
    headings,
    markdown,
    publicMediaAccess = false,
    publicMediaAccessToken = null,
}: PlateMarkdownPreviewProps) {
    const containerRef = React.useRef<HTMLDivElement | null>(null)
    const contentMeta = React.useMemo(
        () => parseContentMetaJson(contentMetaJson),
        [contentMetaJson]
    )
    const plugins = React.useMemo(
        () => createPlateMarkdownPlugins(contentMeta),
        [contentMeta]
    )
    const editor = usePlateEditor({
        plugins: [...plugins],
        value: (instance) =>
            deserializeEditorContent(instance, {
                markdown,
                contentJson,
            }),
    }, [plugins])

    React.useEffect(() => {
        editor.tf.setValue(
            deserializeEditorContent(editor, {
                markdown,
                contentJson,
            })
        )
    }, [contentJson, editor, markdown])

    React.useEffect(() => {
        if (typeof window === "undefined") return
        const root = containerRef.current
        if (!root) return

        const nextHeadings = headings || []
        const sync = () => syncHeadingIds(root, nextHeadings)

        // PlateContent 会在预览组件提交之后再挂载正文节点。先观察再立即同步，
        // 后续 DOM 批次也由 observer 跟进，避免冷加载时只尝试一次而漏掉标题。
        // 这里只观察 childList；写入 id 不会再次触发 observer。
        const observer = new MutationObserver(sync)
        observer.observe(root, { childList: true, subtree: true })
        sync()

        return () => observer.disconnect()
    }, [contentJson, headings, markdown])

    return (
        <SignedUrlPublicAccessProvider
            publicAccess={publicMediaAccess}
            mediaAccessToken={publicMediaAccessToken}
        >
            <Plate editor={editor} readOnly>
                <div ref={containerRef} className={cn("plate-article", className)}>
                    <PlateContent className="plate-article-content" readOnly disabled />
                </div>
            </Plate>
        </SignedUrlPublicAccessProvider>
    )
}
