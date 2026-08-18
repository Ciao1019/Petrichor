"use client"

import * as React from "react"
import { useTheme } from "next-themes"
import { Loader2 } from "@/components/iconimate"
import { MarkdownPreview } from "@/components/markdown/MarkdownPreview"
import {
    PDFViewer,
    type PDFViewerHandle,
} from "@/components/extend/ui/pdf-viewer"
import {
    OcrBlockOverlay,
    OcrBlocksPanel,
    blockToHighlightArea,
    matchRecallBlockIds,
    type OcrBlock,
} from "@/components/extend/ui/layout-blocks"
import { DocxViewerPreview } from "@/components/extend/ui/docx-viewer"
import { XlsxViewerPreview } from "@/components/extend/ui/xlsx-viewer"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { uploadApi, type DocDocumentDetail } from "@/lib/api"
import { cn } from "@/lib/utils"

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
        // 复用通用上传层的预签名下载（带鉴权 / 时效）
        uploadApi.presignGet(objectKey)
            .then((res) => {
                if (!cancelled) {
                    setFileState({
                        documentId,
                        url: res.data.url,
                        loading: false,
                        error: null,
                    })
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setFileState({
                        documentId,
                        url: null,
                        loading: false,
                        error: "文件地址获取失败",
                    })
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

    // 收到召回高亮时，切回「原文件」标签（之后用户仍可自由切换到「文本」）
    const highlightSig = highlight ? `${documentId}:${highlight.page}:${highlight.text}` : null
    React.useEffect(() => {
        if (!highlightSig || !documentId) return
        setModeState({ documentId, mode: "file" })
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
    const blocks = document.blocks.filter(isOcrBlock)
    const mode = modeState?.documentId === document.id ? modeState.mode : "file"
    const currentFileState = fileState?.documentId === document.id
        ? fileState
        : { documentId: document.id, url: null, loading: true, error: null }

    const originalPreview = (
        <OriginalFilePreview
            document={document}
            url={currentFileState.url}
            loading={currentFileState.loading}
            error={currentFileState.error}
            isDark={isDark}
            onIsDarkChange={(value) => setManualDark(value)}
            blocks={blocks}
            highlight={highlight ?? null}
        />
    )

    return (
        <Tabs value={mode} onValueChange={handleModeChange} className="h-full min-h-0 gap-0">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
                <TabsList className="h-8">
                    <TabsTrigger value="file" className="text-xs">原文件</TabsTrigger>
                    <TabsTrigger value="text" className="text-xs" disabled={!hasText}>文本</TabsTrigger>
                </TabsList>
            </div>
            <TabsContent value="file" className="m-0 min-h-0">
                {originalPreview}
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
    blocks,
    highlight,
}: {
    document: DocDocumentDetail
    url: string | null
    loading: boolean
    error: string | null
    isDark: boolean
    onIsDarkChange: (value: boolean) => void
    blocks: OcrBlock[]
    highlight: DocViewerHighlight | null
}) {
    if (loading || !url) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                {error ? (
                    <span className="text-destructive">{error}</span>
                ) : (
                    <>
                        <Loader2 className="size-5 animate-spin" />
                        正在加载预览…
                    </>
                )}
            </div>
        )
    }

    if (document.fileType === "pdf") {
        return (
            <PdfWithLayoutBlocks
                url={url}
                fileName={document.fileName}
                blocks={blocks}
                highlight={highlight}
            />
        )
    }

    if (document.fileType === "docx") {
        return (
            <DocxViewerPreview
                className="h-full"
                src={url}
                fileName={document.fileName}
                isDark={isDark}
                onIsDarkChange={onIsDarkChange}
                showUpload={false}
            />
        )
    }

    // xlsx / csv
    return (
        <XlsxViewerPreview
            className="h-full"
            src={url}
            fileName={document.fileName}
            isDark={isDark}
            onIsDarkChange={onIsDarkChange}
            showUpload={false}
        />
    )
}

function ParsedTextPreview({ text }: { text: string }) {
    if (!text.trim()) {
        return (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                暂无解析文本
            </div>
        )
    }

    return (
        <ScrollArea className="h-full">
            <div className="mx-auto w-full max-w-4xl px-6 py-6">
                <MarkdownPreview value={text} variant="typography" className="max-w-none" />
            </div>
        </ScrollArea>
    )
}

function PdfWithLayoutBlocks({
    url,
    fileName,
    blocks,
    highlight,
}: {
    url: string
    fileName: string
    blocks: OcrBlock[]
    highlight: DocViewerHighlight | null
}) {
    const pdfRef = React.useRef<PDFViewerHandle>(null)
    const [selectedBlockId, setSelectedBlockId] = React.useState<string | undefined>(blocks[0]?.id)
    const [pdfReady, setPdfReady] = React.useState(false)
    const [pulsing, setPulsing] = React.useState(false)

    const blocksByPage = React.useMemo(() => {
        const map = new Map<number, OcrBlock[]>()
        for (const block of blocks) {
            const list = map.get(block.page) ?? []
            list.push(block)
            map.set(block.page, list)
        }
        return map
    }, [blocks])

    const highlightSig = highlight ? `${highlight.page}::${highlight.text}` : ""

    // 召回片段反向匹配到版面块
    const highlightedBlockIds = React.useMemo(() => {
        if (!highlight) return new Set<string>()
        return new Set(matchRecallBlockIds(blocks, highlight.page, highlight.text))
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [blocks, highlightSig])

    const firstHighlightBlock = React.useMemo(
        () => blocks.find((block) => highlightedBlockIds.has(block.id)) ?? null,
        [blocks, highlightedBlockIds],
    )

    // 新 PDF 加载时重置就绪态
    React.useEffect(() => {
        setPdfReady(false)
    }, [url])

    // 命中后：选中第一个命中块、滚动定位、短暂脉冲
    React.useEffect(() => {
        if (!highlight) {
            setPulsing(false)
            return
        }
        if (firstHighlightBlock) {
            setSelectedBlockId(firstHighlightBlock.id)
        }
        if (!pdfReady) return
        const scrollTimer = window.setTimeout(() => {
            if (firstHighlightBlock) {
                pdfRef.current?.scrollToPageArea(
                    firstHighlightBlock.page,
                    blockToHighlightArea(firstHighlightBlock),
                    { behavior: "smooth" },
                )
            } else {
                pdfRef.current?.scrollToPage(highlight.page, { behavior: "smooth" })
            }
        }, 240)
        setPulsing(true)
        const pulseTimer = window.setTimeout(() => setPulsing(false), 2800)
        return () => {
            window.clearTimeout(scrollTimer)
            window.clearTimeout(pulseTimer)
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [highlightSig, pdfReady, firstHighlightBlock])

    const activeBlockId = blocks.some((block) => block.id === selectedBlockId) ? selectedBlockId : blocks[0]?.id

    const handleBlockFocus = React.useCallback((block: OcrBlock) => {
        setSelectedBlockId(block.id)
        pdfRef.current?.scrollToPageArea(block.page, blockToHighlightArea(block), { behavior: "smooth" })
    }, [])

    const hasBlocks = blocks.length > 0

    return (
        <div className="flex h-full min-h-0 w-full">
            <div className="min-w-0 flex-1">
                <PDFViewer
                    ref={pdfRef}
                    className="h-full"
                    src={url}
                    fileName={fileName}
                    showUpload={false}
                    onDocumentLoadSuccess={() => setPdfReady(true)}
                    renderPageOverlay={({ pageNumber, pageWidth, pageHeight }) => {
                        const pageBlocks = blocksByPage.get(pageNumber)
                        if (!pageBlocks) return null
                        return (
                            <>
                                {pageBlocks.map((block) => (
                                    <OcrBlockOverlay
                                        key={block.id}
                                        block={block}
                                        isActive={block.id === activeBlockId}
                                        isHighlighted={highlightedBlockIds.has(block.id)}
                                        pulse={pulsing}
                                        pageWidth={pageWidth}
                                        pageHeight={pageHeight}
                                    />
                                ))}
                            </>
                        )
                    }}
                />
            </div>
            {hasBlocks ? (
                <div className={cn("hidden w-[360px] shrink-0 border-l border-border/60 lg:flex lg:flex-col")}>
                    <div className="flex h-10 items-center border-b border-border/60 px-3 text-xs font-medium text-muted-foreground">
                        版面文本块
                    </div>
                    <OcrBlocksPanel
                        className="h-full min-h-0 flex-1"
                        blocks={blocks}
                        activeBlockId={activeBlockId}
                        onBlockFocus={handleBlockFocus}
                        highlightedBlockIds={highlightedBlockIds}
                    />
                </div>
            ) : null}
        </div>
    )
}

function buildDocumentMarkdown(document: DocDocumentDetail) {
    const lines: string[] = []
    let previousLocation: string | null = null

    for (const chunk of document.chunks
        .slice()
        .sort((a, b) => a.chunkIndex - b.chunkIndex)) {
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
    if (pageMatch) {
        return `第 ${pageMatch[1]} 页`
    }
    return value
}

function escapeMarkdownHeading(value: string) {
    return value.replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1")
}

function isOcrBlock(value: unknown): value is OcrBlock {
    if (!isRecord(value)) return false
    return (
        typeof value.id === "string" &&
        isOcrBlockType(value.type) &&
        typeof value.text === "string" &&
        typeof value.page === "number" &&
        typeof value.pageWidth === "number" &&
        typeof value.pageHeight === "number" &&
        typeof value.confidence === "number"
    )
}

function isOcrBlockType(value: unknown): value is OcrBlock["type"] {
    return (
        value === "heading" ||
        value === "paragraph" ||
        value === "list" ||
        value === "table" ||
        value === "figure" ||
        value === "header" ||
        value === "footer" ||
        value === "page_number"
    )
}

function isViewerMode(value: string): value is ViewerMode {
    return value === "file" || value === "text"
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}
