"use client"

import * as React from "react"
import { Loader2, Network } from "@/components/iconimate"

import { SiteGraphExplorer, type SiteGraphPresentation } from "@/components/site-graph/SiteGraphExplorer"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { knowledgeBaseWikiAgentApi, type KnowledgeBaseWikiGraphResponse } from "@/lib/api"
import {
  buildWikiGraphPayload,
  wikiGraphRoutePageKey,
} from "@/features/pages/knowledge/knowledge-wiki-graph"

/** 文案随知识库语境替换，交互与配色沿用全站星图那套点群 */
const WIKI_GRAPH_PRESENTATION: Partial<SiteGraphPresentation> = {
  kindLabels: {
    root: "知识库",
    section: "分类",
    article: "文章摘要",
    concept: "概念",
    entity: "实体",
    tag: "其他页面",
  },
  legendKinds: ["section", "concept", "entity", "article", "tag"],
  searchPlaceholder: "搜索知识页 / 属性",
  hint: "滚轮缩放 · 拖拽平移 · 拖动节点 · 单击查看详情 · 双击打开知识页",
  openLabel: "打开知识页",
  loadingText: "正在加载 Wiki 图谱…",
  errorText: "图谱渲染失败，请刷新页面重试",
}

function resolveApiErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "object" && error && "response" in error) {
    const response = (error as { response?: { data?: { msg?: unknown } } }).response
    if (typeof response?.data?.msg === "string" && response.data.msg) return response.data.msg
  }
  return error instanceof Error && error.message ? error.message : fallback
}

function formatGeneratedAt(value: string | null) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString()
}

export interface KnowledgeWikiGraphPanelProps {
  knowledgeBaseId: string
  /** 双击节点或点「打开知识页」时把 pageKey 交回页面，由页面切到知识空间定位 */
  onOpenPage: (pageKey: string) => void
}

/**
 * 知识库的 Wiki 图谱：Wiki 页面为节点、页面出链为关系边，
 * 直接复用 `/graph` 全站星图的点群运行时与交互外壳，只换掉文案。
 */
export function KnowledgeWikiGraphPanel({ knowledgeBaseId, onOpenPage }: KnowledgeWikiGraphPanelProps) {
  const [graph, setGraph] = React.useState<KnowledgeBaseWikiGraphResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const fetchGraph = React.useCallback(async (isCanceled: () => boolean = () => false) => {
    setLoading(true)
    setError(null)
    try {
      const response = await knowledgeBaseWikiAgentApi.graph(knowledgeBaseId)
      if (isCanceled()) return
      setGraph(response.data)
    } catch (e: unknown) {
      if (isCanceled()) return
      setGraph(null)
      setError(resolveApiErrorMessage(e, "Wiki 图谱加载失败"))
    } finally {
      if (!isCanceled()) setLoading(false)
    }
  }, [knowledgeBaseId])

  React.useEffect(() => {
    let canceled = false
    void fetchGraph(() => canceled)
    return () => {
      canceled = true
    }
  }, [fetchGraph])

  const payload = React.useMemo(() => (graph ? buildWikiGraphPayload(graph) : null), [graph])

  const presentation = React.useMemo<Partial<SiteGraphPresentation>>(() => ({
    ...WIKI_GRAPH_PRESENTATION,
    stats: [
      { label: "知识页", value: graph?.stats.pageCount ?? 0 },
      { label: "关系", value: graph?.stats.linkCount ?? 0 },
      { label: "概念", value: graph?.stats.conceptCount ?? 0 },
      { label: "实体", value: graph?.stats.entityCount ?? 0 },
    ],
  }), [graph])

  const handleNavigate = React.useCallback((route: string) => {
    const pageKey = wikiGraphRoutePageKey(route)
    if (pageKey) onOpenPage(pageKey)
  }, [onOpenPage])

  const generatedAt = formatGeneratedAt(graph?.generatedAt ?? null)

  if (loading) {
    return (
      <div className="flex min-h-[24rem] items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        正在加载 Wiki 图谱…
      </div>
    )
  }

  if (error) {
    return (
      <Empty className="border border-dashed py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Network />
          </EmptyMedia>
          <EmptyTitle>图谱加载失败</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" variant="outline" onClick={() => void fetchGraph()}>
            重新加载
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  if (!payload || !graph || graph.nodes.length === 0) {
    return (
      <Empty className="border border-dashed py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Network />
          </EmptyMedia>
          <EmptyTitle>还没有可成图的知识</EmptyTitle>
          <EmptyDescription>
            在文档视图里对文章执行「构建知识」，抽取出的概念与实体会连成这张图谱。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {generatedAt ? (
        <p className="text-xs text-muted-foreground">知识更新于 {generatedAt}</p>
      ) : null}
      {/* 必须给定高度而不是 min-height：点群舞台是绝对定位的，自身不产生高度，
          容器高度靠这里一次性定死，避免又退回到靠内容撑开。
          19rem 扣的是面包屑 + 返回按钮 + 标签栏 + 页面内边距，让图例、提示条和详情卡
          落在首屏内，不必滚动页面才能看全画布。 */}
      <div className="flex h-[calc(100vh-19rem)] min-h-[28rem] flex-col">
        <SiteGraphExplorer
          payload={payload}
          presentation={presentation}
          onNavigate={handleNavigate}
        />
      </div>
    </div>
  )
}
