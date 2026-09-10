"use client"

import * as React from "react"
import { Search } from "@/components/iconimate"
import { Link, useSearchParams } from "react-router-dom"

import { publicWikiApi, type PublicWikiPageListResponse } from "@/lib/api"
import { usePublicPageMeta } from "@/features/pages/public-page-meta"
import {
  PublicWikiStatus,
  resolvePublicWikiError,
} from "./PublicWikiLayout"
import { PublicWikiLoading } from "./PublicWikiLoading"

const PAGE_SIZE = 30
const wikiKinds = [
  ["all", "全部"],
  ["concept", "概念"],
  ["entity", "实体"],
  ["source", "来源摘要"],
  ["comparison", "对比"],
  ["answer", "答案"],
] as const

const wikiKindLabel: Record<string, string> = Object.fromEntries(wikiKinds)

function parsePage(value: string | null) {
  const page = Number(value)
  return Number.isInteger(page) && page > 0 ? page : 1
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

export function PublicWikiIndexPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const query = searchParams.get("q")?.trim() ?? ""
  const requestedKind = searchParams.get("kind") || "all"
  const kind = wikiKinds.some(([value]) => value === requestedKind) ? requestedKind : "all"
  const page = parsePage(searchParams.get("page"))
  const [queryInput, setQueryInput] = React.useState(query)
  const [data, setData] = React.useState<PublicWikiPageListResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  usePublicPageMeta(
    "Wiki · Petrichor",
    "从公开文章出发，探索相互连接的概念、实体与知识。",
    "/wiki",
  )

  React.useEffect(() => setQueryInput(query), [query])

  const load = React.useCallback(async (isCanceled: () => boolean = () => false) => {
    setLoading(true)
    setError(null)
    try {
      const response = await publicWikiApi.pages({
        q: query || undefined,
        kind,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      })
      if (!isCanceled()) setData(response.data)
    } catch (loadError) {
      if (!isCanceled()) {
        setData(null)
        setError(resolvePublicWikiError(loadError, "Wiki 页面加载失败"))
      }
    } finally {
      if (!isCanceled()) setLoading(false)
    }
  }, [kind, page, query])

  React.useEffect(() => {
    let canceled = false
    void load(() => canceled)
    return () => { canceled = true }
  }, [load])

  const updateFilters = (values: { q?: string; kind?: string; page?: number }) => {
    const next = new URLSearchParams(searchParams)
    const nextQuery = values.q ?? query
    const nextKind = values.kind ?? kind
    const nextPage = values.page ?? 1
    if (nextQuery) next.set("q", nextQuery)
    else next.delete("q")
    if (nextKind && nextKind !== "all") next.set("kind", nextKind)
    else next.delete("kind")
    if (nextPage > 1) next.set("page", String(nextPage))
    else next.delete("page")
    setSearchParams(next)
  }

  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    updateFilters({ q: queryInput.trim(), page: 1 })
  }

  const pageCount = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1

  let content: React.ReactNode
  if (loading) {
    content = <PublicWikiLoading />
  } else if (error) {
    content = (
      <PublicWikiStatus
        title="Wiki 页面加载失败"
        detail={error}
        action={<button className="retypeset-highlight-hover text-sm font-semibold" onClick={() => void load()}>重新加载</button>}
      />
    )
  } else if (!data || data.items.length === 0) {
    content = (
      <PublicWikiStatus
        title={query || kind !== "all" ? "没有匹配的公开知识页" : "还没有公开的知识页"}
        detail={query || kind !== "all" ? "尝试缩短关键字或切换页面类型。" : "公开文章完成知识构建后，相关页面会出现在这里。"}
      />
    )
  } else {
    content = (
      <>
        <ul className="divide-y divide-current/15 border-y border-current/15">
          {data.items.map((item) => (
            <li key={item.href} className="py-6">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="retypeset-font-navbar retypeset-c-primary font-semibold">
                  {wikiKindLabel[item.kind] || item.kind}
                </span>
                {item.categoryPath.length > 0 ? (
                  <span className="opacity-55">{item.categoryPath.join(" / ")}</span>
                ) : null}
              </div>
              <h2 className="retypeset-post-heading mt-2 text-lg font-semibold">
                <Link className="retypeset-highlight-hover" to={item.href}>{item.title}</Link>
              </h2>
              <p className="mt-2 line-clamp-3 text-sm leading-6 opacity-75">{item.summary}</p>
              <div className="retypeset-font-time mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs opacity-60">
                <span>{item.sourceCount} 条来源引用</span>
                <time dateTime={item.updatedAt}>{formatDate(item.updatedAt)}</time>
                {item.aliases.length > 0 ? <span>别名：{item.aliases.slice(0, 3).join("、")}</span> : null}
              </div>
            </li>
          ))}
        </ul>
        {pageCount > 1 ? (
          <nav aria-label="Wiki 分页" className="retypeset-font-navbar mt-7 flex items-center justify-between text-sm">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => updateFilters({ page: page - 1 })}
              className="retypeset-highlight-hover disabled:cursor-not-allowed disabled:opacity-35"
            >
              上一页
            </button>
            <span className="opacity-65">第 {page} / {pageCount} 页 · 共 {data.total} 个知识页</span>
            <button
              type="button"
              disabled={!data.hasMore}
              onClick={() => updateFilters({ page: page + 1 })}
              className="retypeset-highlight-hover disabled:cursor-not-allowed disabled:opacity-35"
            >
              下一页
            </button>
          </nav>
        ) : null}
      </>
    )
  }

  return (
    <>
      <div className="mb-8 space-y-4">
        <form role="search" onSubmit={submitSearch} className="flex items-center gap-3 border-y border-current/20 py-3">
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <input
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            aria-label="搜索公开 Wiki"
            maxLength={100}
            placeholder="搜索概念、实体、来源摘要…"
            className="min-w-0 flex-1 bg-transparent text-sm text-current outline-none focus-visible:ring-1 focus-visible:ring-current/40 placeholder:text-current/45"
          />
          <button className="retypeset-highlight-hover retypeset-font-navbar text-xs font-semibold" type="submit">搜索</button>
        </form>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2" role="group" aria-label="页面类型筛选">
          {wikiKinds.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={kind === value}
              onClick={() => updateFilters({ kind: value, page: 1 })}
              className={`retypeset-font-navbar py-1 text-xs transition-colors ${
                kind === value ? "retypeset-highlight-static retypeset-c-primary font-semibold" : "retypeset-highlight-hover opacity-65 hover:opacity-100"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div aria-live="polite" aria-busy={loading}>{content}</div>
    </>
  )
}
