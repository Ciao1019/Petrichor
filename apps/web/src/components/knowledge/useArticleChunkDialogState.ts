import * as React from "react"
import { toast } from "sonner"

import { resolveAxiosErrorMessage } from "@/components/knowledge/article-share-utils"
import {
  buildArticleKnowledgeAndWait,
  knowledgeBaseWikiAgentApi,
  type ArticleKnowledgeChunkListResponse,
  type ArticleKnowledgeChunkResponse,
} from "@/lib/api"

type UseArticleChunkDialogStateOptions = {
  open: boolean
  knowledgeBaseId?: string
  articleId?: string
}

/** 命中切片标题路径、正文或任意一条推荐问题即视为匹配。 */
export function matchesChunkKeyword(chunk: ArticleKnowledgeChunkResponse, keyword: string) {
  const needle = keyword.trim().toLowerCase()
  if (!needle) return true
  if (chunk.heading.toLowerCase().includes(needle)) return true
  if (chunk.headingPath.join(" ").toLowerCase().includes(needle)) return true
  if (chunk.chunkKey.toLowerCase().includes(needle)) return true
  if (chunk.contentMd.toLowerCase().includes(needle)) return true
  return chunk.recommendedQuestions.some((question) => question.toLowerCase().includes(needle))
}

export function useArticleChunkDialogState({
  open,
  knowledgeBaseId,
  articleId,
}: UseArticleChunkDialogStateOptions) {
  const [loading, setLoading] = React.useState(false)
  const [building, setBuilding] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [data, setData] = React.useState<ArticleKnowledgeChunkListResponse | null>(null)
  const [keyword, setKeyword] = React.useState("")

  const load = React.useCallback(async () => {
    if (!knowledgeBaseId || !articleId) return
    setLoading(true)
    try {
      const res = await knowledgeBaseWikiAgentApi.articleChunks({ knowledgeBaseId, articleId })
      setData(res.data)
      setError(null)
    } catch (e: unknown) {
      setError(resolveAxiosErrorMessage(e, "加载文章分片失败"))
    } finally {
      setLoading(false)
    }
  }, [articleId, knowledgeBaseId])

  React.useEffect(() => {
    if (!open) return
    setKeyword("")
    void load()
  }, [load, open])

  const rebuild = React.useCallback(async () => {
    if (!knowledgeBaseId || !articleId || building) return
    setBuilding(true)
    try {
      const result = await buildArticleKnowledgeAndWait({
        knowledgeBaseId,
        articleId,
        forceRebuild: true,
      })
      for (const warning of result.warnings) toast.warning(warning)
      toast.success(`已生成 ${result.chunkCount} 个分片、${result.recommendedQuestionCount} 个推荐问题`)
      await load()
    } catch (e: unknown) {
      const message = resolveAxiosErrorMessage(e, "构建知识失败")
      setError(message)
      toast.error(message)
    } finally {
      setBuilding(false)
    }
  }, [articleId, building, knowledgeBaseId, load])

  const visibleChunks = React.useMemo(
    () => (data?.chunks ?? []).filter((chunk) => matchesChunkKeyword(chunk, keyword)),
    [data?.chunks, keyword],
  )

  return {
    loading,
    building,
    error,
    data,
    keyword,
    setKeyword,
    visibleChunks,
    reload: load,
    rebuild,
  }
}
