"use client"

import * as React from "react"
import { useNavigate, useParams } from "react-router-dom"

import { SiteGraphExplorer, type SiteGraphPresentation } from "@/components/site-graph/SiteGraphExplorer"
import {
  buildWikiGraphPayload,
  wikiGraphRoutePageKey,
} from "@/features/pages/knowledge/knowledge-wiki-graph"
import { publicWikiApi, type PublicWikiGraphResponse, type SiteGraphPayload } from "@/lib/api"
import { usePublicPageMeta } from "@/features/pages/public-page-meta"
import {
  PublicWikiBreadcrumbs,
  PublicWikiLayout,
  PublicWikiStatus,
  resolvePublicWikiError,
} from "./PublicWikiLayout"

const publicWikiGraphPresentation: Partial<SiteGraphPresentation> = {
  kindLabels: {
    root: "知识库",
    section: "分类",
    article: "来源摘要",
    concept: "概念",
    entity: "实体",
    tag: "其他页面",
  },
  legendKinds: ["section", "concept", "entity", "article", "tag"],
  searchPlaceholder: "搜索公开知识页 / 属性",
  hint: "滚轮缩放 · 拖拽平移 · 拖动节点 · 单击查看详情 · 双击打开知识页",
  openLabel: "打开知识页",
  loadingText: "正在加载公开 Wiki 图谱…",
  errorText: "图谱渲染失败，请刷新页面重试",
}

function formatDate(value: string | null) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString()
}

export function PublicWikiGraphPage() {
  const { knowledgeBaseId = "" } = useParams()
  const navigate = useNavigate()
  const [graph, setGraph] = React.useState<PublicWikiGraphResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  usePublicPageMeta(
    `${graph?.knowledgeBaseName || "公开 Wiki"} · 关系图谱 · Petrichor`,
    "交互探索公开知识页之间经过安全过滤的语义关系。",
    `/wiki/${encodeURIComponent(knowledgeBaseId)}/graph`,
  )

  const load = React.useCallback(async () => {
    if (!knowledgeBaseId) return
    setLoading(true)
    setError(null)
    try {
      const response = await publicWikiApi.graph(knowledgeBaseId)
      setGraph(response.data)
    } catch (loadError) {
      setGraph(null)
      setError(resolvePublicWikiError(loadError, "公开 Wiki 图谱加载失败"))
    } finally {
      setLoading(false)
    }
  }, [knowledgeBaseId])

  React.useEffect(() => { void load() }, [load])

  const payload = React.useMemo<SiteGraphPayload | null>(() => {
    if (!graph) return null
    return buildWikiGraphPayload(graph)
  }, [graph])

  const presentation = React.useMemo<Partial<SiteGraphPresentation>>(() => ({
    ...publicWikiGraphPresentation,
    stats: [
      { label: "知识页", value: graph?.stats.pageCount ?? 0 },
      { label: "关系", value: graph?.stats.linkCount ?? 0 },
      { label: "概念", value: graph?.stats.conceptCount ?? 0 },
      { label: "实体", value: graph?.stats.entityCount ?? 0 },
    ],
  }), [graph])

  const handleNavigate = React.useCallback((route: string) => {
    const targetPageKey = wikiGraphRoutePageKey(route)
    if (!targetPageKey) return
    navigate(`/wiki/${knowledgeBaseId}/${encodeURIComponent(targetPageKey)}`)
  }, [knowledgeBaseId, navigate])

  const generatedAt = formatDate(graph?.generatedAt ?? null)

  let content: React.ReactNode
  if (loading) {
    content = <p className="py-20 text-center text-sm opacity-75">正在加载公开 Wiki 图谱…</p>
  } else if (error) {
    content = (
      <PublicWikiStatus
        title="图谱加载失败"
        detail={error}
        action={<button className="retypeset-highlight-hover text-sm font-semibold" onClick={() => void load()}>重新加载</button>}
      />
    )
  } else if (!payload || !graph || graph.nodes.length === 0) {
    content = <PublicWikiStatus title="还没有可展示的公开关系" />
  } else {
    content = (
      <div className="-mx-4 flex h-[calc(100dvh-12rem)] min-h-[28rem] flex-col text-foreground sm:mx-0 sm:h-[78vh] sm:min-h-[32rem]">
        <SiteGraphExplorer payload={payload} presentation={presentation} onNavigate={handleNavigate} />
      </div>
    )
  }

  return (
    <PublicWikiLayout wide>
      <PublicWikiBreadcrumbs items={[
        { label: "首页", href: "/" },
        { label: "Wiki", href: "/wiki" },
        { label: graph?.knowledgeBaseName || "知识库", href: `/wiki/${knowledgeBaseId}` },
        { label: "关系图谱" },
      ]} />
      <header className="mb-6">
        <div className="retypeset-decorative-line" aria-hidden="true" />
        <h1 className="retypeset-font-title text-2xl font-bold">
          {graph?.knowledgeBaseName ? `${graph.knowledgeBaseName} · 关系图谱` : "公开 Wiki 关系图谱"}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-7 opacity-75">
          图中只包含全部来源文章均处于匿名公开状态的 Wiki 页面；单击查看关系，双击进入知识页。
        </p>
        {generatedAt ? <p className="mt-1 text-xs opacity-55">更新于 {generatedAt}</p> : null}
        {graph?.truncated ? (
          <p className="mt-2 border-l-2 border-current/30 pl-3 text-xs leading-5 opacity-65">
            当前优先展示连接度较高的 {graph.nodes.length} 个知识页；公开范围内共 {graph.totalPageCount} 个。
          </p>
        ) : null}
      </header>
      {content}
    </PublicWikiLayout>
  )
}
