import type { AxiosResponse } from "axios"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  buildArticleKnowledgeAndWait,
  knowledgeBaseWikiAgentApi,
  type ArticleKnowledgeBuildJobResponse,
  type ArticleKnowledgeBuildProgress,
  type ArticleKnowledgeBuildResponse,
} from "@/lib/api-wiki"

const now = "2026-09-03T10:00:00Z"

function createJob(
  status: ArticleKnowledgeBuildJobResponse["status"],
  progress: ArticleKnowledgeBuildProgress,
  result: ArticleKnowledgeBuildResponse | null = null,
): ArticleKnowledgeBuildJobResponse {
  return {
    id: "knowledge-build-1-1-1",
    userId: "1",
    knowledgeBaseId: "1",
    articleId: "1",
    status,
    progress,
    result,
    error: null,
    startedAt: status === "pending" ? null : now,
    completedAt: status === "completed" ? now : null,
    createdAt: now,
    updatedAt: now,
  }
}

describe("buildArticleKnowledgeAndWait", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("向调用方连续推送排队、处理中和 100% 完成进度", async () => {
    vi.useFakeTimers()
    const queued = createJob("pending", {
      percent: 0,
      phase: "queued",
      message: "等待 Worker 处理",
      updatedAt: now,
    })
    const processing = createJob("processing", {
      percent: 63,
      phase: "pages",
      message: "正在生成 Wiki 页面",
      completed: 2,
      total: 4,
      updatedAt: now,
    })
    const result: ArticleKnowledgeBuildResponse = {
      articleId: "1",
      knowledgeBaseId: "1",
      fromCache: false,
      chunkCount: 3,
      recommendedQuestionCount: 9,
      entityCount: 1,
      conceptCount: 1,
      sourcePage: {
        id: "10",
        knowledgeBaseId: "1",
        pageKey: "source/article-1",
        title: "测试文章",
        kind: "source",
        contentMd: "# 测试文章",
        frontmatter: {},
        categoryPath: [],
        aliases: [],
        contentHash: "hash",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      warnings: [],
    }
    const completed = createJob("completed", {
      percent: 100,
      phase: "completed",
      message: "知识构建完成",
      updatedAt: now,
    }, result)

    vi.spyOn(knowledgeBaseWikiAgentApi, "buildArticleKnowledge").mockResolvedValue({
      data: queued,
    } as AxiosResponse<ArticleKnowledgeBuildJobResponse>)
    vi.spyOn(knowledgeBaseWikiAgentApi, "articleKnowledgeBuildStatus")
      .mockResolvedValueOnce({ data: processing } as AxiosResponse<ArticleKnowledgeBuildJobResponse>)
      .mockResolvedValueOnce({ data: completed } as AxiosResponse<ArticleKnowledgeBuildJobResponse>)

    const observed: number[] = []
    const responsePromise = buildArticleKnowledgeAndWait({
      knowledgeBaseId: "1",
      articleId: "1",
    }, {
      onProgress: (progress) => observed.push(progress.percent),
    })

    await vi.advanceTimersByTimeAsync(2_000)
    await expect(responsePromise).resolves.toBe(result)
    expect(observed).toEqual([0, 63, 100])
  })
})
