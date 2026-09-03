"use client"

import * as React from "react"
import { ArrowRight, BookOpen, Network } from "@/components/iconimate"
import { Link, useParams } from "react-router-dom"

import { PlateMarkdownPreview } from "@/components/plate/PlateMarkdownPreview"
import { preparePublicWikiMarkdown } from "@/features/pages/knowledge/knowledge-wiki-markdown"
import { publicWikiApi, type PublicWikiNeighborPage, type PublicWikiPageDetail } from "@/lib/api"
import { usePublicPageMeta } from "@/features/pages/public-page-meta"
import {
  PublicWikiBreadcrumbs,
  PublicWikiLayout,
  PublicWikiStatus,
  resolvePublicWikiError,
} from "./PublicWikiLayout"

const kindLabels: Record<string, string> = {
  source: "来源摘要",
  concept: "概念",
  entity: "实体",
  comparison: "对比",
  answer: "答案",
}

function RelationList({ title, items }: { title: string; items: PublicWikiNeighborPage[] }) {
  if (items.length === 0) return null
  return (
    <section className="mt-9" aria-labelledby={`relation-${title}`}>
      <h2 id={`relation-${title}`} className="retypeset-font-navbar text-sm font-bold">{title}</h2>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
        {items.map((item) => (
          <li key={`${item.pageKey}-${item.linkType}`}>
            <Link to={item.href || `#wiki-page=${encodeURIComponent(item.pageKey)}`} className="group flex h-full flex-col border border-current/15 p-4 hover:border-current/35 hover:bg-white/5">
              <span className="flex items-center justify-between gap-3">
                <span className="retypeset-c-primary text-xs font-semibold">{item.linkType || "相关"}</span>
                <ArrowRight className="size-3.5 opacity-45 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </span>
              <strong className="mt-2 break-words text-sm">{item.title}</strong>
              {item.summary ? <span className="mt-1 line-clamp-2 text-xs leading-5 opacity-65">{item.summary}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function WikiDetailContent({ detail }: { detail: PublicWikiPageDetail }) {
  const markdown = React.useMemo(() => {
    const targets = [...detail.links, ...detail.inLinks]
      .filter((item, index, values) => values.findIndex((candidate) => candidate.pageKey === item.pageKey) === index)
      .map((item) => ({ pageKey: item.pageKey, title: item.title }))
    return preparePublicWikiMarkdown(detail.contentMd, detail.title, detail.knowledgeBaseId, targets)
  }, [detail])

  return (
    <>
      <header className="mb-8">
        <div className="retypeset-decorative-line" aria-hidden="true" />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="retypeset-font-navbar retypeset-c-primary font-bold">{kindLabels[detail.kind] || detail.kind}</span>
          {detail.categoryPath.length > 0 ? <span className="opacity-55">{detail.categoryPath.join(" / ")}</span> : null}
        </div>
        <h1 className="retypeset-font-title mt-3 break-words text-3xl font-bold sm:text-4xl">{detail.title}</h1>
        {detail.summary ? <p className="mt-4 text-sm leading-7 opacity-75">{detail.summary}</p> : null}
        {detail.aliases.length > 0 ? (
          <p className="retypeset-font-navbar mt-3 text-xs opacity-55">别名：{detail.aliases.join("、")}</p>
        ) : null}
      </header>

      <article className="public-article public-article--retypeset min-w-0 border-y border-current/15 py-8">
        <PlateMarkdownPreview
          markdown={markdown}
          publicMediaAccess
          publicMediaAccessToken={detail.mediaAccessToken}
        />
      </article>

      <RelationList title="关联知识" items={detail.links} />
      <RelationList title="引用此页" items={detail.inLinks} />

      {detail.sourceArticles.length > 0 ? (
        <section className="mt-9" aria-labelledby="wiki-source-articles">
          <h2 id="wiki-source-articles" className="retypeset-font-navbar flex items-center gap-2 text-sm font-bold">
            <BookOpen className="size-4" aria-hidden="true" />
            来源文章
          </h2>
          <ul className="mt-3 divide-y divide-current/15 border-y border-current/15">
            {detail.sourceArticles.map((source) => (
              <li key={source.articleId} className="py-3">
                <Link className="retypeset-highlight-hover text-sm font-semibold" to={source.href}>{source.title}</Link>
                {source.note ? <p className="mt-1 text-xs leading-5 opacity-65">{source.note}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
}

export function PublicWikiPage() {
  const { knowledgeBaseId = "", pageKey = "" } = useParams()
  const [detail, setDetail] = React.useState<PublicWikiPageDetail | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  usePublicPageMeta(
    `${detail?.title || "知识页"} · ${detail?.knowledgeBaseName || "Petrichor Wiki"}`,
    detail?.summary || "阅读公开 Wiki 知识页、关联页面与来源文章。",
    `/wiki/${encodeURIComponent(knowledgeBaseId)}/${encodeURIComponent(pageKey)}`,
  )

  const load = React.useCallback(async () => {
    if (!knowledgeBaseId || !pageKey) return
    setLoading(true)
    setError(null)
    try {
      const response = await publicWikiApi.detail(pageKey, knowledgeBaseId)
      setDetail(response.data)
    } catch (loadError) {
      setDetail(null)
      setError(resolvePublicWikiError(loadError, "Wiki 页面加载失败"))
    } finally {
      setLoading(false)
    }
  }, [knowledgeBaseId, pageKey])

  React.useEffect(() => { void load() }, [load])

  const knowledgeBaseName = detail?.knowledgeBaseName || "知识库"
  return (
    <PublicWikiLayout>
      <PublicWikiBreadcrumbs items={[
        { label: "首页", href: "/" },
        { label: "Wiki", href: "/wiki" },
        { label: knowledgeBaseName, href: `/wiki/${knowledgeBaseId}` },
        { label: detail?.title || "知识页" },
      ]} />

      {loading ? (
        <div className="space-y-5 py-8" role="status" aria-label="Wiki 页面加载中">
          <div className="skeleton-bar h-8 w-2/3" />
          <div className="skeleton-bar h-4 w-full" />
          <div className="skeleton-bar h-4 w-5/6" />
          <div className="skeleton-bar mt-10 h-64 w-full" />
        </div>
      ) : error || !detail ? (
        <PublicWikiStatus
          title="无法打开这个 Wiki 页面"
          detail={error}
          action={(
            <div className="flex justify-center gap-4 text-sm">
              <Link className="retypeset-highlight-hover" to={`/wiki/${knowledgeBaseId}`}>返回知识库</Link>
              <button className="retypeset-highlight-hover font-semibold" onClick={() => void load()}>重试</button>
            </div>
          )}
        />
      ) : (
        <>
          <div className="mb-5 flex justify-end">
            <Link
              to={`/wiki/${knowledgeBaseId}/graph`}
              className="retypeset-font-navbar inline-flex items-center gap-2 border border-current/20 px-3 py-2 text-xs font-semibold hover:bg-white/5"
            >
              <Network className="size-4" aria-hidden="true" />
              在图谱中探索
            </Link>
          </div>
          <WikiDetailContent detail={detail} />
        </>
      )}
    </PublicWikiLayout>
  )
}
