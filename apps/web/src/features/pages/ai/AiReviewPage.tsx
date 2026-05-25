"use client"

import * as React from "react"
import { Calendar, FileText, Loader2, RefreshCcw, Sparkles, TrendingUp } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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

  const handleKeyChange = (value: string) => {
    setSelectedKey(value)
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
    <div className="flex flex-1 flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="size-5 text-primary" />
          <h1 className="text-lg font-semibold">AI 回顾</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          基于你在某个周期内的写作数据，由 AI 生成一段自然的回顾。结果会缓存，按需触发。
        </p>
      </div>

      <Card>
        <CardHeader className="gap-2 pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Tabs value={period} onValueChange={handlePeriodChange}>
              <TabsList>
                {PERIOD_TABS.map((tab) => (
                  <TabsTrigger key={tab.value} value={tab.value}>{tab.label}</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <div className="flex items-center gap-2">
              <Calendar className="size-4 text-muted-foreground" />
              <Select
                value={selectedKey}
                onValueChange={handleKeyChange}
                disabled={optionsLoading || activeOptions.length === 0}
              >
                <SelectTrigger className="w-48">
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
          {review ? (
            <CardDescription className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>时间范围 {formatRange(review.periodStart, review.periodEnd)}</span>
              {review.generatedAt ? <span>生成于 {formatDateTime(review.generatedAt)}</span> : null}
              {review.fromCache ? <Badge variant="outline" className="text-[10px]">缓存命中</Badge> : null}
            </CardDescription>
          ) : null}
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          {loading ? <ReviewSkeleton /> : null}
          {errorMessage ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              {errorMessage}
            </div>
          ) : null}
          {showEmpty ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed py-12 text-center">
              <Sparkles className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {selectedKey ? `点击下方按钮生成 ${formatPeriodLabel(period, selectedKey)} 的 AI 回顾。` : "请先选择一个周期。"}
              </p>
              <Button onClick={handleGenerate} disabled={!selectedKey || generating}>
                {generating ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                立即生成
              </Button>
            </div>
          ) : null}

          {review && !loading ? (
            <>
              <StatsGrid review={review} />
              <NarrativeSection review={review} />
              {review.stats.topArticles.length > 0 ? (
                <TopArticlesSection review={review} />
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 text-xs text-muted-foreground">
                <span>
                  {review.regenerateCount > 0 ? `今日已重新生成 ${review.regenerateCount} 次` : "今日尚未重新生成"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRegenerate}
                  disabled={regenerating || !review.canRegenerate}
                >
                  {regenerating ? <Loader2 className="size-4 animate-spin" /> : <RefreshCcw className="size-4" />}
                  {review.canRegenerate ? "重新生成" : "今日已达上限"}
                </Button>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

function StatsGrid({ review }: { review: AiReviewResponse }) {
  const items = [
    { label: "新增文章", value: review.stats.newArticles },
    { label: "修改文章", value: review.stats.updatedArticles },
    { label: "涉及字数", value: review.stats.totalChars },
    { label: "活跃知识库", value: review.stats.knowledgeBaseCount },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-md border bg-muted/30 p-3">
          <div className="text-xs text-muted-foreground">{item.label}</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{item.value}</div>
        </div>
      ))}
    </div>
  )
}

function NarrativeSection({ review }: { review: AiReviewResponse }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <TrendingUp className="size-4 text-primary" />
        AI 综述
      </div>
      <div className="rounded-md border bg-card p-4 text-sm leading-relaxed text-foreground">
        <Markdown>{review.narrative}</Markdown>
      </div>
      {review.stats.topTags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="text-xs text-muted-foreground">高频标签</span>
          {review.stats.topTags.map((tag) => (
            <Badge key={tag.tag} variant="secondary" className="text-xs">
              {tag.tag} <span className="ml-1 text-muted-foreground">×{tag.count}</span>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function TopArticlesSection({ review }: { review: AiReviewResponse }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <FileText className="size-4 text-primary" />
        本期代表文章
      </div>
      <div className="overflow-hidden rounded-md border">
        {review.stats.topArticles.map((article, index) => (
          <div
            key={article.id}
            className={
              "flex items-start justify-between gap-3 px-3 py-2.5" +
              (index === 0 ? "" : " border-t")
            }
          >
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-2">
                <Badge variant={article.isNew ? "default" : "secondary"} className="text-[10px]">
                  {article.isNew ? "新建" : "更新"}
                </Badge>
                <span className="truncate text-sm font-medium">{article.title}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                {article.knowledgeBaseName ?? "未命名知识库"} · {article.charCount} 字 · {formatDateTime(article.updatedAt)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ReviewSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-20 w-full" />
        ))}
      </div>
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-20 w-full" />
    </div>
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
