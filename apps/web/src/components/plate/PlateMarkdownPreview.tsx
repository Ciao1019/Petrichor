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
}

function syncHeadingIds(root: HTMLElement | null, headings: PlateHeading[]) {
    if (!root) return

    const nodes = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))
    if (nodes.length === 0 || headings.length === 0) return

    for (const node of nodes) {
        node.removeAttribute("id")
    }

    let cursor = 0
    for (const node of nodes) {
        const level = Number.parseInt(node.tagName.slice(1), 10)
        while (cursor < headings.length && headings[cursor].level !== level) {
            cursor += 1
        }
        if (cursor >= headings.length) {
            break
        }
        node.id = headings[cursor].id
        cursor += 1
    }
}

export function PlateMarkdownPreview({
    className,
    contentJson,
    contentMetaJson,
    headings,
    markdown,
    publicMediaAccess = false,
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
        const nextHeadings = headings || []
        const frameId = window.requestAnimationFrame(() => {
            syncHeadingIds(containerRef.current, nextHeadings)
        })
        return () => window.cancelAnimationFrame(frameId)
    }, [contentJson, headings, markdown])

    return (
        <SignedUrlPublicAccessProvider publicAccess={publicMediaAccess}>
            <Plate editor={editor} readOnly>
                <div ref={containerRef} className={cn("plate-article", className)}>
                    <PlateContent className="plate-article-content" readOnly disabled />
                </div>
            </Plate>
        </SignedUrlPublicAccessProvider>
    )
}
