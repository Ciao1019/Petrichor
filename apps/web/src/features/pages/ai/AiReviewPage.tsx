"use client"

import * as React from "react"
import {
  Calendar,
  FilePlus2,
  FileText,
  Loader2,
  Milestone,
  Quote,
  RefreshCcw,
  Sparkles,
  Tags,
} from "@/components/iconimate"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Markdown } from "@/components/ui/markdown"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { resolveAxiosErrorMessage } from "@/components/knowledge/article-share-utils"
import {
  aiReviewApi,
  type AiReviewPeriod,
  type AiReviewPeriodOption,
  type AiReviewResponse,
} from "@/lib/api"
import { emitNotificationRefresh } from "@/hooks/use-notification-center"
import { cn } from "@/lib/utils"

interface PeriodOptionsState {
  week: AiReviewPeriodOption[]
  month: AiReviewPeriodOption[]
}

const PERIOD_TABS: { value: AiReviewPeriod; label: string }[] = [
  { value: "WEEK", label: "周报" },
  { value: "MONTH", label: "月报" },
]

export function AiReviewPage() {
  const [period, setPeriod] = React.useState<AiReviewPeriod>("WEEK")
  const [periodOptions, setPeriodOptions] = React.useState<PeriodOptionsState | null>(null)
  const [optionsLoading, setOptionsLoading] = React.useState(true)
  const [selectedKey, setSelectedKey] = React.useState<string>("")
  const [review, setReview] = React.useState<AiReviewResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [generating, setGenerating] = React.useState(false)
  const [regenerating, setRegenerating] = React.useState(false)
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)

  const loadPeriodOptions = React.useCallback(async () => {
    setOptionsLoading(true)
    try {
      const res = await aiReviewApi.periodOptions()
      setPeriodOptions(res.data)
      const initial = (period === "WEEK" ? res.data.week : res.data.month)
        .find((option) => option.isDefault) ?? (period === "WEEK" ? res.data.week[0] : res.data.month[0])
      if (initial) {
        setSelectedKey(initial.key)
      }
    } catch (error) {
      toast.error(resolveAxiosErrorMessage(error, "加载周期列表失败"))
    } finally {
      setOptionsLoading(false)
    }
  }, [period])

  React.useEffect(() => {
    void loadPeriodOptions()
  }, [loadPeriodOptions])

  const fetchReview = React.useCallback(async (
    nextPeriod: AiReviewPeriod,
    nextKey: string,
    options: { forceRebuild?: boolean } = {},
  ) => {
    if (!nextKey) {
      return
    }
    const isInitialFetch = !options.forceRebuild
    if (isInitialFetch) {
      setLoading(true)
    }
    setErrorMessage(null)
    try {
      const res = await aiReviewApi.get({
        period: nextPeriod,
        periodKey: nextKey,
        forceRebuild: options.forceRebuild ?? false,
      })
      setReview(res.data)
      if (!res.data.fromCache) {
        emitNotificationRefresh()
      }
    } catch (error) {
      const message = resolveAxiosErrorMessage(error, "加载回顾失败")
      setErrorMessage(message)
      setReview(null)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (!selectedKey) {
      return
    }
    void fetchReview(period, selectedKey)
  }, [period, selectedKey, fetchReview])

  const handlePeriodChange = (value: string) => {
    const next = value as AiReviewPeriod
    setPeriod(next)
    setReview(null)
    if (periodOptions) {
      const pool = next === "WEEK" ? periodOptions.week : periodOptions.month
      const fallback = pool.find((option) => option.isDefault) ?? pool[0]
      if (fallback) {
        setSelectedKey(fallback.key)
      }
    }
  }

  const handleGenerate = async () => {
    if (!selectedKey) {
      return
    }
    setGenerating(true)
    try {
      await fetchReview(period, selectedKey, { forceRebuild: false })
    } finally {
      setGenerating(false)
    }
  }

  const handleRegenerate = async () => {
    if (!selectedKey) {
      return
    }
    setRegenerating(true)
    try {
      const res = await aiReviewApi.regenerate({ period, periodKey: selectedKey })
      setReview(res.data)
      emitNotificationRefresh()
      toast.success("已重新生成")
    } catch (error) {
      toast.error(resolveAxiosErrorMessage(error, "重新生成失败"))
    } finally {
      setRegenerating(false)
    }
  }

  const activeOptions = (periodOptions
    ? (period === "WEEK" ? periodOptions.week : periodOptions.month)
    : []) as AiReviewPeriodOption[]
  const showEmpty = !loading && !review && !generating && !errorMessage

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-10">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <Sparkles className="size-5" />
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">AI 回顾</h1>
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              基于你的写作数据生成周期回顾；月报还会回看你对高频主题的认知演化。结果会缓存，按需生成。
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={period} onValueChange={handlePeriodChange}>
            <TabsList>
              {PERIOD_TABS.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value}>{tab.label}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Select
            value={selectedKey}
            onValueChange={setSelectedKey}
            disabled={optionsLoading || activeOptions.length === 0}
          >
            <SelectTrigger className="w-44">
              <Calendar className="mr-1 size-4 text-muted-foreground" />
              <SelectValue placeholder={optionsLoading ? "加载中…" : "选择周期"} />
            </SelectTrigger>
            <SelectContent>
              {activeOptions.map((option) => (
                <SelectItem key={option.key} value={option.key}>
                  <div className="flex items-center gap-2">
                    <span>{option.label}</span>
                    {option.isCurrent ? (
                      <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">本期</Badge>
                    ) : null}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mx-auto w-full max-w-4xl">
        {loading ? <ReviewSkeleton /> : null}

        {errorMessage ? (
          <Card>
            <CardContent className="py-6">
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                {errorMessage}
              </div>
            </CardContent>
          </Card>
        ) : null}

        {showEmpty ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <div className="flex size-12 items-center justify-center rounded-full border bg-muted/50 text-muted-foreground">
                <Sparkles className="size-5" />
              </div>
              <p className="text-sm text-muted-foreground">
                {selectedKey ? `点击生成 ${formatPeriodLabel(period, selectedKey)} 的 AI 回顾。` : "请先选择一个周期。"}
              </p>
              <Button onClick={handleGenerate} disabled={!selectedKey || generating}>
                {generating ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Sparkles className="mr-2 size-4" />}
                立即生成
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {review && !loading ? (
          <ReviewReport
            review={review}
            period={period}
            regenerating={regenerating}
            onRegenerate={handleRegenerate}
          />
        ) : null}
      </div>
    </div>
  )
}

function ReviewReport({
  review,
  period,
  regenerating,
  onRegenerate,
}: {
  review: AiReviewResponse
  period: AiReviewPeriod
  regenerating: boolean
  onRegenerate: () => void
}) {
  const evolution = review.stats.evolution ?? null
  return (
    <Card className="overflow-hidden">
      {/* 报告头 */}
      <div className="border-b bg-muted/30 px-6 py-6 sm:px-10">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              {period === "WEEK" ? "WEEKLY REVIEW" : "MONTHLY REVIEW"}
            </div>
            <h2 className="text-2xl font-semibold tracking-tight">
              {formatPeriodLabel(period, review.periodKey)}
              <span className="ml-2 text-base font-normal text-muted-foreground">
                {period === "WEEK" ? "周度回顾" : "月度回顾"}
              </span>
            </h2>
            <div className="text-xs text-muted-foreground">
              {formatRange(review.periodStart, review.periodEnd)}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5 text-xs text-muted-foreground">
            {review.fromCache ? <Badge variant="outline" className="text-[10px]">缓存</Badge> : null}
            {review.generatedAt ? <span>生成于 {formatDateTime(review.generatedAt)}</span> : null}
          </div>
        </div>
      </div>

      <CardContent className="space-y-8 px-6 py-8 sm:px-10">
        {/* AI 综述：引言式排版 */}
        <section className="relative">
          <Quote className="absolute -left-1 -top-1 size-5 text-primary/30 sm:-left-4" aria-hidden />
          <div className="pl-6 text-[15px] leading-7 text-foreground sm:pl-4">
            <Markdown>{review.narrative}</Markdown>
          </div>
        </section>

        {/* 核心统计 */}
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="新增文章" value={review.stats.newArticles} />
          <StatTile label="修改文章" value={review.stats.updatedArticles} />
          <StatTile label="涉及字数" value={review.stats.totalChars} />
          <StatTile label="活跃知识库" value={review.stats.knowledgeBaseCount} />
        </section>

        {/* 知识库分布：单色横向条形 */}
        {review.stats.knowledgeBases.length > 0 ? (
          <ReportSection icon={FileText} title="知识库分布">
            <KnowledgeBaseBars items={review.stats.knowledgeBases} />
          </ReportSection>
        ) : null}

        {/* 高频标签 */}
        {review.stats.topTags.length > 0 ? (
          <ReportSection icon={Tags} title="高频标签">
            <div className="flex flex-wrap gap-1.5">
              {review.stats.topTags.map((tag) => (
                <Badge key={tag.tag} variant="secondary" className="font-normal">
                  {tag.tag}
                  <span className="ml-1 text-muted-foreground">×{tag.count}</span>
                </Badge>
              ))}
            </div>
          </ReportSection>
        ) : null}

        {/* 认知演化时间线（月报专属） */}
        {evolution ? (
          <ReportSection icon={Milestone} title="认知演化" badge={evolution.topic}>
            <p className="text-sm leading-relaxed text-muted-foreground">{evolution.synthesis}</p>
            <ol className="mt-4">
              {evolution.entries.map((entry, index) => (
                <li key={`${entry.period}-${index}`} className="relative flex gap-4 pb-6 last:pb-0">
                  {index < evolution.entries.length - 1 ? (
                    <span className="absolute left-[7px] top-5 h-[calc(100%-1rem)] w-px bg-border" aria-hidden />
                  ) : null}
                  <span
                    className={cn(
                      "mt-1.5 size-[15px] shrink-0 rounded-full border-2",
                      index === evolution.entries.length - 1
                        ? "border-primary bg-primary/20"
                        : "border-muted-foreground/40 bg-background",
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{entry.period}</span>
                      <span className="text-sm font-medium">{entry.title}</span>
                    </div>
                    <p className="text-sm leading-relaxed text-muted-foreground">{entry.note}</p>
                  </div>
                </li>
              ))}
            </ol>
          </ReportSection>
        ) : null}

        {/* 代表文章 */}
        {review.stats.topArticles.length > 0 ? (
          <ReportSection icon={FilePlus2} title="本期代表文章">
            <ol className="space-y-0 divide-y">
              {review.stats.topArticles.map((article, index) => (
                <li key={article.id} className="flex items-baseline gap-4 py-2.5">
                  <span className="w-6 shrink-0 text-right font-mono text-lg font-semibold text-muted-foreground/50">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{article.title}</span>
                      <Badge variant={article.isNew ? "default" : "secondary"} className="px-1.5 py-0 text-[10px]">
                        {article.isNew ? "新建" : "更新"}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {article.knowledgeBaseName ?? "未命名知识库"} · {article.charCount.toLocaleString()} 字 · {formatDateTime(article.updatedAt)}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </ReportSection>
        ) : null}

        {/* 底部操作 */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4 text-xs text-muted-foreground">
          <span>
            {review.regenerateCount > 0 ? `今日已重新生成 ${review.regenerateCount} 次` : "今日尚未重新生成"}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={onRegenerate}
            disabled={regenerating || !review.canRegenerate}
          >
            {regenerating ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCcw className="mr-2 size-4" />}
            {review.canRegenerate ? "重新生成" : "今日已达上限"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function ReportSection({
  icon: Icon,
  title,
  badge,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  badge?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-primary" aria-hidden />
        <h3 className="text-sm font-semibold tracking-wide">{title}</h3>
        {badge ? (
          <Badge variant="outline" className="border-primary/25 bg-primary/5 font-normal text-primary">
            {badge}
          </Badge>
        ) : null}
      </div>
      {children}
    </section>
  )
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value.toLocaleString()}</div>
    </div>
  )
}

// 知识库文章数分布：同一度量的量级对比，单主题色、数值直接标注、逐条悬停提示
function KnowledgeBaseBars({ items }: { items: Array<{ id: string; name: string; articleCount: number }> }) {
  const max = Math.max(1, ...items.map((item) => item.articleCount))
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div
          key={item.id}
          className="group grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3"
          title={`${item.name} · ${item.articleCount} 篇`}
        >
          <span className="truncate text-xs text-muted-foreground">{item.name}</span>
          <div className="h-4 overflow-hidden rounded-r-[4px] bg-muted/50">
            <div
              className="h-full rounded-r-[4px] bg-primary/80 transition-colors group-hover:bg-primary"
              style={{ width: `${Math.max(4, (item.articleCount / max) * 100)}%` }}
            />
          </div>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{item.articleCount} 篇</span>
        </div>
      ))}
    </div>
  )
}

function ReviewSkeleton() {
  return (
    <Card>
      <CardContent className="space-y-6 py-8">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-24 w-full" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-20 w-full" />
          ))}
        </div>
        <Skeleton className="h-32 w-full" />
      </CardContent>
    </Card>
  )
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function formatRange(start: string, end: string) {
  const startDate = formatBeijingDate(start)
  const endDate = formatBeijingDate(new Date(new Date(end).getTime() - 1).toISOString())
  return `${startDate} 至 ${endDate}`
}

function formatBeijingDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const shifted = new Date(date.getTime() + 480 * 60_000)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0")
  const day = String(shifted.getUTCDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function formatPeriodLabel(period: AiReviewPeriod, key: string) {
  if (period === "MONTH") {
    const [year, month] = key.split("-")
    return `${year} 年 ${Number(month)} 月`
  }
  const match = /^(\d{4})-W(\d{2})$/.exec(key)
  if (!match) return key
  return `${match[1]} 年第 ${Number(match[2])} 周`
}
