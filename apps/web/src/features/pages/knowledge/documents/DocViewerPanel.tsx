"use client"

import * as React from "react"
import { useTheme } from "next-themes"
import { CircleHelp, ExternalLink, GitBranch, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { EditorTocOverlay, filterTocForOverlay } from "@/components/knowledge/EditorTocOverlay"
import { MarkdownPreview } from "@/components/markdown/MarkdownPreview"
import { buildToc } from "@/lib/markdown-toc"
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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
    knowledgeBaseDocumentApi,
    uploadApi,
    type KBChunkQuestion,
    type KBDocumentDetail,
} from "@/lib/api"
import { cn } from "@/lib/utils"

type ViewerMode = "file" | "chunks" | "text"
type FilePreviewState = {
    documentId: string
    url: string | null
    loading: boolean
    error: string | null
}

export type DocViewerHighlight = {
    page: number
    text: string
    startOffset?: number | null
    endOffset?: number | null
}

export function DocViewerPanel({
    document,
    highlight,
}: {
    document: KBDocumentDetail | null
    highlight?: DocViewerHighlight | null
}) {
    const { resolvedTheme } = useTheme()
    const [manualDark, setManualDark] = React.useState<boolean | null>(null)
    const isDark = manualDark ?? resolvedTheme === "dark"
    const [fileState, setFileState] = React.useState<FilePreviewState | null>(null)
    const [modeState, setModeState] = React.useState<{ documentId: string; mode: ViewerMode } | null>(null)
    const [chunkHighlight, setChunkHighlight] = React.useState<DocViewerHighlight | null>(null)
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
    const activeHighlight = chunkHighlight ?? highlight ?? null
    const highlightSig = activeHighlight ? `${documentId}:${activeHighlight.page}:${activeHighlight.startOffset ?? ""}:${activeHighlight.text}` : null
    React.useEffect(() => {
        if (!highlightSig || !documentId) return
        setModeState({ documentId, mode: "file" })
    }, [highlightSig, documentId])

    React.useEffect(() => {
        setChunkHighlight(null)
    }, [documentId, highlight])

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
            highlight={activeHighlight}
        />
    )

    return (
        <Tabs value={mode} onValueChange={handleModeChange} className="h-full min-h-0 gap-0">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
                <TabsList className="h-8">
                    <TabsTrigger value="file" className="text-xs">原文件</TabsTrigger>
                    <TabsTrigger value="chunks" className="text-xs" disabled={document.chunks.length === 0}>分片</TabsTrigger>
                    <TabsTrigger value="text" className="text-xs" disabled={!hasText}>文本</TabsTrigger>
                </TabsList>
            </div>
            <TabsContent value="file" className="m-0 min-h-0">
                {originalPreview}
            </TabsContent>
            <TabsContent value="text" className="m-0 min-h-0">
                <ParsedTextPreview text={markdownText} highlight={activeHighlight} />
            </TabsContent>
            <TabsContent value="chunks" className="m-0 min-h-0">
                <DocumentChunksPreview
                    chunks={document.chunks}
                    onOpenSource={(chunk) => {
                        setChunkHighlight({
                            page: chunk.page ?? 1,
                            text: chunk.text,
                            startOffset: chunk.startOffset,
                            endOffset: chunk.endOffset,
                        })
                        setModeState({ documentId: document.id, mode: document.fileType === "pdf" ? "file" : "text" })
                    }}
                />
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
    document: KBDocumentDetail
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

    if (document.fileType === "md" || document.fileType === "markdown") {
        // md 的「原文件」就是正文本身，没有二进制版面要还原，所以直接走站内
        // 文章那套 Plate 只读渲染 + 大纲；命中高亮仍留给「文本」标签页，
        // 那里是按字符偏移定位的纯文本，不能被富文本结构打断。
        if (highlight?.startOffset == null) {
            return <MarkdownFilePreview markdown={buildDocumentMarkdown(document)} />
        }
        return <ParsedTextPreview text={buildDocumentMarkdown(document)} highlight={highlight} />
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

// Plate 编辑器实例化 + 把整篇 Markdown 反序列化成 Slate 节点是同步的重活，
// 直接静态引入会挤在抽屉的开场动画那一帧里，表现为「点开卡一下」。
// 懒加载让它落到动画之后，同时也把 plate 的包体从文档列表的首屏 chunk 里摘出去。
const LazyPlateMarkdownPreview = React.lazy(() =>
    import("@/components/plate/PlateMarkdownPreview").then((mod) => ({
        default: mod.PlateMarkdownPreview,
    }))
)

/**
 * Markdown 原文件视图：Plate 只读渲染 + 右侧大纲。
 *
 * 复用站内文章那套渲染（`plate-article` 样式、嵌入指令等），
 * 标题 id 由 PlateMarkdownPreview 按 headings 回填，大纲才能锚点跳转。
 */
function MarkdownFilePreview({ markdown }: { markdown: string }) {
    const toc = React.useMemo(() => buildToc(markdown), [markdown])
    const outline = React.useMemo(() => filterTocForOverlay(toc), [toc])
    const scrollRef = React.useRef<HTMLDivElement | null>(null)
    const [activeId, setActiveId] = React.useState<string>("")
    // 大纲是 position:fixed 的浮层，得贴着正文列的右内边缘，
    // 所以要把这块滚动容器的位置量出来喂给它。
    const [anchor, setAnchor] = React.useState<{ right: number; top: number } | null>(null)

    React.useEffect(() => {
        const root = scrollRef.current
        if (!root) return
        const measure = () => {
            const rect = root.getBoundingClientRect()
            setAnchor({
                right: Math.max(8, window.innerWidth - rect.right + 16),
                top: Math.min(Math.max(rect.top + 32, 96), window.innerHeight * 0.75),
            })
        }
        measure()
        const resize = new ResizeObserver(measure)
        resize.observe(root)
        window.addEventListener("resize", measure)
        return () => {
            resize.disconnect()
            window.removeEventListener("resize", measure)
        }
    }, [])

    // 滚动到哪个标题就高亮哪一条。用相交观测而不是监听 scroll，
    // 免得每帧都去量一遍所有标题的位置。
    React.useEffect(() => {
        const root = scrollRef.current
        if (!root || outline.length === 0) return

        let intersection: IntersectionObserver | null = null
        let frame = 0

        const attach = () => {
            const targets = outline
                .map((item) => root.querySelector<HTMLElement>(`#${CSS.escape(item.id)}`))
                .filter((node): node is HTMLElement => node !== null)
            if (targets.length === 0) return
            intersection?.disconnect()
            intersection = new IntersectionObserver(
                (entries) => {
                    const visible = entries.filter((entry) => entry.isIntersecting)
                    if (visible.length === 0) return
                    const top = visible.reduce((best, entry) =>
                        entry.boundingClientRect.top < best.boundingClientRect.top ? entry : best
                    )
                    setActiveId(top.target.id)
                },
                { root, rootMargin: "0px 0px -70% 0px", threshold: 0 }
            )
            for (const target of targets) intersection.observe(target)
        }

        // 标题什么时候出现是不确定的：Plate 是懒加载的，它的 id 又要等渲染后
        // 再回填一轮。所以盯着 DOM 变化重挂观测，而不是只在挂载时试一次。
        const mutation = new MutationObserver(() => {
            window.cancelAnimationFrame(frame)
            frame = window.requestAnimationFrame(attach)
        })
        mutation.observe(root, { childList: true, subtree: true })
        frame = window.requestAnimationFrame(attach)

        return () => {
            window.cancelAnimationFrame(frame)
            mutation.disconnect()
            intersection?.disconnect()
        }
    }, [markdown, outline])

    const jumpTo = React.useCallback((id: string) => {
        const target = scrollRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
        if (!target) return
        target.scrollIntoView({ behavior: "smooth", block: "start" })
        setActiveId(id)
    }, [])

    if (!markdown.trim()) {
        return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无解析文本</div>
    }

    return (
        <div className="h-full min-h-0">
            <div ref={scrollRef} className="app-scrollbar h-full overflow-y-auto">
                <div className="mx-auto w-full max-w-4xl px-6 py-6">
                    <React.Suspense fallback={<MarkdownPreview value={markdown} variant="typography" className="max-w-none" />}>
                        <LazyPlateMarkdownPreview markdown={markdown} headings={toc} className="mx-auto max-w-none" />
                    </React.Suspense>
                </div>
            </div>
            {outline.length > 0 && anchor ? (
                <EditorTocOverlay
                    navToc={outline}
                    activeHeadingId={activeId}
                    rightOffset={anchor.right}
                    topOffset={anchor.top}
                    onTocClick={jumpTo}
                />
            ) : null}
        </div>
    )
}

function ParsedTextPreview({ text, highlight }: { text: string; highlight?: DocViewerHighlight | null }) {
    const markRef = React.useRef<HTMLElement>(null)
    const runes = React.useMemo(() => Array.from(text), [text])
    const start = highlight?.startOffset != null ? Math.max(0, Math.min(runes.length, highlight.startOffset)) : null
    const end = start != null
        ? Math.max(start, Math.min(runes.length, highlight?.endOffset ?? start + Array.from(highlight?.text ?? "").length))
        : null

    React.useEffect(() => {
        if (start == null) return
        window.setTimeout(() => markRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }), 80)
    }, [end, start])

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
                {start != null && end != null ? (
                    <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-foreground"><span>{runes.slice(0, start).join("")}</span><mark ref={markRef} className="rounded bg-amber-200/80 px-0.5 text-inherit ring-2 ring-amber-400/30 dark:bg-amber-500/30">{runes.slice(start, end).join("")}</mark><span>{runes.slice(end).join("")}</span></pre>
                ) : <MarkdownPreview value={text} variant="typography" className="max-w-none" />}
            </div>
        </ScrollArea>
    )
}

type DocChunk = KBDocumentDetail["chunks"][number]

function DocumentChunksPreview({ chunks, onOpenSource }: { chunks: DocChunk[]; onOpenSource: (chunk: DocChunk) => void }) {
    // 父块不是独立的召回单元，不该在列表里单独占一张卡；它只通过子块的
    // 「查看父块上下文」露出。按 chunkIndex 建索引供那个气泡取用。
    const parentByIndex = React.useMemo(() => {
        const map = new Map<number, DocChunk>()
        for (const chunk of chunks) {
            if (chunk.chunkType === "parent_text") map.set(chunk.chunkIndex, chunk)
        }
        return map
    }, [chunks])
    const retrievable = React.useMemo(() => chunks.filter((chunk) => chunk.chunkType !== "parent_text"), [chunks])

    // 问题在这里本地维护：增删和重新生成都只影响单个分片，
    // 没必要为了一条问题把整份文档详情重新拉一遍。
    const [questionOverrides, setQuestionOverrides] = React.useState<Record<string, KBChunkQuestion[]>>({})
    React.useEffect(() => setQuestionOverrides({}), [chunks])

    return (
        <ScrollArea className="h-full">
            <div className="mx-auto grid w-full max-w-5xl gap-3 px-4 py-4 sm:px-6">
                {retrievable.map((chunk, position) => (
                    <ChunkCard
                        key={chunk.id}
                        chunk={chunk}
                        ordinal={position + 1}
                        parent={chunk.parentChunkIndex != null ? parentByIndex.get(chunk.parentChunkIndex) ?? null : null}
                        questions={questionOverrides[chunk.id] ?? chunk.questions ?? []}
                        onQuestionsChange={(next) => setQuestionOverrides((current) => ({ ...current, [chunk.id]: next }))}
                        onOpenSource={() => onOpenSource(chunk)}
                    />
                ))}
            </div>
        </ScrollArea>
    )
}

function ChunkCard({
    chunk,
    ordinal,
    parent,
    questions,
    onQuestionsChange,
    onOpenSource,
}: {
    chunk: DocChunk
    ordinal: number
    parent: DocChunk | null
    questions: KBChunkQuestion[]
    onQuestionsChange: (next: KBChunkQuestion[]) => void
    onOpenSource: () => void
}) {
    return (
        <article className="group rounded-xl border bg-card p-4 shadow-xs transition hover:border-primary/30 hover:shadow-sm">
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">片段 {ordinal}</span>
                {chunk.page != null ? <span>第 {chunk.page} 页</span> : null}
                {chunk.locator ? <span>{formatChunkLocation(chunk.locator)}</span> : null}
                {"charCount" in chunk ? <span>{chunk.charCount} 字符</span> : null}
                {"tokenEstimate" in chunk ? <span>约 {chunk.tokenEstimate} tokens</span> : null}
                {chunk.chunkType === "image" ? <span className="rounded bg-muted px-1.5 py-0.5">多模态识别</span> : null}
                <span className="ml-auto flex items-center gap-0.5">
                    {parent ? <ParentContextPopover parent={parent} /> : null}
                    <ChunkQuestionsPopover chunkId={chunk.id} questions={questions} onChange={onQuestionsChange} />
                    <Button type="button" variant="ghost" size="icon-sm" className="size-7" aria-label="定位原文" title="定位原文" onClick={onOpenSource}>
                        <ExternalLink className="size-3.5" />
                    </Button>
                </span>
            </div>
            {chunk.contextHeader ? <div className="mb-3 rounded-md border-l-2 border-primary/40 bg-muted/60 px-3 py-2 text-xs leading-5 text-muted-foreground"><span className="font-medium text-foreground">上下文</span><pre className="mt-1 whitespace-pre-wrap font-sans">{chunk.contextHeader}</pre></div> : null}
            <p className="whitespace-pre-wrap text-sm leading-7">{chunk.text}</p>
        </article>
    )
}

/** 查看父块上下文：命中的是子块，但真正回填给模型的是这一段。 */
function ParentContextPopover({ parent }: { parent: DocChunk }) {
    return (
        // modal 是必需的，不是为了遮罩：分片面板开在 Sheet（Radix Dialog）里，
        // Dialog 的 react-remove-scroll 会拦掉所有不在它子树内的滚轮事件，
        // 而气泡是 portal 到 body 的，滚轮会被直接 preventDefault。
        // 加上 modal 后气泡自己压一层滚动锁，成为栈顶，Dialog 那层就不再拦截。
        <Popover modal>
            <PopoverTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" className="size-7" aria-label="查看父块上下文" title="查看父块上下文">
                    <GitBranch className="size-3.5" />
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(560px,90vw)] p-0">
                <div className="flex items-center gap-2 border-b px-3 py-2 text-sm font-medium">
                    <GitBranch className="size-4 text-primary" />
                    查看父块上下文
                    <span className="ml-auto text-xs font-normal text-muted-foreground">{parent.charCount} 字符</span>
                </div>
                {/* 这里不能用 ScrollArea：它的 Viewport 是 h-full，父级只有 max-h 时会撑满全文，
                    Root 的 overflow-hidden 把超出部分直接裁掉，反而滚不动。 */}
                <div className="app-scrollbar max-h-[min(60vh,420px)] overflow-y-auto px-4 py-3">
                    <MarkdownPreview value={parent.text} variant="typography" className="max-w-none" />
                </div>
            </PopoverContent>
        </Popover>
    )
}

/** 辅助召回问题：每条单独向量化，命中后回指这一片，可手工增删或整片重生成。 */
function ChunkQuestionsPopover({
    chunkId,
    questions,
    onChange,
}: {
    chunkId: string
    questions: KBChunkQuestion[]
    onChange: (next: KBChunkQuestion[]) => void
}) {
    const [draft, setDraft] = React.useState("")
    const [adding, setAdding] = React.useState(false)
    const [busy, setBusy] = React.useState(false)

    const failure = (error: unknown, fallback: string) =>
        (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
        (error instanceof Error ? error.message : fallback)

    const submitDraft = async () => {
        const question = draft.trim()
        if (!question) return
        setBusy(true)
        try {
            const response = await knowledgeBaseDocumentApi.addChunkQuestion(chunkId, question)
            onChange(response.data.questions)
            setDraft("")
            setAdding(false)
        } catch (error) {
            toast.error(failure(error, "新增问题失败"))
        } finally {
            setBusy(false)
        }
    }

    const regenerate = async () => {
        setBusy(true)
        try {
            const response = await knowledgeBaseDocumentApi.regenerateChunkQuestions(chunkId)
            onChange(response.data.questions)
            toast.success(`已重新生成 ${response.data.questions.length} 个问题`)
        } catch (error) {
            toast.error(failure(error, "重新生成问题失败"))
        } finally {
            setBusy(false)
        }
    }

    const remove = async (id: string) => {
        setBusy(true)
        try {
            const response = await knowledgeBaseDocumentApi.deleteChunkQuestion(id)
            onChange(response.data.questions)
        } catch (error) {
            toast.error(failure(error, "删除问题失败"))
        } finally {
            setBusy(false)
        }
    }

    return (
        // 同 ParentContextPopover：Sheet 的滚动锁会吃掉 portal 出去的滚轮事件。
        <Popover modal>
            <PopoverTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" className="size-7" aria-label="辅助召回问题" title="辅助召回问题">
                    <CircleHelp className={cn("size-3.5", questions.length > 0 ? "text-primary" : undefined)} />
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(520px,90vw)] p-0">
                <div className="flex items-center gap-2 border-b px-3 py-2 text-sm font-medium">
                    <CircleHelp className="size-4 text-primary" />
                    辅助召回问题
                    <span className="text-xs font-normal text-muted-foreground">{questions.length}</span>
                    <span className="ml-auto flex items-center gap-0.5">
                        <Button type="button" variant="ghost" size="icon-sm" className="size-7" disabled={busy} aria-label="新增问题" title="新增问题" onClick={() => setAdding(true)}>
                            <Plus className="size-3.5" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon-sm" className="size-7" disabled={busy} aria-label="重新生成" title="用大模型重新生成这一片的问题" onClick={() => void regenerate()}>
                            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                        </Button>
                    </span>
                </div>
                <div className="app-scrollbar max-h-[min(60vh,360px)] overflow-y-auto">
                    {questions.length === 0 && !adding ? (
                        <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                            这一片还没有辅助召回问题，可以手工新增或让大模型生成。
                        </p>
                    ) : null}
                    {questions.map((item) => (
                        <div key={item.id} className="group/question flex items-start gap-2 border-b px-3 py-2.5 last:border-b-0">
                            <CircleHelp className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 text-sm leading-6">{item.question}</span>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="size-6 shrink-0 opacity-0 transition-opacity group-hover/question:opacity-100"
                                disabled={busy}
                                aria-label={`删除问题：${item.question}`}
                                onClick={() => void remove(item.id)}
                            >
                                <Trash2 className="size-3.5 text-destructive" />
                            </Button>
                        </div>
                    ))}
                    {adding ? (
                        <div className="flex items-center gap-2 px-3 py-2.5">
                            <Input
                                autoFocus
                                value={draft}
                                disabled={busy}
                                placeholder="输入一个用户可能会问的问题，回车保存"
                                className="h-8"
                                onChange={(event) => setDraft(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                        event.preventDefault()
                                        void submitDraft()
                                    }
                                    if (event.key === "Escape") {
                                        setAdding(false)
                                        setDraft("")
                                    }
                                }}
                            />
                            <Button type="button" size="sm" className="h-8" disabled={busy || !draft.trim()} onClick={() => void submitDraft()}>
                                保存
                            </Button>
                        </div>
                    ) : null}
                </div>
            </PopoverContent>
        </Popover>
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

function buildDocumentMarkdown(document: KBDocumentDetail) {
    if (document.extractedText?.trim()) return document.extractedText
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
    return value === "file" || value === "chunks" || value === "text"
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}
