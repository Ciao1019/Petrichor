"use client"

/**
 * assistant-wiki-tool-renders.tsx Wiki 与文档结构类工具的卡片渲染。
 *
 * 这些工具的共同点是结果都指向「站内某一页 / 某一节」，
 * 展示上要能点开原页面或看清文档骨架，与检索、写作类工具的形态不同，单独成文件。
 */

import * as React from "react"
import { makeAssistantToolUI } from "@assistant-ui/react"
import { BookOpen, ListTree, Search } from "@/components/iconimate"

import { useOpenWikiPage } from "@/components/markdown/wiki-link-context"
import { Badge } from "@/components/ui/badge"
import { asRecord, isPresent } from "./assistant-message-utils"
import { ToolStatusCard } from "./assistant-tool-renders"

const WIKI_KIND_LABELS: Record<string, string> = {
  index: "索引",
  source: "源文档",
  entity: "实体",
  concept: "概念",
  comparison: "对比",
  answer: "答案",
}

/** 可点击的 Wiki 页面条目：点击直接打开弹窗预览（与回答内 [[..]] 引用一致）。 */
function WikiPageHitRow({
  pageKey,
  title,
  summary,
  kindLabel,
}: {
  pageKey: string
  title: string
  summary?: string
  kindLabel?: string
}) {
  const openWikiPage = useOpenWikiPage()
  return (
    <button
      type="button"
      onClick={() => openWikiPage?.(pageKey)}
      className="block w-full rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:cursor-default"
      disabled={!openWikiPage}
    >
      <span className="flex items-center gap-2">
        {kindLabel ? <Badge variant="outline" className="shrink-0 text-[10px]">{kindLabel}</Badge> : null}
        <span className="line-clamp-1 min-w-0 text-sm font-medium">{title}</span>
      </span>
      {summary ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{summary}</p> : null}
    </button>
  )
}

export const WikiOverviewToolUI = makeAssistantToolUI({
  toolName: "wiki_overview",
  render: ({ result, status }) => {
    const payload = asRecord(result)
    const groups = Array.isArray(payload?.groups) ? payload.groups.map(asRecord).filter(isPresent) : []
    if (groups.length === 0) {
      return (
        <ToolStatusCard title="Wiki 总览" status={status} icon={<BookOpen className="size-4" />}>
          {typeof payload?.emptyMessage === "string" ? (
            <p className="text-xs text-muted-foreground">{payload.emptyMessage}</p>
          ) : null}
        </ToolStatusCard>
      )
    }
    return (
      <ToolStatusCard title="Wiki 总览" status={status} icon={<BookOpen className="size-4" />} collapsible defaultOpen={false}>
        <div className="space-y-3">
          {groups.map((group, groupIndex) => {
            const pages = Array.isArray(group.pages) ? group.pages.map(asRecord).filter(isPresent) : []
            if (pages.length === 0) return null
            const label = typeof group.label === "string" ? group.label : `分组 ${groupIndex + 1}`
            return (
              <div key={String(group.key ?? groupIndex)} className="space-y-1.5">
                <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  {label}（{pages.length}）
                </p>
                {pages.slice(0, 8).map((page, index) => {
                  const pageKey = typeof page.pageKey === "string" ? page.pageKey : ""
                  const kind = typeof page.kind === "string" ? page.kind : ""
                  return (
                    <WikiPageHitRow
                      key={pageKey || index}
                      pageKey={pageKey}
                      title={typeof page.title === "string" ? page.title : pageKey}
                      summary={typeof page.summary === "string" ? page.summary : undefined}
                      kindLabel={WIKI_KIND_LABELS[kind] ?? kind}
                    />
                  )
                })}
              </div>
            )
          })}
        </div>
      </ToolStatusCard>
    )
  },
})

/** 目录里最多铺开的章节数，超出只给计数，避免一条消息里塞进整本书。 */
const OUTLINE_VISIBLE_NODES = 40

/**
 * 文档目录：knowledge.outline 的结果。
 * 它和检索结果不同——不是「哪几段像这个问题」，而是整篇文档的骨架，
 * 所以按层级缩进铺开，并带上每节的篇幅与推荐问题，让人能跟着模型的选择走。
 */
export const ReadDocumentOutlineToolUI = makeAssistantToolUI({
  toolName: "read_document_outline",
  render: ({ result, status }) => {
    const payload = asRecord(result)
    const nodes = Array.isArray(payload?.nodes) ? payload.nodes.map(asRecord).filter(isPresent) : []
    const documentTitle = typeof payload?.title === "string" ? payload.title : ""
    const cardTitle = documentTitle ? `文档目录：${documentTitle}` : "文档目录"

    if (nodes.length === 0) {
      return (
        <ToolStatusCard title={cardTitle} status={status} icon={<ListTree className="size-4" />}>
          <p className="text-xs text-muted-foreground">这篇文档还没有可用目录，需要先执行一次「构建知识」。</p>
        </ToolStatusCard>
      )
    }

    const truncated = payload?.truncated === true
    const visible = nodes.slice(0, OUTLINE_VISIBLE_NODES)
    return (
      <ToolStatusCard
        title={`${cardTitle}（${nodes.length} 节${truncated ? "，已截断" : ""}）`}
        status={status}
        icon={<ListTree className="size-4" />}
        collapsible
        defaultOpen={false}
      >
        <ol className="space-y-1.5">
          {visible.map((node, index) => {
            const key = typeof node.nodeKey === "string" && node.nodeKey
              ? node.nodeKey
              : typeof node.chunkId === "string" && node.chunkId
                ? node.chunkId
                : String(index)
            const rawDepth = typeof node.depth === "number" ? node.depth : 0
            const depth = Math.min(Math.max(rawDepth, 0), 4)
            const sectionTitle = typeof node.title === "string" && node.title ? node.title : "未命名章节"
            const path = typeof node.path === "string" ? node.path : ""
            const summary = typeof node.summary === "string" ? node.summary : ""
            const tokens = typeof node.tokenEstimate === "number" ? node.tokenEstimate : 0
            const questions = Array.isArray(node.questions)
              ? node.questions.filter((q): q is string => typeof q === "string" && q.length > 0)
              : []
            return (
              <li
                key={key}
                style={{ paddingInlineStart: `${depth * 0.875}rem` }}
                className="rounded-md border border-border/40 bg-muted/20 px-3 py-2"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-sm font-medium">{sectionTitle}</span>
                  {tokens > 0 ? (
                    <span className="text-[10px] text-muted-foreground">约 {tokens} tokens</span>
                  ) : null}
                </div>
                {path && path !== sectionTitle ? (
                  <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{path}</p>
                ) : null}
                {summary ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{summary}</p> : null}
                {questions.length > 0 ? (
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    可回答：{questions.join(" · ")}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ol>
        {nodes.length > visible.length ? (
          <p className="mt-2 text-xs text-muted-foreground">还有 {nodes.length - visible.length} 节未展开</p>
        ) : null}
      </ToolStatusCard>
    )
  },
})

export const SearchWikiPagesToolUI = makeAssistantToolUI({
  toolName: "search_wiki_pages",
  render: ({ result, status }) => {
    const payload = asRecord(result)
    const rows = Array.isArray(payload?.items) ? payload.items.map(asRecord).filter(isPresent) : []
    const queries = Array.isArray(payload?.query)
      ? payload.query.filter((q): q is string => typeof q === "string")
      : []
    if (rows.length === 0) {
      return (
        <ToolStatusCard
          title={`检索 Wiki${queries.length > 0 ? `：${queries.join(" / ")}` : ""}`}
          status={status}
          icon={<Search className="size-4" />}
        >
          {typeof payload?.emptyMessage === "string" ? (
            <p className="text-xs text-muted-foreground">{payload.emptyMessage}</p>
          ) : null}
        </ToolStatusCard>
      )
    }
    return (
      <ToolStatusCard
        title={`检索 Wiki（${rows.length}${queries.length > 0 ? `：${queries.join(" / ")}` : ""}）`}
        status={status}
        icon={<Search className="size-4" />}
        collapsible
        defaultOpen={false}
      >
        <div className="space-y-1.5">
          {rows.slice(0, 10).map((row, index) => {
            const pageKey = typeof row.pageKey === "string" ? row.pageKey : ""
            const kind = typeof row.kind === "string" ? row.kind : ""
            const snippet = typeof row.snippet === "string" && row.snippet ? row.snippet : undefined
            const summary = typeof row.summary === "string" && !snippet ? row.summary : undefined
            return (
              <WikiPageHitRow
                key={pageKey || index}
                pageKey={pageKey}
                title={typeof row.title === "string" ? row.title : pageKey}
                summary={snippet ?? summary}
                kindLabel={WIKI_KIND_LABELS[kind] ?? kind}
              />
            )
          })}
        </div>
      </ToolStatusCard>
    )
  },
})
