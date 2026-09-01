"use client"

import * as React from "react"

import { PDFViewer, type PDFViewerHandle } from "@/components/extend/ui/pdf-viewer"
import {
    OcrBlockOverlay,
    OcrBlocksPanel,
    blockToHighlightArea,
    matchRecallBlockIds,
    type OcrBlock,
} from "@/components/extend/ui/layout-blocks"
import type { DocDocumentDetail } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { DocViewerHighlight } from "./DocViewerPanel"

export function DocPdfPreview({
    document,
    url,
    highlight,
}: {
    document: DocDocumentDetail
    url: string
    highlight: DocViewerHighlight | null
}) {
    const blocks = document.blocks.filter(isOcrBlock)
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
    const highlightedBlockIds = React.useMemo(() => {
        if (!highlight) return new Set<string>()
        return new Set(matchRecallBlockIds(blocks, highlight.page, highlight.text))
        // highlightSig 刻意把对象依赖收敛为值语义。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [blocks, highlightSig])

    const firstHighlightBlock = React.useMemo(
        () => blocks.find((block) => highlightedBlockIds.has(block.id)) ?? null,
        [blocks, highlightedBlockIds],
    )

    React.useEffect(() => {
        setPdfReady(false)
    }, [url])

    React.useEffect(() => {
        if (!highlight) {
            setPulsing(false)
            return
        }
        if (firstHighlightBlock) setSelectedBlockId(firstHighlightBlock.id)
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
        // highlightSig 刻意把高亮对象依赖收敛为值语义。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [highlightSig, pdfReady, firstHighlightBlock])

    const activeBlockId = blocks.some((block) => block.id === selectedBlockId) ? selectedBlockId : blocks[0]?.id
    const handleBlockFocus = React.useCallback((block: OcrBlock) => {
        setSelectedBlockId(block.id)
        pdfRef.current?.scrollToPageArea(block.page, blockToHighlightArea(block), { behavior: "smooth" })
    }, [])

    return (
        <div className="flex h-full min-h-0 w-full">
            <div className="min-w-0 flex-1">
                <PDFViewer
                    ref={pdfRef}
                    className="h-full"
                    src={url}
                    fileName={document.fileName}
                    showUpload={false}
                    onDocumentLoadSuccess={() => setPdfReady(true)}
                    renderPageOverlay={({ pageNumber, pageWidth, pageHeight }) => {
                        const pageBlocks = blocksByPage.get(pageNumber)
                        if (!pageBlocks) return null
                        return pageBlocks.map((block) => (
                            <OcrBlockOverlay
                                key={block.id}
                                block={block}
                                isActive={block.id === activeBlockId}
                                isHighlighted={highlightedBlockIds.has(block.id)}
                                pulse={pulsing}
                                pageWidth={pageWidth}
                                pageHeight={pageHeight}
                            />
                        ))
                    }}
                />
            </div>
            {blocks.length > 0 ? (
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
    return ["heading", "paragraph", "list", "table", "figure", "header", "footer", "page_number"].includes(String(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}
