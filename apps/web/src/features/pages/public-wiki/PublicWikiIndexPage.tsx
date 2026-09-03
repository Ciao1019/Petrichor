"use client"

import * as React from "react"
import { ArrowRight, BookOpen, Network } from "@/components/iconimate"
import { Link } from "react-router-dom"

import { publicWikiApi, type PublicWikiKnowledgeBase } from "@/lib/api"
import { usePublicPageMeta } from "@/features/pages/public-page-meta"
import {
  PublicWikiBreadcrumbs,
  PublicWikiLayout,
  PublicWikiStatus,
  resolvePublicWikiError,
} from "./PublicWikiLayout"

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

export function PublicWikiIndexPage() {
  const [items, setItems] = React.useState<PublicWikiKnowledgeBase[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  usePublicPageMeta("公开 Wiki · Petrichor", "浏览由公开文章构建的语义 Wiki 与知识关系。", "/wiki")

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await publicWikiApi.knowledgeBases()
      setItems(response.data.items ?? [])
    } catch (loadError) {
      setItems([])
      setError(resolvePublicWikiError(loadError, "公开 Wiki 加载失败"))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  let content: React.ReactNode
  if (loading) {
    content = (
      <div className="grid gap-4 sm:grid-cols-2" role="status" aria-label="公开 Wiki 加载中">
        {[0, 1, 2].map((item) => (
          <div key={item} className="border border-current/15 p-5">
            <div className="skeleton-bar h-5 w-2/3" />
            <div className="skeleton-bar mt-4 h-3.5 w-full" />
            <div className="skeleton-bar mt-2 h-3.5 w-4/5" />
          </div>
        ))}
      </div>
    )
  } else if (error) {
    content = (
      <PublicWikiStatus
        title="公开 Wiki 加载失败"
        detail={error}
        action={(
          <button className="retypeset-highlight-hover retypeset-font-navbar text-sm font-semibold" onClick={() => void load()}>
            重新加载
          </button>
        )}
      />
    )
  } else if (items.length === 0) {
    content = <PublicWikiStatus title="还没有可公开浏览的 Wiki" detail="当公开文章完成知识构建后，相关页面会出现在这里。" />
  } else {
    content = (
      <ul className="grid gap-4 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.knowledgeBaseId}>
            <Link
              to={`/wiki/${item.knowledgeBaseId}`}
              className="group flex h-full flex-col border border-current/15 p-5 transition-colors hover:border-current/40 hover:bg-white/5"
            >
              <div className="flex items-start justify-between gap-4">
                <BookOpen className="size-5 shrink-0 retypeset-c-primary" aria-hidden="true" />
                <ArrowRight className="size-4 opacity-45 transition-transform group-hover:translate-x-1 group-hover:opacity-100" aria-hidden="true" />
              </div>
              <h2 className="retypeset-font-title mt-5 break-words text-xl font-bold">{item.name}</h2>
              <p className="mt-2 line-clamp-3 text-sm leading-6 opacity-70">
                {item.description || "浏览这个知识库中由公开文章构建的概念、实体与来源摘要。"}
              </p>
              <div className="retypeset-font-navbar mt-5 flex flex-wrap gap-x-4 gap-y-1 text-xs opacity-65">
                <span>{item.pageCount} 个知识页</span>
                <span>{item.articleCount} 篇来源文章</span>
                <span>更新于 {formatDate(item.updatedAt)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <PublicWikiLayout>
      <PublicWikiBreadcrumbs items={[{ label: "首页", href: "/" }, { label: "Wiki" }]} />
      <header className="mb-9">
        <div className="retypeset-decorative-line" aria-hidden="true" />
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <p className="retypeset-font-navbar retypeset-c-primary text-xs font-bold uppercase tracking-[0.18em]">Semantic Wiki</p>
            <h1 className="retypeset-font-title mt-3 text-3xl font-bold">公开 Wiki</h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 opacity-75">
              这里不是另一份文章目录，而是从公开内容中抽取并相互连接的知识页面。
            </p>
          </div>
          <Link to="/graph" className="retypeset-font-navbar inline-flex items-center gap-2 border border-current/20 px-3 py-2 text-xs font-semibold hover:bg-white/5">
            <Network className="size-4" aria-hidden="true" />
            全站关系图
          </Link>
        </div>
      </header>
      {content}
    </PublicWikiLayout>
  )
}
