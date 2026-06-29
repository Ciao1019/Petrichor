"use client"

import * as React from "react"
import { useTheme } from "next-themes"
import { Loader2 } from "lucide-react"
import {
    PDFViewer,
    type PDFViewerHandle,
} from "@/components/extend/ui/pdf-viewer"
import {
    OcrBlockOverlay,
    OcrBlocksPanel,
    blockToHighlightArea,
    type OcrBlock,
} from "@/components/extend/ui/layout-blocks"
import { DocxViewerPreview } from "@/components/extend/ui/docx-viewer"
import { XlsxViewerPreview } from "@/components/extend/ui/xlsx-viewer"
import { uploadApi, type DocDocumentDetail } from "@/lib/api"
import { cn } from "@/lib/utils"

export function DocViewerPanel({ document }: { document: DocDocumentDetail | null }) {
    const { resolvedTheme } = useTheme()
    const [isDark, setIsDark] = React.useState(resolvedTheme === "dark")
    React.useEffect(() => {
        setIsDark(resolvedTheme === "dark")
    }, [resolvedTheme])

    const [url, setUrl] = React.useState<string | null>(null)
    const [loading, setLoading] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)

    React.useEffect(() => {
        if (!document) {
            setUrl(null)
            return
        }
        let cancelled = false
        setLoading(true)
        setError(null)
        setUrl(null)
        // 复用通用上传层的预签名下载（带鉴权 / 时效）
        uploadApi.presignGet(document.objectKey)
            .then((res) => {
                if (!cancelled) setUrl(res.data.url)
            })
            .catch(() => {
                if (!cancelled) setError("文件地址获取失败")
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [document])

    if (!document) {
        return (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                从左侧选择一个文件进行预览
            </div>
        )
    }

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
        return <PdfWithLayoutBlocks url={url} fileName={document.fileName} blocks={(document.blocks ?? []) as OcrBlock[]} />
    }

    if (document.fileType === "docx") {
        return (
            <DocxViewerPreview
                className="h-full"
                src={url}
                fileName={document.fileName}
                isDark={isDark}
                onIsDarkChange={setIsDark}
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
            onIsDarkChange={setIsDark}
            showUpload={false}
        />
    )
}

function PdfWithLayoutBlocks({ url, fileName, blocks }: { url: string; fileName: string; blocks: OcrBlock[] }) {
    const pdfRef = React.useRef<PDFViewerHandle>(null)
    const [activeBlockId, setActiveBlockId] = React.useState<string | undefined>(blocks[0]?.id)

    const blocksByPage = React.useMemo(() => {
        const map = new Map<number, OcrBlock[]>()
        for (const block of blocks) {
            const list = map.get(block.page) ?? []
            list.push(block)
            map.set(block.page, list)
        }
        return map
    }, [blocks])

    const handleBlockFocus = React.useCallback((block: OcrBlock) => {
        setActiveBlockId(block.id)
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
                    />
                </div>
            ) : null}
        </div>
    )
}
