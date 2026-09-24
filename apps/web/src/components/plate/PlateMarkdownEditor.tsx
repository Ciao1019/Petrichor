import * as React from "react"
import { DndProvider } from "react-dnd"
import { HTML5Backend } from "react-dnd-html5-backend"
import { KEYS, type AnyPluginConfig, type Value } from "platejs"
import {
    Plate,
    useEditorSelector,
    usePluginOption,
    usePlateEditor,
} from "platejs/react"

import { AutoformatKit } from "@/components/editor/plugins/autoformat-kit"
import { BlockMenuKit } from "@/components/editor/plugins/block-menu-kit"
import { CursorOverlayKit } from "@/components/editor/plugins/cursor-overlay-kit"
import { discussionPlugin } from "@/components/editor/plugins/discussion-kit"
import { DndKit } from "@/components/editor/plugins/dnd-kit"
import { DocxKit } from "@/components/editor/plugins/docx-kit"
import { EmojiKit } from "@/components/editor/plugins/emoji-kit"
import { ExitBreakKit } from "@/components/editor/plugins/exit-break-kit"
import { SlashKit } from "@/components/editor/plugins/slash-kit"
import { TabbableKit } from "@/components/editor/plugins/tabbable-kit"
import {
    createPlateMarkdownPlugins,
    deserializeMarkdown,
    deserializeEditorContent,
    parseContentMetaJson,
    serializeContentJson,
    serializeContentMetaJson,
    serializeMarkdown,
    type PlateContentMeta,
} from "@/components/plate/plate-markdown"
import type { DiscussionUser } from "@/components/editor/plugins/discussion-kit"
import { FloatingToolbar } from "@/components/ui/floating-toolbar"
import { FloatingToolbarClassicButtons } from "@/components/ui/floating-toolbar-classic-buttons"
import { FixedToolbarButtons } from "@/components/ui/fixed-toolbar-classic-buttons"
import { AiAssistantProvider } from "@/components/editor/ai-assistant/ai-assistant-context"
import { EmbedCardDialog } from "@/components/editor/embed-card/embed-card-insert"
import { Editor, EditorContainer } from "@/components/ui/editor"
import { Toolbar } from "@/components/ui/toolbar"
import { PlateCompactToolbar } from "@/components/plate/PlateCompactToolbar"
import { uploadFileToObjectStorage } from "@/lib/object-storage-upload"
import { cn } from "@/lib/utils"

const AiAssistantDialog = React.lazy(() => import("@/components/editor/ai-assistant/AiAssistantDialog").then((module) => ({ default: module.AiAssistantDialog })))

export type PlateContentState = {
    markdown: string
    contentJson: string
    contentMetaJson: string
}

type PlateDocxImportState = PlateContentState & {
    commentsCount: number
    uploadedImageCount: number
    warnings: string[]
}

export type PlateMarkdownEditorHandle = {
    getContentState: () => PlateContentState
    hasPendingMedia: () => boolean
    importDocx: (file: File) => Promise<PlateDocxImportState>
    appendMarkdown: (markdown: string) => PlateContentState
    importMarkdown: (markdown: string) => PlateContentState
}

type PlateMarkdownEditorProps = {
    ariaLabel?: string
    className?: string
    /** 紧凑模式：去掉顶部固定工具栏，改为底部轻量操作条，适合随笔等快速记录场景。 */
    compact?: boolean
    /** 紧凑模式下渲染在底部操作条右侧的调用方操作（标签、字数、提交等）。 */
    compactActions?: React.ReactNode
    changeDelayMs?: number
    currentUser?: DiscussionUser
    disabled?: boolean
    extraPlugins?: AnyPluginConfig[]
    initialContentJson?: string | null
    initialContentMetaJson?: string | null
    initialMarkdown: string
    onContentStateChange?: (next: PlateContentState) => void
    onMarkdownChange?: (next: string) => void
    onPendingMediaChange?: (pending: boolean) => void
    placeholder?: string
}

const DISALLOWED_DOCX_NODE_TYPES = new Set(["script", "style"])

export const PlateMarkdownEditor = React.forwardRef<PlateMarkdownEditorHandle, PlateMarkdownEditorProps>(function PlateMarkdownEditor({
    ariaLabel,
    className,
    compact = false,
    compactActions,
    changeDelayMs = 1000,
    currentUser,
    disabled,
    extraPlugins,
    initialContentJson,
    initialContentMetaJson,
    initialMarkdown,
    onContentStateChange,
    onMarkdownChange,
    onPendingMediaChange,
    placeholder,
}, ref) {
    const initialMeta = React.useMemo(
        () => parseContentMetaJson(initialContentMetaJson),
        [initialContentMetaJson]
    )

    // Merge the currently logged-in user into the discussion options so that
    // comments always show the real username instead of a stale stored value.
    const metaWithCurrentUser = React.useMemo((): PlateContentMeta | undefined => {
        if (!currentUser) return initialMeta
        return {
            ...initialMeta,
            currentUserId: currentUser.id,
            users: {
                ...(initialMeta?.users ?? {}),
                [currentUser.id]: currentUser,
            },
        }
    }, [initialMeta, currentUser])
    const plugins = React.useMemo(
        () => [
            ...createPlateMarkdownPlugins(metaWithCurrentUser),
            // 编辑器专属功能
            ...AutoformatKit,
            ...ExitBreakKit,
            ...CursorOverlayKit,
            ...DocxKit,
            ...SlashKit,
            ...EmojiKit,
            ...DndKit,
            ...TabbableKit,
            ...BlockMenuKit,
            ...(extraPlugins ?? []),
        ],
        [extraPlugins, metaWithCurrentUser]
    )
    const editor = usePlateEditor({
        plugins: [...plugins],
        value: (instance) =>
            deserializeEditorContent(instance, {
                markdown: initialMarkdown,
                contentJson: initialContentJson,
            }),
    })

    return (
        <DndProvider backend={HTML5Backend}>
            <Plate editor={editor} readOnly={disabled}>
                <AiAssistantProvider
                    renderDialog={({ isOpen, context, initialAction, onClose }) => isOpen && (
                        <React.Suspense fallback={null}>
                            <AiAssistantDialog
                                isOpen={isOpen}
                                context={context}
                                initialAction={initialAction}
                                onClose={onClose}
                            />
                        </React.Suspense>
                    )}
                >
                    <PlateEditorStateSync
                        editor={editor}
                        editorRef={ref}
                        onContentStateChange={onContentStateChange}
                        onMarkdownChange={onMarkdownChange}
                        changeDelayMs={changeDelayMs}
                        onPendingMediaChange={onPendingMediaChange}
                    />
                    <div className={cn("isolate overflow-clip rounded-lg border bg-card", className)}>
                        {!disabled && !compact && (
                            <div className="sticky top-0 z-10 border-b bg-background/95 py-1 overflow-x-auto app-scrollbar backdrop-blur supports-[backdrop-filter]:bg-background/70">
                                <Toolbar className="h-9 w-max min-w-full flex-nowrap gap-1 px-2">
                                    <FixedToolbarButtons />
                                </Toolbar>
                            </div>
                        )}
                        <EditorContainer
                            className={cn(
                                "plate-editor-content app-scrollbar overflow-y-auto",
                                // 紧凑模式覆盖全局 .plate-editor-content 的文章级最小高度与内边距，由内部 Editor 控制留白。
                                compact ? "max-h-[50vh] min-h-0 p-0" : "min-h-[36rem]",
                                disabled ? "cursor-not-allowed opacity-80" : ""
                            )}
                        >
                            <Editor
                                aria-label={ariaLabel}
                                className={compact ? "min-h-40 px-4 pb-2 pt-3.5 sm:px-5" : "min-h-[36rem]"}
                                disabled={disabled}
                                placeholder={placeholder}
                                readOnly={disabled}
                                variant={compact ? "none" : "fullWidth"}
                            />
                        </EditorContainer>
                        {compact && <PlateCompactToolbar disabled={disabled}>{compactActions}</PlateCompactToolbar>}
                    </div>
                    <FloatingToolbar>
                        <FloatingToolbarClassicButtons />
                    </FloatingToolbar>
                    <EmbedCardDialog />
                </AiAssistantProvider>
            </Plate>
        </DndProvider>
    )
})

function PlateEditorStateSync({
    editor,
    editorRef,
    onContentStateChange,
    onMarkdownChange,
    changeDelayMs,
    onPendingMediaChange,
}: {
    editor: Parameters<typeof serializeMarkdown>[0]
    editorRef?: React.Ref<PlateMarkdownEditorHandle>
    onContentStateChange?: (next: PlateContentState) => void
    onMarkdownChange?: (next: string) => void
    changeDelayMs: number
    onPendingMediaChange?: (pending: boolean) => void
}) {
    const children = useEditorSelector((nextEditor) => nextEditor.children, [])
    const pendingMedia = useEditorSelector((nextEditor) => nextEditor.api.some({ at: [], match: { type: KEYS.placeholder } }), [])
    const discussions = usePluginOption(discussionPlugin, "discussions")
    const users = usePluginOption(discussionPlugin, "users")
    const currentUserId = usePluginOption(discussionPlugin, "currentUserId")
    const lastPayloadRef = React.useRef<string>("")

    React.useEffect(() => { onPendingMediaChange?.(pendingMedia) }, [onPendingMediaChange, pendingMedia])

    const buildContentState = React.useCallback(
        (metaOverride?: PlateContentMeta): PlateContentState => {
            const meta = metaOverride ?? {
                discussions: Array.isArray(discussions)
                    ? (discussions as PlateContentMeta["discussions"])
                    : [],
                users:
                    typeof users === "object" && users !== null
                        ? (users as PlateContentMeta["users"])
                        : {},
                currentUserId:
                    typeof currentUserId === "string" ? currentUserId : "",
            }

            return {
                // 空段落的 Markdown 占位符不是正文，不能生成空随笔或残留空草稿。
                markdown: editor.api.isEmpty() ? "" : serializeMarkdown(editor),
                contentJson: serializeContentJson(editor),
                contentMetaJson: serializeContentMetaJson(meta),
            }
        },
        [currentUserId, discussions, editor, users]
    )

    const emitContentState = React.useCallback(
        (options?: { force?: boolean; metaOverride?: PlateContentMeta }) => {
            const next = buildContentState(options?.metaOverride)
            const payload = JSON.stringify({
                contentJson: next.contentJson,
                contentMetaJson: next.contentMetaJson,
                markdown: next.markdown,
            })
            if (!options?.force && payload === lastPayloadRef.current) return next
            lastPayloadRef.current = payload

            onMarkdownChange?.(next.markdown)
            onContentStateChange?.(next)
            return next
        },
        [buildContentState, onContentStateChange, onMarkdownChange]
    )

    React.useImperativeHandle(
        editorRef,
        () => ({
            getContentState: () => emitContentState({ force: true }),
            hasPendingMedia: () => editor.api.some({ at: [], match: { type: KEYS.placeholder } }),
            importDocx: async (file: File) => {
                const currentUsers =
                    typeof users === "object" && users !== null
                        ? (users as PlateContentMeta["users"])
                        : {}
                const nextMeta: PlateContentMeta = {
                    currentUserId:
                        typeof currentUserId === "string" ? currentUserId : "",
                    discussions: [],
                    users: currentUsers,
                }

                const [{ importDocx }, arrayBuffer] = await Promise.all([
                    import("@platejs/docx-io"),
                    file.arrayBuffer(),
                ])
                const result = await importDocx(editor, arrayBuffer)
                const { nodes, uploadedImageCount } = await uploadDocxEmbeddedImages(
                    normalizeImportedDocxNodes(result.nodes)
                )

                editor.setOption(discussionPlugin, "discussions", [])
                editor.tf.setValue(nodes)

                return {
                    ...emitContentState({ force: true, metaOverride: nextMeta }),
                    commentsCount: result.comments.length,
                    uploadedImageCount,
                    warnings: result.warnings,
                }
            },
            appendMarkdown: (markdown: string) => {
                // 单次插入保留原有节点、批注和撤销历史，不替换当前草稿。
                editor.tf.insertNodes(deserializeMarkdown(editor, markdown), { at: [editor.children.length] })
                return emitContentState({ force: true })
            },
            importMarkdown: (markdown: string) => {
                const currentUsers =
                    typeof users === "object" && users !== null
                        ? (users as PlateContentMeta["users"])
                        : {}
                const nextMeta: PlateContentMeta = {
                    currentUserId:
                        typeof currentUserId === "string" ? currentUserId : "",
                    discussions: [],
                    users: currentUsers,
                }

                editor.setOption(discussionPlugin, "discussions", [])
                editor.tf.setValue(deserializeMarkdown(editor, markdown))

                return emitContentState({ force: true, metaOverride: nextMeta })
            },
        }),
        [currentUserId, editor, emitContentState, users]
    )

    React.useEffect(() => {
        if (!onContentStateChange && !onMarkdownChange) return

        const timer = setTimeout(() => {
            emitContentState()
        }, changeDelayMs)

        return () => clearTimeout(timer)
    }, [
        children,
        changeDelayMs,
        emitContentState,
        onContentStateChange,
        onMarkdownChange,
    ])

    return null
}

function normalizeImportedDocxNodes(nodes: unknown[]): Value {
    const normalized: Value = []

    for (const node of nodes) {
        const next = normalizeImportedDocxTopLevelNode(node)
        if (next) {
            normalized.push(next)
        }
    }

    if (normalized.length > 0) {
        return normalized
    }
    return [
        {
            type: "p",
            children: [{ text: "" }],
        },
    ]
}

function normalizeImportedDocxTopLevelNode(node: unknown): Value[number] | null {
    if (isTextNode(node)) {
        return createParagraph([node])
    }

    if (!isRecord(node)) {
        return null
    }

    const type = typeof node.type === "string" ? node.type : ""
    if (DISALLOWED_DOCX_NODE_TYPES.has(type.toLowerCase())) {
        return null
    }

    if (!Array.isArray(node.children)) {
        return null
    }

    const children = normalizeImportedDocxChildren(node.children)
    if (!type) {
        return createParagraph(children)
    }

    return {
        ...node,
        children,
    } as Value[number]
}

function normalizeImportedDocxChildren(children: unknown[]): Array<Record<string, unknown>> {
    const nextChildren: Array<Record<string, unknown>> = []

    for (const child of children) {
        const next = normalizeImportedDocxChild(child)
        if (Array.isArray(next)) {
            nextChildren.push(...next)
        } else if (next) {
            nextChildren.push(next)
        }
    }

    return nextChildren.length > 0 ? nextChildren : [{ text: "" }]
}

function normalizeImportedDocxChild(
    node: unknown
): Record<string, unknown> | Array<Record<string, unknown>> | null {
    if (isTextNode(node)) {
        return node
    }

    if (!isRecord(node)) {
        return null
    }

    const type = typeof node.type === "string" ? node.type : ""
    if (DISALLOWED_DOCX_NODE_TYPES.has(type.toLowerCase())) {
        return null
    }

    if (!Array.isArray(node.children)) {
        return node
    }

    const children = normalizeImportedDocxChildren(node.children)
    if (!type) {
        return children
    }

    return {
        ...node,
        children,
    }
}

function createParagraph(children: Array<Record<string, unknown>>): Value[number] {
    return {
        type: "p",
        children: children.length > 0 ? children : [{ text: "" }],
    } as Value[number]
}

async function uploadDocxEmbeddedImages(nodes: Value) {
    const cache = new Map<string, string>()
    let imageIndex = 0
    let uploadedImageCount = 0

    async function visit(node: unknown): Promise<void> {
        if (!isRecord(node)) return

        const isImageNode = node.type === KEYS.img
        const url = typeof node.url === "string" ? node.url : ""
        if (isImageNode && isDataImageUrl(url)) {
            const cachedUrl = cache.get(url)
            if (cachedUrl) {
                node.url = cachedUrl
            } else {
                imageIndex += 1
                const file = dataImageUrlToFile(url, imageIndex)
                const uploaded = await uploadFileToObjectStorage(file)
                cache.set(url, uploaded.url)
                node.url = uploaded.url
                node.name = typeof node.name === "string" && node.name ? node.name : uploaded.name
                node.isUpload = true
                uploadedImageCount += 1
            }
        }

        if (Array.isArray(node.children)) {
            for (const child of node.children) {
                await visit(child)
            }
        }
    }

    for (const node of nodes) {
        await visit(node)
    }

    return { nodes, uploadedImageCount }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}

function isTextNode(value: unknown): value is Record<string, unknown> {
    return isRecord(value) && typeof value.text === "string"
}

function isDataImageUrl(value: string): boolean {
    return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value)
}

function dataImageUrlToFile(dataUrl: string, index: number): File {
    const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(dataUrl)
    if (!match) {
        throw new Error("DOCX 图片数据格式无效")
    }

    const mimeType = match[1] || "image/png"
    const encodedData = match[3] || ""
    const binary = match[2]
        ? atob(encodedData.replace(/\s/g, ""))
        : decodeURIComponent(encodedData)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i)
    }

    return new File([bytes], `docx-image-${String(index).padStart(2, "0")}.${mimeTypeToExtension(mimeType)}`, {
        type: mimeType,
    })
}

function mimeTypeToExtension(mimeType: string): string {
    const normalized = mimeType.toLowerCase()
    if (normalized === "image/jpeg") return "jpg"
    if (normalized === "image/svg+xml") return "svg"
    const suffix = normalized.split("/")[1]?.split("+")[0]?.trim()
    return suffix || "png"
}
