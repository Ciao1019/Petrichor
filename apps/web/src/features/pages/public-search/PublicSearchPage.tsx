"use client"

import * as React from "react"
import { BookOpen, FileText, Search } from "@/components/iconimate"
import { Link, useSearchParams } from "react-router-dom"

import {
  PublicWikiBreadcrumbs,
  PublicWikiLayout,
  PublicWikiStatus,
  resolvePublicWikiError,
} from "@/features/pages/public-wiki/PublicWikiLayout"
import { usePublicPageMeta } from "@/features/pages/public-page-meta"
import {
  publicSearchApi,
  publicWikiApi,
  type PublicSearchMode,
  type PublicSearchResponse,
  type PublicSearchType,
  type PublicWikiKnowledgeBase,
} from "@/lib/api"

const PAGE_SIZE = 20
const modes: Array<[PublicSearchMode, string, string]> = [
  ["hybrid", "混合", "融合全文匹配与语义相关性"],
  ["fulltext", "全文", "按标题、摘要与正文中的关键字检索"],
  ["semantic", "语义", "查找含义相关但用词不同的内容"],
]
const resultTypes: Array<[PublicSearchType, string]> = [
  ["all", "全部"],
  ["article", "文章"],
  ["wiki", "Wiki"],
]

function validMode(value: string | null): PublicSearchMode {
  return value === "fulltext" || value === "semantic" || value === "hybrid" ? value : "hybrid"
}

function validType(value: string | null): PublicSearchType {
  return value === "article" || value === "wiki" || value === "all" ? value : "all"
}

function validPage(value: string | null) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

export function PublicSearchPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const query = searchParams.get("q")?.trim() ?? ""
  const mode = validMode(searchParams.get("mode"))
  const resultType = validType(searchParams.get("type"))
  const knowledgeBaseId = searchParams.get("kb")?.trim() ?? ""
  const tag = searchParams.get("tag")?.trim() ?? ""
  const page = validPage(searchParams.get("page"))
  const [input, setInput] = React.useState(query)
  const [tagInput, setTagInput] = React.useState(tag)
  const [knowledgeBases, setKnowledgeBases] = React.useState<PublicWikiKnowledgeBase[]>([])
  const [data, setData] = React.useState<PublicSearchResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  usePublicPageMeta(
    query ? `${query}的搜索结果 · Petrichor` : "搜索公开知识 · Petrichor",
    "统一检索已公开文章与安全公开 Wiki，支持全文、语义和混合模式。",
    query ? `/search?q=${encodeURIComponent(query)}` : "/search",
  )

  React.useEffect(() => setInput(query), [query])
  React.useEffect(() => setTagInput(tag), [tag])

  React.useEffect(() => {
    const controller = new AbortController()
    publicWikiApi.knowledgeBases(controller.signal)
      .then((response) => setKnowledgeBases(response.data.items))
      .catch(() => {
        if (!controller.signal.aborted) setKnowledgeBases([])
      })
    return () => controller.abort()
  }, [])

  React.useEffect(() => {
    if (!query) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    publicSearchApi.search({
      q: query,
      mode,
      type: resultType,
      kb: knowledgeBaseId || undefined,
      tag: tag || undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      signal: controller.signal,
    }).then((response) => {
      setData(response.data)
    }).catch((searchError: unknown) => {
      if (controller.signal.aborted) return
      setData(null)
      setError(resolvePublicWikiError(searchError, "公开知识搜索失败"))
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [knowledgeBaseId, mode, page, query, resultType, tag])

  const updateSearch = (changes: {
    q?: string
    mode?: PublicSearchMode
    type?: PublicSearchType
    kb?: string
    tag?: string
    page?: number
  }) => {
    const next = new URLSearchParams(searchParams)
    const nextQuery = changes.q ?? query
    const nextMode = changes.mode ?? mode
    const nextType = changes.type ?? resultType
    const nextKnowledgeBaseId = changes.kb ?? knowledgeBaseId
    const nextTag = changes.tag ?? tag
    const nextPage = changes.page ?? 1
    if (nextQuery) next.set("q", nextQuery)
    else next.delete("q")
    if (nextMode !== "hybrid") next.set("mode", nextMode)
    else next.delete("mode")
    if (nextType !== "all") next.set("type", nextType)
    else next.delete("type")
    if (nextKnowledgeBaseId) next.set("kb", nextKnowledgeBaseId)
    else next.delete("kb")
    if (nextTag) next.set("tag", nextTag)
    else next.delete("tag")
    if (nextPage > 1) next.set("page", String(nextPage))
    else next.delete("page")
    setSearchParams(next)
  }

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    updateSearch({ q: input.trim(), tag: tagInput.trim(), page: 1 })
  }

  let results: React.ReactNode
  if (!query) {
    results = (
      <PublicWikiStatus
        title="输入关键字开始探索"
        detail="搜索范围包括匿名公开文章和全部来源均已公开的 Wiki 页面。"
      />
    )
  } else if (loading && !data) {
    results = (
      <div className="space-y-7 py-5" role="status" aria-label="搜索中">
        {[0, 1, 2, 3].map((item) => (
          <div key={item}>
            <div className="skeleton-bar h-5 w-3/5" />
            <div className="skeleton-bar mt-3 h-3.5 w-full" />
            <div className="skeleton-bar mt-2 h-3.5 w-4/5" />
          </div>
        ))}
      </div>
    )
  } else if (error) {
    results = <PublicWikiStatus title="搜索失败" detail={error} />
  } else if (!data || data.items.length === 0) {
    results = (
      <PublicWikiStatus
        title={mode === "semantic" && data && !data.semanticAvailable ? "语义搜索暂时不可用" : "没有匹配的公开知识"}
        detail={data?.semanticMessage || "尝试更短的关键字、其他用词或切换搜索方式。"}
      />
    )
  } else {
    results = (
      <>
        {data.semanticMessage ? (
          <p className="mb-4 border-l-2 border-current/35 pl-3 text-xs leading-5 opacity-65">{data.semanticMessage}</p>
        ) : null}
        <p className="retypeset-font-navbar mb-3 text-xs opacity-60">
          当前候选中共 {data.total} 条相关结果 · {data.tookMs} ms
          {data.modeApplied !== mode ? " · 已降级为全文检索" : ""}
        </p>
        <ul className="divide-y divide-current/15 border-y border-current/15">
          {data.items.map((item) => {
            const Icon = item.type === "article" ? FileText : BookOpen
            return (
              <li key={item.id} className="py-6">
                <div className="flex items-center gap-2 text-xs opacity-65">
                  <Icon className="size-3.5" aria-hidden="true" />
                  <span>{item.type === "article" ? "公开文章" : "Wiki"}</span>
                  {item.kind ? <span>· {item.kind}</span> : null}
                  {item.knowledgeBaseName ? <span>· {item.knowledgeBaseName}</span> : null}
                  {item.categoryPath.length > 0 ? <span>· {item.categoryPath.join(" / ")}</span> : null}
                </div>
                <h2 className="retypeset-post-heading mt-2 text-lg font-semibold">
                  <Link to={item.href}>{item.title}</Link>
                </h2>
                <p className="mt-2 text-sm leading-6 opacity-80">{item.snippet || item.summary}</p>
                <div className="retypeset-font-time mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs opacity-55">
                  <span>{item.matchReason}</span>
                  {item.tags.length > 0 ? <span>{item.tags.join(" · ")}</span> : null}
                  {item.sourceCount != null ? <span>{item.sourceCount} 条公开来源</span> : null}
                  <time dateTime={item.updatedAt}>{formatDate(item.updatedAt)}</time>
                </div>
              </li>
            )
          })}
        </ul>
        <nav aria-label="搜索结果分页" className="retypeset-font-navbar mt-7 flex items-center justify-between text-sm">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => updateSearch({ page: page - 1 })}
            className="retypeset-highlight-hover disabled:cursor-not-allowed disabled:opacity-35"
          >
            上一页
          </button>
          <span className="opacity-60">第 {page} 页</span>
          <button
            type="button"
            disabled={!data.hasMore}
            onClick={() => updateSearch({ page: page + 1 })}
            className="retypeset-highlight-hover disabled:cursor-not-allowed disabled:opacity-35"
          >
            下一页
          </button>
        </nav>
      </>
    )
  }

  return (
    <PublicWikiLayout activeSection="search">
      <PublicWikiBreadcrumbs items={[{ label: "首页", href: "/" }, { label: "搜索" }]} />
      <header className="mb-8">
        <div className="retypeset-decorative-line" aria-hidden="true" />
        <p className="retypeset-font-navbar retypeset-c-primary text-xs font-bold uppercase tracking-[0.18em]">Unified retrieval</p>
        <h1 className="retypeset-font-title mt-3 text-3xl font-bold">搜索公开知识</h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 opacity-75">一次检索公开文章与语义 Wiki，并按全文命中和语义相关性统一排序。</p>
      </header>

      <form role="search" onSubmit={submit} className="flex items-center gap-3 border-y border-current/20 py-3">
        <Search className="size-5 shrink-0" aria-hidden="true" />
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="搜索文章、Wiki、概念或实体…"
          className="min-w-0 flex-1 bg-transparent text-base text-current outline-none placeholder:text-current/45"
        />
        <button type="submit" disabled={!input.trim()} className="retypeset-highlight-hover retypeset-font-navbar text-sm font-semibold disabled:opacity-35">搜索</button>
      </form>

      <div className="mt-5 flex flex-col gap-4 border-b border-current/15 pb-5">
        <div className="flex flex-wrap gap-2" aria-label="搜索方式">
          {modes.map(([value, label, description]) => (
            <button
              key={value}
              type="button"
              title={description}
              aria-pressed={mode === value}
              onClick={() => updateSearch({ mode: value, page: 1 })}
              className={`retypeset-font-navbar border px-3 py-1.5 text-xs ${mode === value ? "border-current bg-white/10 font-semibold" : "border-current/15 opacity-60 hover:opacity-100"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2" aria-label="内容类型">
          {resultTypes.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={resultType === value}
              onClick={() => updateSearch({ type: value, page: 1 })}
              className={`retypeset-font-navbar px-2 py-1 text-xs ${resultType === value ? "retypeset-c-primary font-bold" : "opacity-55 hover:opacity-100"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3" aria-label="搜索筛选">
          <label className="retypeset-font-navbar flex items-center gap-2 text-xs">
            <span className="opacity-55">知识库</span>
            <select
              value={knowledgeBaseId}
              onChange={(event) => updateSearch({ kb: event.target.value, page: 1 })}
              className="border border-current/20 bg-transparent px-2 py-1.5 text-current outline-none"
            >
              <option value="" className="text-black">全部知识库</option>
              {knowledgeBases.map((knowledgeBase) => (
                <option key={knowledgeBase.knowledgeBaseId} value={knowledgeBase.knowledgeBaseId} className="text-black">
                  {knowledgeBase.name}
                </option>
              ))}
            </select>
          </label>
          <label className="retypeset-font-navbar flex items-center gap-2 text-xs">
            <span className="opacity-55">标签</span>
            <input
              value={tagInput}
              onChange={(event) => setTagInput(event.target.value)}
              onBlur={() => {
                if (tagInput.trim() !== tag) updateSearch({ tag: tagInput.trim(), page: 1 })
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return
                event.preventDefault()
                updateSearch({ tag: tagInput.trim(), page: 1 })
              }}
              placeholder="输入标签"
              className="w-32 border-b border-current/25 bg-transparent px-1 py-1 text-current outline-none placeholder:text-current/40"
            />
          </label>
          {knowledgeBaseId || tag ? (
            <button
              type="button"
              onClick={() => {
                setTagInput("")
                updateSearch({ kb: "", tag: "", page: 1 })
              }}
              className="retypeset-highlight-hover retypeset-font-navbar text-xs opacity-65"
            >
              清除筛选
            </button>
          ) : null}
        </div>
      </div>

      <section className="mt-8" aria-live="polite" aria-busy={loading}>{results}</section>
    </PublicWikiLayout>
  )
}
