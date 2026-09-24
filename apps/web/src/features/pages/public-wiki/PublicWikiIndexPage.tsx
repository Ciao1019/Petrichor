"use client"

import * as React from "react"
import {
  ArrowRight,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileStack,
  RefreshCw,
  Search,
  Sparkles,
  Tags,
  X,
} from "@/components/iconimate"
import { Link, useSearchParams } from "react-router-dom"
import { Token, type TokenColor } from "@astryxdesign/core/Token"
import { Stack } from "@astryxdesign/core/Layout"
import { Text } from "@astryxdesign/core/Text"

import { AstryxProvider } from "@/components/astryx/astryx-provider"
import { publicWikiApi, type PublicWikiPageListResponse } from "@/lib/api"
import { usePublicPageMeta } from "@/features/pages/public-page-meta"
import {
  PublicWikiStatus,
  resolvePublicWikiError,
} from "./PublicWikiLayout"
import { PublicWikiLoading } from "./PublicWikiLoading"
import { formatWikiDate, wikiKindConfig } from "./public-wiki-presentation"

const PAGE_SIZE = 30

type WikiKindItem = {
  key: string
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const wikiKinds: WikiKindItem[] = [
  { key: "all", label: "全部", icon: FileStack },
  { key: "concept", label: "概念", icon: Sparkles },
  { key: "entity", label: "实体", icon: Tags },
  { key: "source", label: "来源摘要", icon: BookOpen },
]

const KIND_TOKEN_COLORS: Record<string, TokenColor> = {
  concept: "purple",
  entity: "blue",
  source: "orange",
  comparison: "pink",
  answer: "green",
}

function resolveWikiTokenColor(kind?: string | null): TokenColor {
  if (!kind) return "cyan"
  return KIND_TOKEN_COLORS[kind] ?? "cyan"
}

function parsePage(value: string | null) {
  const page = Number(value)
  return Number.isInteger(page) && page > 0 ? page : 1
}

export function PublicWikiIndexPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const query = searchParams.get("q")?.trim() ?? ""
  const requestedKind = searchParams.get("kind") || "all"
  const kind = wikiKinds.some((item) => item.key === requestedKind) ? requestedKind : "all"
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

  const clearSearch = () => {
    setQueryInput("")
    updateFilters({ q: "", page: 1 })
  }

  const pageCount = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1

  let content: React.ReactNode
  if (loading) {
    content = <PublicWikiLoading />
  } else if (error) {
    content = (
      <PublicWikiStatus
        icon={<RefreshCw className="size-5 text-white/70" />}
        title="Wiki 页面加载失败"
        detail={error}
        action={
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/10 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-white/20"
            onClick={() => void load()}
          >
            <RefreshCw className="size-3.5" />
            重新加载
          </button>
        }
      />
    )
  } else if (!data || data.items.length === 0) {
    content = (
      <PublicWikiStatus
        icon={<BookOpen className="size-5 text-white/70" />}
        title={query || kind !== "all" ? "未找到相关的知识条目" : "还没有公开的知识页"}
        detail={query || kind !== "all" ? "尝试缩短关键字、检查拼写或切换页面类型。" : "公开文章完成知识构建后，自动沉淀的相关实体与概念会出现在这里。"}
        action={
          query || kind !== "all" ? (
            <button
              type="button"
              onClick={() => {
                setQueryInput("")
                updateFilters({ q: "", kind: "all", page: 1 })
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/10 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-white/20"
            >
              清空搜索与分类
            </button>
          ) : null
        }
      />
    )
  } else {
    content = (
      <div className="space-y-6">
        <ul className="grid gap-3.5">
          {data.items.map((item) => {
            const config = wikiKindConfig[item.kind]
            const KindIcon = config?.icon || Tags
            return (
              <li key={item.href}>
                <div
                  className="group relative flex min-w-0 flex-col rounded-xl bg-white/[0.02] p-5 transition-all duration-200 motion-safe:hover:-translate-y-0.5 hover:bg-white/[0.05] hover:shadow-xl hover:shadow-black/25"
                >
                  {/* 顶部类型徽标与路径 */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span
                        className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                          config?.badgeClass || "border-white/15 bg-white/10 text-white/80"
                        }`}
                      >
                        <KindIcon className="size-3 shrink-0" />
                        {config?.label || item.kind}
                      </span>
                      {item.categoryPath.length > 0 ? (
                        <span className="break-words text-white/45">
                          {item.categoryPath.join(" / ")}
                        </span>
                      ) : null}
                    </div>
                    <ArrowRight
                      className="size-4 shrink-0 text-white/30 transition-transform duration-200 motion-safe:group-hover:translate-x-1 motion-safe:group-hover:text-white"
                      aria-hidden="true"
                    />
                  </div>

                  {/* 标题 */}
                  <h2 className="mt-2.5 break-words text-base font-bold text-white/95 transition-colors group-hover:text-white sm:text-lg">
                    <Link
                      to={item.href}
                      className="after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-white/30"
                    >
                      {item.title}
                    </Link>
                  </h2>

                  {/* 摘要 */}
                  {item.summary ? (
                    <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-white/60">
                      {item.summary}
                    </p>
                  ) : null}

                  {/* 关联数据（Token 展示） */}
                  {((item.relatedPages && item.relatedPages.length > 0) ||
                    (item.sourceArticles && item.sourceArticles.length > 0)) ? (
                    <div
                      className="relative z-10 mt-3.5 border-t border-white/[0.06] pt-3"
                    >
                      <AstryxProvider>
                        <Stack direction="vertical" gap={3} width="100%">
                          {item.relatedPages && item.relatedPages.length > 0 ? (
                            <Stack direction="vertical" gap={2}>
                              <Text type="supporting" color="secondary">
                                关联知识
                              </Text>
                              <Stack direction="horizontal" gap={1} wrap="wrap">
                                {item.relatedPages.map((rel) => (
                                  <Link
                                    key={`${rel.pageKey}-${rel.linkType}`}
                                    to={rel.href || item.href}
                                    className="inline-flex max-w-full rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                                  >
                                    <Token
                                      label={rel.title}
                                      color={resolveWikiTokenColor(rel.kind)}
                                      size="sm"
                                    />
                                  </Link>
                                ))}
                              </Stack>
                            </Stack>
                          ) : null}

                          {item.sourceArticles && item.sourceArticles.length > 0 ? (
                            <Stack direction="vertical" gap={2}>
                              <Text type="supporting" color="secondary">
                                来源文档
                              </Text>
                              <Stack direction="horizontal" gap={1} wrap="wrap">
                                {item.sourceArticles.map((src) => (
                                  <Link
                                    key={src.articleId}
                                    to={src.href}
                                    className="inline-flex max-w-full rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                                  >
                                    <Token label={src.title} color="teal" size="sm" />
                                  </Link>
                                ))}
                              </Stack>
                            </Stack>
                          ) : null}
                        </Stack>
                      </AstryxProvider>
                    </div>
                  ) : null}

                  {/* 元数据底部栏 */}
                  <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-1 text-xs text-white/45">
                    <span className="inline-flex items-center gap-1.5">
                      <BookOpen className="size-3.5 opacity-65" />
                      {item.sourceCount} 条来源引用
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Clock className="size-3.5 opacity-65" />
                      <time dateTime={item.updatedAt}>{formatWikiDate(item.updatedAt)}</time>
                    </span>
                    {item.aliases.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-white/35">别名:</span>
                        {item.aliases.slice(0, 3).map((alias) => (
                          <span
                            key={alias}
                            className="rounded bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-white/55"
                          >
                            {alias}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>

        {/* 分页控制栏 */}
        {pageCount > 1 ? (
          <nav
            aria-label="Wiki 分页"
            className="flex items-center justify-between rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3 text-xs sm:text-sm"
          >
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => updateFilters({ page: page - 1 })}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 font-medium text-white/80 transition-colors hover:bg-white/15 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
              上一页
            </button>
            <span className="text-white/50">
              第 <strong className="text-white/85">{page}</strong> / {pageCount} 页
              <span className="hidden sm:inline"> · 共 {data.total} 个条目</span>
            </span>
            <button
              type="button"
              disabled={!data.hasMore}
              onClick={() => updateFilters({ page: page + 1 })}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 font-medium text-white/80 transition-colors hover:bg-white/15 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            >
              下一页
              <ChevronRight className="size-4" />
            </button>
          </nav>
        ) : null}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 搜索与分类控制区 */}
      <div className="space-y-3.5">
        <form
          role="search"
          onSubmit={submitSearch}
          className="wiki-search group relative flex items-center rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5 transition-all duration-200 hover:border-white/20 focus-within:border-white/35 focus-within:bg-white/[0.06] focus-within:ring-2 focus-within:ring-white/15 focus-within:shadow-lg focus-within:shadow-black/20"
        >
          <Search className="size-4 shrink-0 text-white/40 transition-colors group-focus-within:text-white/80" aria-hidden="true" />
          <input
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            aria-label="搜索公开 Wiki"
            maxLength={100}
            placeholder="搜索概念、实体、来源摘要…"
            className="min-w-0 flex-1 border-none bg-transparent px-3 text-sm text-white placeholder:text-white/35 outline-none"
          />
          {queryInput ? (
            <button
              type="button"
              onClick={clearSearch}
              aria-label="清除搜索关键字"
              className="mr-2 rounded-full p-0.5 text-white/40 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
          <button
            type="submit"
            className="shrink-0 rounded-lg bg-white/10 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-white/20 motion-safe:active:scale-95"
          >
            搜索
          </button>
        </form>

        {/* 分类筛选胶囊群 */}
        <div
          className="flex flex-wrap items-center gap-2 pt-1"
          role="group"
          aria-label="页面类型筛选"
        >
          {wikiKinds.map((item) => {
            const active = kind === item.key
            const Icon = item.icon
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={active}
                data-active={active ? "true" : "false"}
                onClick={() => updateFilters({ kind: item.key, page: 1 })}
                className="wiki-kind-pill inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs"
              >
                <Icon className="size-3.5 shrink-0" />
                <span>{item.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* 正文条目流 */}
      <div aria-live="polite" aria-busy={loading}>
        {content}
      </div>
    </div>
  )
}
