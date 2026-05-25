import * as React from "react"
import { RotateCcw } from "lucide-react"
import { useNavigate, useParams } from "react-router-dom"
import type { MindElixirData } from "mind-elixir"
import { Suspense, useMemo } from "react"

import { KnowledgeGraph, KnowledgeGraphControls } from "@/components/ui/knowledge-graph"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  knowledgeBaseArticleApi,
  knowledgeBaseArticleMindMapApi,
  type ArticleDetailResponse,
  type ArticleMindMapMode,
} from "@/lib/api"
import { dashboardRoutes, knowledgeBaseArticlePath, knowledgeBasePath } from "@/lib/dashboard-routes"
import { cn } from "@/lib/utils"

function MindMapPanel({
  data,
}: {
  data: MindElixirData
}) {
  const LazyMindMap = useMemo(
    () =>
      React.lazy(async () => {
        const module = await import("@/components/ui/mindmap-runtime")
        return { default: module.MindMap }
      }),
    [],
  )
  const LazyMindMapControls = useMemo(
    () =>
      React.lazy(async () => {
        const module = await import("@/components/ui/mindmap-runtime")
        return { default: module.MindMapControls }
      }),
    [],
  )

  return (
    <Suspense
      fallback={
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          正在加载思维导图...
        </div>
      }
    >
      <LazyMindMap data={data} readonly fit locale="zh_CN">
        <LazyMindMapControls position="top-right" />
      </LazyMindMap>
    </Suspense>
  )
}

export function KnowledgeBaseArticleMindMapPage() {
  const { knowledgeBaseId, articleId } = useParams()
  const navigate = useNavigate()

  const [article, setArticle] = React.useState<ArticleDetailResponse | null>(null)
  const [mode, setMode] = React.useState<ArticleMindMapMode>("MINDMAP")

  type ModeState = {
    data: MindElixirData | null
    fromCache: boolean | null
    generatedAt: string | null
    error: string | null
    generating: boolean
  }

  const createEmptyModeState = React.useCallback(
    (): ModeState => ({
      data: null,
      fromCache: null,
      generatedAt: null,
      error: null,
      generating: false,
    }),
    [],
  )

  const [stateByMode, setStateByMode] = React.useState<Record<ArticleMindMapMode, ModeState>>(
    () => ({
      MINDMAP: createEmptyModeState(),
      KNOWLEDGE_GRAPH: createEmptyModeState(),
    }),
  )

  const [loadingArticle, setLoadingArticle] = React.useState(false)
  // 用 ref 做互斥锁，避免依赖 generating 导致 useEffect 循环触发
  const generatingRef = React.useRef<Record<ArticleMindMapMode, boolean>>({
    MINDMAP: false,
    KNOWLEDGE_GRAPH: false,
  })

  React.useEffect(() => {
    if (!articleId) return

    let canceled = false
    setLoadingArticle(true)
    knowledgeBaseArticleApi
      .detail(articleId)
      .then((res) => {
        if (canceled) return
        setArticle(res.data)
      })
      .catch(() => {
        if (canceled) return
        setArticle(null)
      })
      .finally(() => {
        if (canceled) return
        setLoadingArticle(false)
      })

    return () => {
      canceled = true
    }
  }, [articleId])

  React.useEffect(() => {
    setStateByMode({
      MINDMAP: createEmptyModeState(),
      KNOWLEDGE_GRAPH: createEmptyModeState(),
    })
    generatingRef.current = { MINDMAP: false, KNOWLEDGE_GRAPH: false }
  }, [articleId, createEmptyModeState])

  const updateModeState = React.useCallback(
    (targetMode: ArticleMindMapMode, patch: Partial<ModeState>) => {
      setStateByMode((prev) => ({
        ...prev,
        [targetMode]: {
          ...prev[targetMode],
          ...patch,
        },
      }))
    },
    [],
  )

  const generate = React.useCallback(
    async (forceRebuild: boolean, targetMode: ArticleMindMapMode) => {
      if (!articleId) {
        updateModeState(targetMode, { error: "缺少文章ID" })
        return
      }

      if (generatingRef.current[targetMode]) return
      generatingRef.current[targetMode] = true

      updateModeState(targetMode, { generating: true, error: null })
      try {
        const res = await knowledgeBaseArticleMindMapApi.generate({
          articleId,
          forceRebuild,
          mode: targetMode,
        })
        updateModeState(targetMode, {
          data: res.data.data as MindElixirData,
          fromCache: !!res.data.fromCache,
          generatedAt: res.data.generatedAt ?? null,
        })
      } catch (e: unknown) {
        const msg = (() => {
          if (typeof e === "object" && e && "response" in e) {
            const response = (e as { response?: { data?: { msg?: unknown } } })
              .response
            const apiMsg = response?.data?.msg
            if (typeof apiMsg === "string" && apiMsg) {
              return apiMsg
            }
          }
          if (e instanceof Error && e.message) {
            return e.message
          }
          return "生成失败"
        })()
        updateModeState(targetMode, { error: msg })
      } finally {
        generatingRef.current[targetMode] = false
        updateModeState(targetMode, { generating: false })
      }
    },
    [articleId, updateModeState],
  )

  React.useEffect(() => {
    if (!articleId) return
    const current = stateByMode[mode]
    if (current.data || current.generating || current.error) return
    void generate(false, mode)
  }, [articleId, generate, mode, stateByMode])

  const currentState = stateByMode[mode]
  const mindmapData = currentState.data
  const fromCache = currentState.fromCache
  const generatedAt = currentState.generatedAt
  const generating = currentState.generating
  const error = currentState.error

  const title = article?.title || "思维导图"
  const modeLabel = mode === "MINDMAP" ? "思维导图" : "知识图谱"

  return (
    <div className="w-full p-4 lg:p-6">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold truncate flex items-center gap-2">
            <span className="truncate">{title}</span>
            <Badge variant="secondary" className="shrink-0">
              {modeLabel}
            </Badge>
            <Badge variant="outline" className="shrink-0">
              只读
            </Badge>
          </h1>
          {article?.path ? (
            <p className="text-muted-foreground text-sm mt-1 truncate">
              {article.path}
            </p>
          ) : loadingArticle ? (
            <p className="text-muted-foreground text-sm mt-1">加载文章信息中...</p>
          ) : null}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Tabs
            value={mode}
            onValueChange={(v) => setMode(v as ArticleMindMapMode)}
            className="mr-1"
          >
            <TabsList>
              <TabsTrigger value="MINDMAP">思维导图</TabsTrigger>
              <TabsTrigger value="KNOWLEDGE_GRAPH">知识图谱</TabsTrigger>
            </TabsList>
          </Tabs>

          <Button
            variant="outline"
            onClick={() => {
              if (knowledgeBaseId && articleId) {
                navigate(knowledgeBaseArticlePath(knowledgeBaseId, articleId))
                return
              }
              if (knowledgeBaseId) {
                navigate(knowledgeBasePath(knowledgeBaseId))
                return
              }
              navigate(dashboardRoutes.knowledge)
            }}
          >
            返回文章
          </Button>

          <Button
            variant="outline"
            disabled={!articleId || generating}
            onClick={() => void generate(true, mode)}
          >
            <RotateCcw className="h-4 w-4" />
            {generating ? "生成中..." : "重新生成"}
          </Button>
        </div>
      </div>

      {fromCache !== null ? (
        <div className="text-muted-foreground text-sm mb-3">
          {fromCache ? "已命中缓存" : "已重新生成"}
          {generatedAt ? <span className="ml-2">生成时间：{generatedAt}</span> : null}
        </div>
      ) : null}

      {error ? (
        <Card className="border-destructive/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-destructive">出错了</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-3">
            <div className="text-destructive">{error}</div>
            <div className="flex items-center gap-2">
              <Button disabled={generating || !articleId} onClick={() => void generate(false, mode)}>
                重试
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  if (knowledgeBaseId) {
                    navigate(knowledgeBasePath(knowledgeBaseId))
                    return
                  }
                  navigate(dashboardRoutes.knowledge)
                }}
              >
                返回知识库
              </Button>
            </div>
          </CardContent>
        </Card>
	      ) : (
        <div
          className={cn(
            "relative w-full rounded-lg border overflow-hidden bg-background",
            "h-[calc(100vh-220px)]",
          )}
        >
          {mindmapData ? (
            <>
              {mode === "KNOWLEDGE_GRAPH" ? (
                <KnowledgeGraph data={mindmapData}>
                  <KnowledgeGraphControls position="top-right" />
                </KnowledgeGraph>
              ) : (
                <MindMapPanel data={mindmapData} />
              )}
            </>
	          ) : (
	            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
	              {generating ? "正在生成思维导图..." : "暂无思维导图数据"}
	            </div>
	          )}
	        </div>
	      )}
    </div>
  )
}
