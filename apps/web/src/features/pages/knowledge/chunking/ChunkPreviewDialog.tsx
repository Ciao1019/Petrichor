"use client"

import * as React from "react"
import { FileUp, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { detectFileType, parseDocument } from "@/features/pages/knowledge/documents/parse"
import { knowledgeBaseDocumentApi, type ChunkPreviewItem, type KnowledgeBaseChunkStrategy } from "@/lib/api"
import { cn } from "@/lib/utils"

const SAMPLE = `# 产品手册

本手册介绍产品的安装、配置与日常维护。

## 安装

### macOS

在终端执行安装脚本，安装完成后重启终端即可使用。安装过程会写入配置文件，不会修改系统目录。

### Linux

包管理器安装后需要手动初始化配置目录，否则首次启动会报错。

## 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 启动失败 | 配置缺失 | 重新初始化 |
| 检索为空 | 未建索引 | 触发重建 |
`

export interface ChunkPreviewOptions {
    strategy: KnowledgeBaseChunkStrategy
    chunkSize: number
    chunkOverlap: number
    separators: string[]
    enableParentChild: boolean
    parentChunkSize: number
    childChunkSize: number
}

/**
 * 分块效果预览。切分由 Go 侧执行，这里把面板上当前（可能尚未保存）的参数一并传过去，
 * 所以看到的分片与真正入库的完全一致——而不是浏览器另算一套。
 */
export function ChunkPreviewDialog({
    open,
    onOpenChange,
    knowledgeBaseId,
    options,
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    knowledgeBaseId: string
    options: ChunkPreviewOptions
}) {
    const [text, setText] = React.useState(SAMPLE)
    const [parsing, setParsing] = React.useState(false)
    const [running, setRunning] = React.useState(false)
    const [sourceName, setSourceName] = React.useState<string | null>(null)
    const [chunks, setChunks] = React.useState<ChunkPreviewItem[]>([])
    const fileInputRef = React.useRef<HTMLInputElement>(null)

    const run = React.useCallback(async (value: string) => {
        if (!value.trim()) {
            setChunks([])
            return
        }
        setRunning(true)
        try {
            const response = await knowledgeBaseDocumentApi.chunkPreview({ knowledgeBaseId, text: value, ...options })
            setChunks(response.data.chunks)
        } catch (error) {
            const message = (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg
            toast.error(message || "分块预览失败")
        } finally {
            setRunning(false)
        }
    }, [knowledgeBaseId, options])

    // 打开时、以及参数或文本变化后重新试切；输入过程中做一点防抖。
    React.useEffect(() => {
        if (!open) return
        const timer = window.setTimeout(() => void run(text), 300)
        return () => window.clearTimeout(timer)
    }, [open, run, text])

    const loadFile = React.useCallback(async (file: File) => {
        const fileType = detectFileType(file)
        if (!fileType) {
            toast.error(`不支持的文件类型：${file.name}`)
            return
        }
        setParsing(true)
        try {
            const parsed = await parseDocument(file, fileType)
            setText(parsed.extractedText)
            setSourceName(file.name)
        } catch (error) {
            toast.error(error instanceof Error ? error.message : `解析 ${file.name} 失败`)
        } finally {
            setParsing(false)
        }
    }, [])

    const children = chunks.filter((chunk) => chunk.chunkType !== "parent_text")
    const parents = chunks.filter((chunk) => chunk.chunkType === "parent_text")
    const lengths = children.map((chunk) => chunk.charCount)
    const stats = lengths.length > 0
        ? {
            count: lengths.length,
            min: Math.min(...lengths),
            max: Math.max(...lengths),
            average: Math.round(lengths.reduce((total, value) => total + value, 0) / lengths.length),
        }
        : null

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col gap-4">
                <DialogHeader>
                    <DialogTitle>测试分块效果</DialogTitle>
                    <DialogDescription>
                        由服务端按当前设置切分（{options.strategy} · {options.chunkSize} 字符 · 重叠 {options.chunkOverlap}
                        {options.enableParentChild ? ` · 父子分块 ${options.parentChunkSize || 4096}/${options.childChunkSize || 384}` : ""}），不会写入知识库。
                    </DialogDescription>
                </DialogHeader>

                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" disabled={parsing} onClick={() => fileInputRef.current?.click()}>
                        {parsing ? <Loader2 className="size-4 animate-spin" /> : <FileUp className="size-4" />}
                        选择文件
                    </Button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        className="hidden"
                        accept=".md,.markdown,.pdf,.docx,.xlsx,.xls,.csv,.tsv"
                        onChange={(event) => {
                            const file = event.target.files?.[0]
                            event.target.value = ""
                            if (file) void loadFile(file)
                        }}
                    />
                    <Button variant="ghost" size="sm" onClick={() => { setText(SAMPLE); setSourceName(null) }}>恢复示例</Button>
                    {sourceName ? <span className="truncate text-xs text-muted-foreground">来源：{sourceName}</span> : null}
                </div>

                <Textarea
                    value={text}
                    onChange={(event) => { setText(event.target.value); setSourceName(null) }}
                    rows={6}
                    className="shrink-0 font-mono text-xs"
                    placeholder="粘贴一段文本，或选择文件"
                />

                <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {running ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    {stats ? (
                        <>
                            <Badge variant="secondary">{stats.count} 个可召回分片</Badge>
                            {parents.length > 0 ? <Badge variant="outline">{parents.length} 个父块</Badge> : null}
                            <span>最短 {stats.min}</span>
                            <span>最长 {stats.max}</span>
                            <span>平均 {stats.average} 字符</span>
                        </>
                    ) : <span>{running ? "正在切分…" : "没有可切分的内容"}</span>}
                </div>

                <ScrollArea className="min-h-0 flex-1 rounded-md border">
                    <div className="divide-y">
                        {chunks.map((chunk) => (
                            <div key={`${chunk.chunkType}-${chunk.chunkIndex}`} className={cn("p-3", chunk.chunkType === "parent_text" && "bg-muted/40")}>
                                <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                    <Badge variant="outline" className="tabular-nums">#{chunk.chunkIndex}</Badge>
                                    {chunk.chunkType === "parent_text"
                                        ? <Badge variant="secondary">父块 · 仅回填上下文</Badge>
                                        : chunk.parentChunkIndex !== null
                                            ? <span>子块 → 父块 #{chunk.parentChunkIndex}</span>
                                            : null}
                                    <span className="tabular-nums">{chunk.charCount} 字符 · 约 {chunk.tokenEstimate} tokens</span>
                                </div>
                                {chunk.contextHeader ? (
                                    <pre className="mb-1.5 overflow-x-auto whitespace-pre-wrap rounded bg-muted/60 px-2 py-1 text-[11px] leading-5 text-muted-foreground">{chunk.contextHeader}</pre>
                                ) : null}
                                <pre className="overflow-x-auto whitespace-pre-wrap text-xs leading-5">{chunk.text}</pre>
                            </div>
                        ))}
                    </div>
                </ScrollArea>
            </DialogContent>
        </Dialog>
    )
}
