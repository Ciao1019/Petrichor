"use client"

/**
 * 文档预览页：原文件 / 分片 / 文本三个视图占满整页。
 *
 * 以前这是知识库详情页里的右侧抽屉，抽屉宽度有限、又压着列表，
 * 长文档和大纲都施展不开，所以改成独立路由。
 * 从分片列表点「定位原文」时用 ?chunk=N 带上要高亮的分片。
 */

import * as React from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DocViewerPanel, type DocViewerHighlight } from "@/features/pages/knowledge/documents/DocViewerPanel"
import {
  knowledgeBaseDocumentApi,
  type KBDocumentDetail,
  type KBDocumentStatus,
} from "@/lib/api"
import { knowledgeBasePath } from "@/lib/dashboard-routes"
import { cn } from "@/lib/utils"

function apiError(error: unknown, fallback: string) {
  return (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
    (error instanceof Error ? error.message : fallback)
}

const STATUS_META: Record<KBDocumentStatus, { label: string; className: string }> = {
  pending: { label: "等待处理", className: "text-amber-600 dark:text-amber-400" },
  processing: { label: "处理中", className: "text-primary" },
  partial: { label: "部分完成", className: "text-amber-600 dark:text-amber-400" },
  failed: { label: "处理失败", className: "text-destructive" },
  ready: { label: "可检索", className: "text-emerald-600 dark:text-emerald-400" },
}

export function KnowledgeBaseDocumentPage() {
  const { knowledgeBaseId, documentId } = useParams<{ knowledgeBaseId: string; documentId: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const [document, setDocument] = React.useState<KBDocumentDetail | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [highlight, setHighlight] = React.useState<DocViewerHighlight | null>(null)

  const chunkParam = searchParams.get("chunk")

  const load = React.useCallback(async () => {
    if (!documentId) return
    setLoading(true)
    try {
      const response = await knowledgeBaseDocumentApi.documentDetail(documentId)
      setDocument(response.data.document)
    } catch (error) {
      toast.error(apiError(error, "加载文档失败"))
      setDocument(null)
    } finally {
      setLoading(false)
    }
  }, [documentId])

  React.useEffect(() => { void load() }, [load])

  // ?chunk=N 是从分片列表或检索引用跳过来的，落地即定位到那一片。
  React.useEffect(() => {
    if (!document || chunkParam == null) {
      setHighlight(null)
      return
    }
    const chunkIndex = Number.parseInt(chunkParam, 10)
    if (Number.isNaN(chunkIndex)) return
    const chunk = document.chunks.find((item) => item.chunkIndex === chunkIndex)
    if (!chunk) return
    setHighlight({
      page: chunk.page ?? 1,
      text: chunk.text,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
    })
  }, [chunkParam, document])

  const backToKnowledgeBase = React.useCallback(() => {
    if (knowledgeBaseId) navigate(knowledgeBasePath(knowledgeBaseId))
    else navigate(-1)
  }, [knowledgeBaseId, navigate])

  const status = document ? STATUS_META[document.status] : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Button variant="ghost" size="icon-sm" aria-label="返回知识库" onClick={backToKnowledgeBase}>
          <ArrowLeft className="size-4" />
        </Button>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{document?.fileName ?? "文档预览"}</span>
        </span>
        {document ? (
          <>
            <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
              {document.chunkCount} 个分片
              {document.charCount ? ` · ${document.charCount} 字符` : ""}
            </span>
            <Badge variant="outline" className={cn("shrink-0 font-normal", status?.className)}>
              {status?.label}
            </Badge>
          </>
        ) : null}
        <Button variant="ghost" size="icon-sm" aria-label="刷新" disabled={loading} onClick={() => void load()}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </Button>
      </header>

      <div className="min-h-0 flex-1">
        {loading && !document ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            正在加载文档…
          </div>
        ) : !document ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            文档不存在或已被删除
            <Button variant="outline" size="sm" onClick={backToKnowledgeBase}>返回知识库</Button>
          </div>
        ) : (
          <DocViewerPanel document={document} highlight={highlight} />
        )}
      </div>
    </div>
  )
}

export default KnowledgeBaseDocumentPage
