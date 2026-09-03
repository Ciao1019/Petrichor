// @vitest-environment jsdom

import type { AxiosResponse } from "axios"
import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  knowledgeBaseWikiAgentApi,
  type ArticleKnowledgeBuildJobListResponse,
  type ArticleKnowledgeBuildJobResponse,
  type KnowledgeBaseTreeNode,
} from "@/lib/api"
import {
  collectLoadedArticleIds,
  useArticleKnowledgeBuildJobs,
} from "./use-article-knowledge-build-jobs"

const now = "2026-09-03T10:00:00Z"

function createJob(
  status: ArticleKnowledgeBuildJobResponse["status"],
): ArticleKnowledgeBuildJobResponse {
  return {
    id: "knowledge-build-1-1-7",
    userId: "1",
    knowledgeBaseId: "1",
    articleId: "7",
    status,
    progress: {
      percent: status === "processing" ? 46 : status === "failed" ? 46 : 0,
      phase: status === "processing" ? "analyzing" : status === "failed" ? "failed" : "queued",
      message: status === "failed" ? "模型调用失败" : "正在分析正文",
      updatedAt: now,
    },
    result: null,
    error: status === "failed" ? "模型调用失败" : null,
    startedAt: status === "pending" ? null : now,
    completedAt: status === "failed" ? now : null,
    createdAt: now,
    updatedAt: now,
  }
}

function listResponse(
  jobs: ArticleKnowledgeBuildJobResponse[],
): AxiosResponse<ArticleKnowledgeBuildJobListResponse> {
  return { data: { jobs } } as AxiosResponse<ArticleKnowledgeBuildJobListResponse>
}

describe("useArticleKnowledgeBuildJobs", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("页面刷新后恢复进行中任务，并继续轮询到失败终态", async () => {
    const processing = createJob("processing")
    const failed = {
      ...createJob("failed"),
      updatedAt: "2026-09-03T10:01:00Z",
      progress: {
        ...createJob("failed").progress,
        updatedAt: "2026-09-03T10:01:00Z",
      },
    }
    vi.spyOn(knowledgeBaseWikiAgentApi, "articleKnowledgeBuildStatusList")
      .mockResolvedValueOnce(listResponse([processing]))
      .mockResolvedValue(listResponse([failed]))
    const onFailed = vi.fn()

    const { result, unmount } = renderHook(() => useArticleKnowledgeBuildJobs({
      knowledgeBaseId: "1",
      articleIds: ["7"],
      onFailed,
      pollIntervalMs: 100,
    }))

    await waitFor(() => expect(result.current.jobsByArticleId["7"]?.status).toBe("processing"))
    await waitFor(() => expect(result.current.jobsByArticleId["7"]?.status).toBe("failed"))
    expect(onFailed).toHaveBeenCalledTimes(1)
    unmount()
  })

  it("刷新时直接读到的历史失败会保留展示，但不会重复弹出失败通知", async () => {
    vi.spyOn(knowledgeBaseWikiAgentApi, "articleKnowledgeBuildStatusList")
      .mockResolvedValue(listResponse([createJob("failed")]))
    const onFailed = vi.fn()

    const { result } = renderHook(() => useArticleKnowledgeBuildJobs({
      knowledgeBaseId: "1",
      articleIds: ["7"],
      onFailed,
      pollIntervalMs: 10,
    }))

    await waitFor(() => expect(result.current.jobsByArticleId["7"]?.status).toBe("failed"))
    expect(onFailed).not.toHaveBeenCalled()
  })
})

describe("collectLoadedArticleIds", () => {
  it("收集根节点与已加载子树中的文章并去重", () => {
    const nodes = [
      { id: "n-1", type: "ARTICLE", articleId: "7", name: "根文章" },
      {
        id: "f-1",
        type: "FOLDER",
        name: "目录",
        children: [
          { id: "n-2", type: "ARTICLE", articleId: "8", name: "子文章" },
          { id: "n-3", type: "ARTICLE", articleId: "7", name: "重复文章" },
        ],
      },
    ] as KnowledgeBaseTreeNode[]

    expect(collectLoadedArticleIds(nodes)).toEqual(["7", "8"])
  })
})
