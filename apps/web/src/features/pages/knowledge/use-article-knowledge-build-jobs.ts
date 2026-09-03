import * as React from "react"

import {
  knowledgeBaseWikiAgentApi,
  type ArticleKnowledgeBuildJobResponse,
  type KnowledgeBaseTreeNode,
} from "@/lib/api"

const STATUS_BATCH_SIZE = 200
const STATUS_POLL_INTERVAL_MS = 1_500

type JobsByArticleId = Record<string, ArticleKnowledgeBuildJobResponse>

export function collectLoadedArticleIds(nodes: KnowledgeBaseTreeNode[]): string[] {
  const articleIds: string[] = []
  const walk = (items: KnowledgeBaseTreeNode[]) => {
    for (const node of items) {
      if (node.type === "ARTICLE" && node.articleId) {
        articleIds.push(node.articleId)
      }
      if (node.children?.length) {
        walk(node.children)
      }
    }
  }
  walk(nodes)
  return Array.from(new Set(articleIds))
}

function isRunning(job: ArticleKnowledgeBuildJobResponse | undefined): boolean {
  return job?.status === "pending" || job?.status === "processing"
}

function jobUpdatedAt(job: ArticleKnowledgeBuildJobResponse): number {
  const timestamp = Date.parse(job.updatedAt || job.createdAt || "")
  return Number.isFinite(timestamp) ? timestamp : 0
}

function mergeKnowledgeBuildJobs(
  current: JobsByArticleId,
  incoming: ArticleKnowledgeBuildJobResponse[],
): JobsByArticleId {
  let next = current
  for (const job of incoming) {
    const existing = next[job.articleId]
    if (existing && existing.id === job.id && jobUpdatedAt(existing) > jobUpdatedAt(job)) {
      continue
    }
    if (next === current) {
      next = { ...current }
    }
    next[job.articleId] = job
  }
  return next
}

async function fetchKnowledgeBuildStatuses(
  knowledgeBaseId: string,
  articleIds: string[],
): Promise<ArticleKnowledgeBuildJobResponse[]> {
  const uniqueArticleIds = Array.from(new Set(articleIds))
  const requests: Promise<ArticleKnowledgeBuildJobResponse[]>[] = []
  for (let start = 0; start < uniqueArticleIds.length; start += STATUS_BATCH_SIZE) {
    const batch = uniqueArticleIds.slice(start, start + STATUS_BATCH_SIZE)
    requests.push(
      knowledgeBaseWikiAgentApi.articleKnowledgeBuildStatusList({
        knowledgeBaseId,
        articleIds: batch,
      }).then((response) => response.data.jobs),
    )
  }
  return (await Promise.all(requests)).flat()
}

export interface UseArticleKnowledgeBuildJobsOptions {
  knowledgeBaseId: string | undefined
  articleIds: string[]
  onCompleted?: (job: ArticleKnowledgeBuildJobResponse) => void
  onFailed?: (job: ArticleKnowledgeBuildJobResponse) => void
  pollIntervalMs?: number
}

/**
 * 从服务端 Asynq 状态恢复文章构建任务，并在刷新后继续轮询。
 * 终态保留在 jobsByArticleId 中，供列表直接展示完成、部分完成或失败。
 */
export function useArticleKnowledgeBuildJobs({
  knowledgeBaseId,
  articleIds,
  onCompleted,
  onFailed,
  pollIntervalMs = STATUS_POLL_INTERVAL_MS,
}: UseArticleKnowledgeBuildJobsOptions) {
  const [jobsByArticleId, setJobsByArticleId] = React.useState<JobsByArticleId>({})
  const [submittingArticleIds, setSubmittingArticleIds] = React.useState<Set<string>>(new Set())
  const watchedJobIdsRef = React.useRef<Set<string>>(new Set())
  const onCompletedRef = React.useRef(onCompleted)
  const onFailedRef = React.useRef(onFailed)
  onCompletedRef.current = onCompleted
  onFailedRef.current = onFailed

  const articleIdsKey = React.useMemo(
    () => JSON.stringify(Array.from(new Set(articleIds))),
    [articleIds],
  )
  const stableArticleIds = React.useMemo<string[]>(() => JSON.parse(articleIdsKey), [articleIdsKey])

  const mergeJobs = React.useCallback((jobs: ArticleKnowledgeBuildJobResponse[]) => {
    if (jobs.length === 0) return
    setJobsByArticleId((current) => mergeKnowledgeBuildJobs(current, jobs))
  }, [])

  React.useEffect(() => {
    setJobsByArticleId({})
    setSubmittingArticleIds(new Set())
    watchedJobIdsRef.current.clear()
  }, [knowledgeBaseId])

  React.useEffect(() => {
    if (!knowledgeBaseId || stableArticleIds.length === 0) return
    let canceled = false
    void fetchKnowledgeBuildStatuses(knowledgeBaseId, stableArticleIds)
      .then((jobs) => {
        if (!canceled) mergeJobs(jobs)
      })
      .catch(() => {
        // 页面状态恢复失败不应阻断目录加载；进行中任务仍可在下一轮轮询恢复。
      })
    return () => {
      canceled = true
    }
  }, [knowledgeBaseId, mergeJobs, stableArticleIds])

  const runningArticleIdsKey = React.useMemo(
    () => JSON.stringify(
      Object.values(jobsByArticleId).filter(isRunning).map((job) => job.articleId).sort(),
    ),
    [jobsByArticleId],
  )
  const runningArticleIds = React.useMemo<string[]>(
    () => JSON.parse(runningArticleIdsKey),
    [runningArticleIdsKey],
  )

  React.useEffect(() => {
    if (!knowledgeBaseId || runningArticleIds.length === 0) return
    let canceled = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const jobs = await fetchKnowledgeBuildStatuses(knowledgeBaseId, runningArticleIds)
        if (!canceled) mergeJobs(jobs)
      } catch {
        // 临时网络错误保留最后一次进度，并在下一轮继续查询。
      } finally {
        if (!canceled) timer = window.setTimeout(poll, pollIntervalMs)
      }
    }
    timer = window.setTimeout(poll, pollIntervalMs)
    return () => {
      canceled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [knowledgeBaseId, mergeJobs, pollIntervalMs, runningArticleIds])

  React.useEffect(() => {
    for (const job of Object.values(jobsByArticleId)) {
      if (isRunning(job)) {
        watchedJobIdsRef.current.add(job.id)
        continue
      }
      if (!watchedJobIdsRef.current.delete(job.id)) {
        continue
      }
      if (job.status === "completed" && job.result) {
        onCompletedRef.current?.(job)
      } else {
        onFailedRef.current?.(job)
      }
    }
  }, [jobsByArticleId])

  const startBuild = React.useCallback(async (articleId: string) => {
    if (!knowledgeBaseId || submittingArticleIds.has(articleId) || isRunning(jobsByArticleId[articleId])) {
      return null
    }
    setSubmittingArticleIds((current) => new Set(current).add(articleId))
    try {
      const response = await knowledgeBaseWikiAgentApi.buildArticleKnowledge({
        knowledgeBaseId,
        articleId,
      })
      watchedJobIdsRef.current.add(response.data.id)
      mergeJobs([response.data])
      return response.data
    } finally {
      setSubmittingArticleIds((current) => {
        const next = new Set(current)
        next.delete(articleId)
        return next
      })
    }
  }, [jobsByArticleId, knowledgeBaseId, mergeJobs, submittingArticleIds])

  return {
    jobsByArticleId,
    submittingArticleIds,
    startBuild,
  }
}
