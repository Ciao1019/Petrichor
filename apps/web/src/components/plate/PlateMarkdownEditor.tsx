import * as React from "react"
import { importDocx } from "@platejs/docx-io"
import { DndProvider } from "react-dnd"
import { HTML5Backend } from "react-dnd-html5-backend"
import { KEYS, type Value } from "platejs"
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
import { DocxExportKit } from "@/components/editor/plugins/docx-export-kit"
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
import { AiAssistantDialog } from "@/components/editor/ai-assistant/AiAssistantDialog"
import { Editor, EditorContainer } from "@/components/ui/editor"
import { Toolbar } from "@/components/ui/toolbar"
import { uploadFileToObjectStorage } from "@/lib/object-storage-upload"
import { cn } from "@/lib/utils"

type PlateContentState = {
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
    importDocx: (file: File) => Promise<PlateDocxImportState>
    importMarkdown: (markdown: string) => PlateContentState
}

type PlateMarkdownEditorProps = {
    className?: string
    currentUser?: DiscussionUser
    disabled?: boolean
    initialContentJson?: string | null
    initialContentMetaJson?: string | null
    initialMarkdown: string
    onContentStateChange?: (next: PlateContentState) => void
    onMarkdownChange?: (next: string) => void
    placeholder?: string
}

const DISALLOWED_DOCX_NODE_TYPES = new Set(["script", "style"])

export const PlateMarkdownEditor = React.forwardRef<PlateMarkdownEditorHandle, PlateMarkdownEditorProps>(function PlateMarkdownEditor({
    className,
    currentUser,
    disabled,
    initialContentJson,
    initialContentMetaJson,
    initialMarkdown,
    onContentStateChange,
    onMarkdownChange,
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
            ...DocxExportKit,
            ...SlashKit,
            ...EmojiKit,
            ...DndKit,
            ...TabbableKit,
            ...BlockMenuKit,
        ],
        [metaWithCurrentUser]
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
                    renderDialog={({ isOpen, context, initialAction, onClose }) => (
                        <AiAssistantDialog
                            isOpen={isOpen}
                            context={context}
                            initialAction={initialAction}
                            onClose={onClose}
                        />
                    )}
                >
                    <PlateEditorStateSync
                        editor={editor}
                        editorRef={ref}
                        onContentStateChange={onContentStateChange}
                        onMarkdownChange={onMarkdownChange}
                    />
                    <div className={cn("isolate overflow-clip rounded-lg border bg-card", className)}>
                        {!disabled && (
                            <div className="sticky top-0 z-10 border-b bg-background/95 py-1 backdrop-blur supports-[backdrop-filter]:bg-background/70 overflow-x-auto app-scrollbar">
                                <Toolbar className="h-9 w-max min-w-full flex-nowrap gap-1 px-2">
                                    <FixedToolbarButtons />
                                </Toolbar>
                            </div>
                        )}
                        <EditorContainer
                            className={cn(
                                "plate-editor-content app-scrollbar min-h-[36rem] overflow-y-auto",
                                disabled ? "cursor-not-allowed opacity-80" : ""
                            )}
                        >
                            <Editor
                                className="min-h-[36rem]"
                                disabled={disabled}
                                placeholder={placeholder}
                                readOnly={disabled}
                                variant="fullWidth"
                            />
                        </EditorContainer>
                    </div>
                    <FloatingToolbar>
                        <FloatingToolbarClassicButtons />
                    </FloatingToolbar>
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
}: {
    editor: Parameters<typeof serializeMarkdown>[0]
    editorRef?: React.Ref<PlateMarkdownEditorHandle>
    onContentStateChange?: (next: PlateContentState) => void
    onMarkdownChange?: (next: string) => void
}) {
    const children = useEditorSelector((nextEditor) => nextEditor.children, [])
    const discussions = usePluginOption(discussionPlugin, "discussions")
    const users = usePluginOption(discussionPlugin, "users")
    const currentUserId = usePluginOption(discussionPlugin, "currentUserId")
    const lastPayloadRef = React.useRef<string>("")

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
                markdown: serializeMarkdown(editor),
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

                const arrayBuffer = await file.arrayBuffer()
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
        }, 1000)

        return () => clearTimeout(timer)
    }, [
        children,
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
