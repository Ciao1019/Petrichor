"use client"

import * as React from "react"

import { Loader2 } from "@/components/iconimate"
import { useTheme } from "@/components/theme-provider"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { uploadApi, type DocDocumentDetail } from "@/lib/api"

const LazyDocPdfPreview = React.lazy(() => (
    import("./DocPdfPreview").then((module) => ({ default: module.DocPdfPreview }))
))
const LazyDocxViewerPreview = React.lazy(() => (
    import("@/components/extend/ui/docx-viewer").then((module) => ({ default: module.DocxViewerPreview }))
))
const LazyXlsxViewerPreview = React.lazy(() => (
    import("@/components/extend/ui/xlsx-viewer").then((module) => ({ default: module.XlsxViewerPreview }))
))
const LazyMarkdownPreview = React.lazy(() => (
    import("@/components/markdown/MarkdownPreview").then((module) => ({ default: module.MarkdownPreview }))
))

type ViewerMode = "file" | "text"
type FilePreviewState = {
    documentId: string
    url: string | null
    loading: boolean
    error: string | null
}

export type DocViewerHighlight = {
    page: number
    text: string
}

export function DocViewerPanel({
    document,
    highlight,
}: {
    document: DocDocumentDetail | null
    highlight?: DocViewerHighlight | null
}) {
    const { resolvedTheme } = useTheme()
    const [manualDark, setManualDark] = React.useState<boolean | null>(null)
    const isDark = manualDark ?? resolvedTheme === "dark"
    const [fileState, setFileState] = React.useState<FilePreviewState | null>(null)
    const [modeState, setModeState] = React.useState<{ documentId: string; mode: ViewerMode } | null>(null)
    const documentId = document?.id
    const objectKey = document?.objectKey

    React.useEffect(() => {
        if (!documentId || !objectKey) return
        let cancelled = false
        uploadApi.presignGet(objectKey)
            .then((response) => {
                if (!cancelled) {
                    setFileState({ documentId, url: response.data.url, loading: false, error: null })
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setFileState({ documentId, url: null, loading: false, error: "文件地址获取失败" })
                }
            })
        return () => {
            cancelled = true
        }
    }, [documentId, objectKey])

    const handleModeChange = React.useCallback((value: string) => {
        if (document && isViewerMode(value)) {
            setModeState({ documentId: document.id, mode: value })
        }
    }, [document])

    const highlightSig = highlight ? `${documentId}:${highlight.page}:${highlight.text}` : null
    React.useEffect(() => {
        if (highlightSig && documentId) setModeState({ documentId, mode: "file" })
    }, [highlightSig, documentId])

    if (!document) {
        return (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                从左侧选择一个文件进行预览
            </div>
        )
    }

    const markdownText = buildDocumentMarkdown(document)
    const hasText = markdownText.trim().length > 0
    const mode = modeState?.documentId === document.id ? modeState.mode : "file"
    const currentFileState = fileState?.documentId === document.id
        ? fileState
        : { documentId: document.id, url: null, loading: true, error: null }

    return (
        <Tabs value={mode} onValueChange={handleModeChange} className="h-full min-h-0 gap-0">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
                <TabsList className="h-8">
                    <TabsTrigger value="file" className="text-xs">原文件</TabsTrigger>
                    <TabsTrigger value="text" className="text-xs" disabled={!hasText}>文本</TabsTrigger>
                </TabsList>
            </div>
            <TabsContent value="file" className="m-0 min-h-0">
                <OriginalFilePreview
                    document={document}
                    url={currentFileState.url}
                    loading={currentFileState.loading}
                    error={currentFileState.error}
                    isDark={isDark}
                    onIsDarkChange={setManualDark}
                    highlight={highlight ?? null}
                />
            </TabsContent>
            <TabsContent value="text" className="m-0 min-h-0">
                <ParsedTextPreview text={markdownText} />
            </TabsContent>
        </Tabs>
    )
}

function OriginalFilePreview({
    document,
    url,
    loading,
    error,
    isDark,
    onIsDarkChange,
    highlight,
}: {
    document: DocDocumentDetail
    url: string | null
    loading: boolean
    error: string | null
    isDark: boolean
    onIsDarkChange: (value: boolean) => void
    highlight: DocViewerHighlight | null
}) {
    if (loading || !url) {
        return <PreviewLoading error={error} />
    }

    if (document.fileType === "pdf") {
        return (
            <React.Suspense fallback={<PreviewLoading />}>
                <LazyDocPdfPreview document={document} url={url} highlight={highlight} />
            </React.Suspense>
        )
    }
    if (document.fileType === "docx") {
        return (
            <React.Suspense fallback={<PreviewLoading />}>
                <LazyDocxViewerPreview
                    className="h-full"
                    src={url}
                    fileName={document.fileName}
                    isDark={isDark}
                    onIsDarkChange={onIsDarkChange}
                    showUpload={false}
                />
            </React.Suspense>
        )
    }
    return (
        <React.Suspense fallback={<PreviewLoading />}>
            <LazyXlsxViewerPreview
                className="h-full"
                src={url}
                fileName={document.fileName}
                isDark={isDark}
                onIsDarkChange={onIsDarkChange}
                showUpload={false}
            />
        </React.Suspense>
    )
}

function PreviewLoading({ error }: { error?: string | null }) {
    return (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            {error ? <span className="text-destructive">{error}</span> : (
                <>
                    <Loader2 className="size-5 animate-spin" />
                    正在加载预览…
                </>
            )}
        </div>
    )
}

function ParsedTextPreview({ text }: { text: string }) {
    if (!text.trim()) {
        return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无解析文本</div>
    }
    return (
        <ScrollArea className="h-full">
            <div className="mx-auto w-full max-w-4xl px-6 py-6">
                <React.Suspense fallback={<PreviewLoading />}>
                    <LazyMarkdownPreview value={text} variant="typography" className="max-w-none" />
                </React.Suspense>
            </div>
        </ScrollArea>
    )
}

function buildDocumentMarkdown(document: DocDocumentDetail) {
    const lines: string[] = []
    let previousLocation: string | null = null
    for (const chunk of document.chunks.slice().sort((a, b) => a.chunkIndex - b.chunkIndex)) {
        const text = chunk.text.trim()
        if (!text) continue
        const location = chunk.locator ?? (chunk.page != null ? `p.${chunk.page}` : null)
        if (location && location !== previousLocation) {
            lines.push(`### ${escapeMarkdownHeading(formatChunkLocation(location))}`)
            previousLocation = location
        }
        lines.push(text)
    }
    return lines.join("\n\n")
}

function formatChunkLocation(value: string) {
    const pageMatch = value.match(/^p\.(\d+)$/i)
    return pageMatch ? `第 ${pageMatch[1]} 页` : value
}

function escapeMarkdownHeading(value: string) {
    return value.replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1")
}

function isViewerMode(value: string): value is ViewerMode {
    return value === "file" || value === "text"
}
