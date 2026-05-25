import { ListPlugin as ListClassicPlugin } from "@platejs/list-classic/react"
import { MarkdownPlugin } from "@platejs/markdown"
import {
    CodeBlockPlugin,
    CodeLinePlugin,
    CodeSyntaxPlugin,
} from "@platejs/code-block/react"
import { common, createLowlight } from "lowlight"
import type { Value } from "platejs"
import type { PlateEditor } from "platejs/react"

import { AlignKit } from "@/components/editor/plugins/align-kit"
import { BasicNodesKit } from "@/components/editor/plugins/basic-nodes-kit"
import { BlockPlaceholderKit } from "@/components/editor/plugins/block-placeholder-kit"
import { CalloutKit } from "@/components/editor/plugins/callout-kit"
import { CodeDrawingKit } from "@/components/editor/plugins/code-drawing-kit"
import { ColumnKit } from "@/components/editor/plugins/column-kit"
import { CommentKit } from "@/components/editor/plugins/comment-kit"
import { DateKit } from "@/components/editor/plugins/date-kit"
import { EmbedCardKit } from "@/components/editor/plugins/embed-card-kit"
import {
    createDiscussionKit,
    type DiscussionOptions,
} from "@/components/editor/plugins/discussion-kit"
import { FontKit } from "@/components/editor/plugins/font-kit"
import { LineHeightKit } from "@/components/editor/plugins/line-height-kit"
import { LinkKit } from "@/components/editor/plugins/link-kit"
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit"
import { MathKit } from "@/components/editor/plugins/math-kit"
import { MediaKit } from "@/components/editor/plugins/media-kit"
import { MentionKit } from "@/components/editor/plugins/mention-kit"
import { SuggestionKit } from "@/components/editor/plugins/suggestion-kit"
import { TableKit } from "@/components/editor/plugins/table-kit"
import { TocKit } from "@/components/editor/plugins/toc-kit"
import { ToggleKit } from "@/components/editor/plugins/toggle-kit"
import {
    postprocessEmbedDirectives,
    preprocessEmbedDirectives,
} from "@/components/plate/plate-embed-directives"
import { sanitizeEditorContentForPersistence } from "@/components/plate/plate-content-sanitize"
import { BlockDiscussion } from "@/components/ui/block-discussion"
import {
    CodeBlockElement,
    CodeLineElement,
    CodeSyntaxLeaf,
} from "@/components/ui/code-block-node"

export type PlateContentMeta = Partial<DiscussionOptions>

const lowlight = createLowlight(common)

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}

export function parseContentMetaJson(raw?: string | null): PlateContentMeta | undefined {
    if (!raw || !raw.trim()) {
        return undefined
    }
    try {
        const parsed: unknown = JSON.parse(raw)
        if (!isRecord(parsed)) {
            return undefined
        }

        const next: PlateContentMeta = {}
        if (Array.isArray(parsed.discussions)) {
            next.discussions = parsed.discussions as DiscussionOptions["discussions"]
        }
        if (isRecord(parsed.users)) {
            next.users = parsed.users as DiscussionOptions["users"]
        }
        if (typeof parsed.currentUserId === "string" && parsed.currentUserId.trim()) {
            next.currentUserId = parsed.currentUserId
        }
        return Object.keys(next).length > 0 ? next : undefined
    } catch {
        return undefined
    }
}

export function createPlateMarkdownPlugins(contentMeta?: PlateContentMeta) {
    return [
        // 基础块和标记
        ...BasicNodesKit,
        ListClassicPlugin,

        // 代码块（含语法高亮）
        CodeLinePlugin.withComponent(CodeLineElement),
        CodeSyntaxPlugin.withComponent(CodeSyntaxLeaf),
        CodeBlockPlugin.configure({
            node: {
                component: CodeBlockElement,
            },
            options: {
                lowlight,
            },
        }),

        // 结构化块
        ...TableKit,
        ...ToggleKit,
        ...TocKit,
        ...CalloutKit,
        ...ColumnKit,
        ...CodeDrawingKit,

        // 内联元素
        ...LinkKit,
        ...MentionKit,
        ...MathKit,
        ...DateKit,

        // 媒体与外部卡片
        ...EmbedCardKit,
        ...MediaKit,

        // 样式注入
        ...FontKit,
        ...AlignKit,
        ...LineHeightKit,

        // 协作
        ...createDiscussionKit(contentMeta, { aboveNodes: BlockDiscussion }),
        ...SuggestionKit,
        ...CommentKit,

        // 工具
        ...BlockPlaceholderKit,
        ...MarkdownKit,
    ] as const
}

export const PLATE_MARKDOWN_PLUGINS = createPlateMarkdownPlugins()

function createEmptyValue(): Value {
    return [
        {
            type: "p",
            children: [{ text: "" }],
        },
    ]
}

export function deserializeMarkdown(editor: PlateEditor, markdown: string): Value {
    if (!markdown.trim()) {
        return createEmptyValue()
    }

    const value = editor
        .getApi(MarkdownPlugin)
        .markdown.deserialize(preprocessEmbedDirectives(markdown))
    if (value.length > 0) {
        return value
    }
    return createEmptyValue()
}

export function deserializeEditorContent(
    editor: PlateEditor,
    payload: {
        markdown: string
        contentJson?: string | null
    }
): Value {
    const { contentJson, markdown } = payload
    if (contentJson && contentJson.trim()) {
        try {
            const parsed: unknown = JSON.parse(contentJson)
            if (Array.isArray(parsed)) {
                return parsed as Value
            }
            if (isRecord(parsed) && Array.isArray(parsed.value)) {
                return parsed.value as Value
            }
        } catch {
            // JSON 解析失败时回退到 Markdown，避免页面直接崩溃
        }
    }
    return deserializeMarkdown(editor, markdown)
}

export function serializeMarkdown(editor: PlateEditor): string {
    const markdown = editor.getApi(MarkdownPlugin).markdown.serialize({
        value: sanitizeEditorContentForPersistence(editor.children),
    })
    return postprocessEmbedDirectives(markdown)
}

export function serializeContentJson(editor: PlateEditor): string {
    return JSON.stringify(sanitizeEditorContentForPersistence(editor.children))
}

export function serializeContentMetaJson(meta?: PlateContentMeta): string {
    return JSON.stringify({
        currentUserId: meta?.currentUserId ?? "",
        discussions: meta?.discussions ?? [],
        users: meta?.users ?? {},
    })
}
