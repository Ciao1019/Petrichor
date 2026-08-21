"use client"

import * as React from "react"
import { toast } from "sonner"

import { Copy, Loader2, MessageCircleQuestion, Search } from "@/components/iconimate"
import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useArticleChunkDialogState } from "@/components/knowledge/useArticleChunkDialogState"
import type { ArticleKnowledgeChunkResponse } from "@/lib/api"
import { cn } from "@/lib/utils"

type ArticleChunkDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  knowledgeBaseId?: string
  articleId?: string
  /** 只读文章不提供构建入口，只展示已有结果。 */
  readOnly?: boolean
}

function formatBuiltAt(value: string | null) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

async function copyText(value: string, successMessage: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    toast.error("当前环境不支持复制")
    return
  }
  try {
    await navigator.clipboard.writeText(value)
    toast.success(successMessage)
  } catch {
    toast.error("复制失败，请手动选中复制")
  }
}

function ChunkRow({ chunk }: { chunk: ArticleKnowledgeChunkResponse }) {
  return (
    <AccordionItem value={chunk.chunkKey} className="rounded-lg border px-3 last:border-b">
      <AccordionTrigger className="py-3 hover:no-underline">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant="outline" className="shrink-0 font-mono text-[11px]">
              {String(chunk.position + 1).padStart(2, "0")}
            </Badge>
            {chunk.headingPath.length > 1 ? (
              <span className="min-w-0 truncate">
                {chunk.headingPath.slice(0, -1).map((part, index) => (
                  <span key={`${part}-${index}`} className="text-muted-foreground">
                    {part}
                    <span className="mx-1 text-muted-foreground/50">/</span>
                  </span>
                ))}
                <span className="font-medium">{chunk.headingPath.at(-1)}</span>
              </span>
            ) : (
              <span className="truncate font-medium">{chunk.heading}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-normal text-muted-foreground">
            <span className="font-mono">{chunk.chunkKey}</span>
            <span>{chunk.charCount} 字</span>
            <span className="inline-flex items-center gap-1">
              <MessageCircleQuestion className="size-3" />
              {chunk.recommendedQuestions.length} 个问题
            </span>
          </div>
        </div>
      </AccordionTrigger>
      <AccordionContent className="space-y-4 pb-4">
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-medium text-muted-foreground">该分片生成的问题</h4>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
              disabled={chunk.recommendedQuestions.length === 0}
              onClick={() => void copyText(chunk.recommendedQuestions.join("\n"), "已复制该分片的问题")}
            >
              <Copy className="size-3" />复制
            </Button>
          </div>
          {chunk.recommendedQuestions.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
              该分片没有生成推荐问题。
            </p>
          ) : (
            <ol className="space-y-1.5">
              {chunk.recommendedQuestions.map((question, index) => (
                <li
                  key={`${chunk.chunkKey}-q-${index}`}
                  className="flex items-start gap-2 rounded-md bg-muted/40 px-3 py-2 text-sm"
                >
                  <span className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground">
                    Q{index + 1}
                  </span>
                  <span className="min-w-0 flex-1 break-words">{question}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-medium text-muted-foreground">分片正文（Markdown）</h4>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
              onClick={() => void copyText(chunk.contentMd, "已复制分片正文")}
            >
              <Copy className="size-3" />复制
            </Button>
          </div>
          <pre className="app-scrollbar max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-relaxed whitespace-pre-wrap break-words">
            {chunk.contentMd}
          </pre>
        </section>
      </AccordionContent>
    </AccordionItem>
  )
}

export function ArticleChunkDialog({
  open,
  onOpenChange,
  knowledgeBaseId,
  articleId,
  readOnly = false,
}: ArticleChunkDialogProps) {
  const { loading, building, error, data, keyword, setKeyword, visibleChunks, rebuild } =
    useArticleChunkDialogState({ open, knowledgeBaseId, articleId })

  const built = Boolean(data?.built)
  const busy = loading || building

  const footer = (
    <div className="flex w-full items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">
        {data?.builtAt ? `构建于 ${formatBuiltAt(data.builtAt)}` : null}
      </span>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          关闭
        </Button>
        {!readOnly ? (
          <Button type="button" disabled={busy || !articleId} onClick={() => void rebuild()}>
            {building ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                构建中...
              </>
            ) : built ? (
              "重新构建"
            ) : (
              "构建知识"
            )}
          </Button>
        ) : null}
      </div>
    </div>
  )

  return (
    <ModalShell
      open={open}
      onOpenChange={onOpenChange}
      title="文章分片"
      description="「构建知识」按标题与段落把正文切成检索单元，并为每个分片生成推荐问题。"
      contentClassName="sm:max-w-3xl"
      footer={footer}
    >
      <div className="space-y-4 p-1">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border px-3 py-2 text-xs text-muted-foreground">
          <span>
            分片 <strong className="text-foreground">{data?.chunkCount ?? 0}</strong> 个
          </span>
          <span>
            推荐问题 <strong className="text-foreground">{data?.questionCount ?? 0}</strong> 个
          </span>
          {data?.stale ? (
            <Badge variant="destructive">
              {data.chunkAlgorithmVersion < data.currentChunkAlgorithmVersion
                ? "分片由旧版切分算法生成，建议重建"
                : "正文已改动，分片待重建"}
            </Badge>
          ) : null}
        </div>

        {error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {built ? (
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              placeholder="搜索分片标题、正文或问题"
              className="pl-8"
              onChange={(event) => setKeyword(event.target.value)}
            />
          </div>
        ) : null}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            加载分片中...
          </div>
        ) : !built ? (
          <div className={cn("rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground")}>
            {building
              ? "正在构建知识，模型会逐个分片生成问题，请稍候..."
              : readOnly
                ? "这篇文章还没有构建过知识，暂无分片。"
                : "这篇文章还没有构建过知识。点击右下角「构建知识」生成分片与推荐问题。"}
          </div>
        ) : visibleChunks.length === 0 ? (
          <div className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
            没有匹配「{keyword}」的分片。
          </div>
        ) : (
          <Accordion
            // 搜索时展开全部命中项，让匹配的问题/正文直接可见；换关键词后重置展开状态。
            key={keyword}
            type="multiple"
            defaultValue={
              keyword.trim()
                ? visibleChunks.map((chunk) => chunk.chunkKey)
                : visibleChunks[0]
                  ? [visibleChunks[0].chunkKey]
                  : []
            }
            className="space-y-2"
          >
            {visibleChunks.map((chunk) => (
              <ChunkRow key={chunk.chunkKey} chunk={chunk} />
            ))}
          </Accordion>
        )}
      </div>
    </ModalShell>
  )
}

export default ArticleChunkDialog
