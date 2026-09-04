// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type {
  ArticleKnowledgeBuildJobResponse,
  ArticleKnowledgeBuildResponse,
} from "@/lib/api"
import { KnowledgeBuildProgressSheet } from "./KnowledgeBuildProgressSheet"

const now = "2026-09-04T10:00:00Z"

function processingJob(): ArticleKnowledgeBuildJobResponse {
  return {
    id: "knowledge-build-1-1-7",
    userId: "1",
    knowledgeBaseId: "1",
    articleId: "7",
    status: "processing",
    progress: {
      percent: 30,
      phase: "analyzing",
      message: "文档 Agent 正在读取完整正文",
      attempt: 1,
      maxAttempts: 3,
      updatedAt: now,
      heartbeatAt: now,
      stages: [
        { id: "queued", status: "completed" },
        { id: "preparing", status: "completed" },
        {
          id: "analyzing",
          status: "running",
          message: "正在理解完整文档",
          children: [
            {
              id: "analyzing.agent",
              status: "running",
              message: "已完整读取 2 个正文分卷",
              completed: 2,
              total: 4,
              percent: 50,
            },
            {
              id: "analyzing.questions",
              status: "completed",
              message: "推荐问题生成完成",
              completed: 3,
              total: 3,
              percent: 100,
            },
          ],
        },
        { id: "pages", status: "pending" },
        { id: "taxonomy", status: "pending" },
        { id: "persisting", status: "pending" },
        { id: "embedding", status: "pending" },
        { id: "completed", status: "pending" },
      ],
      events: [{
        id: "event-1",
        stageId: "analyzing.agent",
        message: "文档工作区准备完成",
        createdAt: now,
      }],
      agentActivities: [{
        id: "call-read-2",
        kind: "tool",
        status: "running",
        title: "阅读正文分卷",
        detail: "/document/parts/part-002.md · 从第 100 行读取 50 行",
        agentName: "子 Agent",
        toolName: "read_file",
        round: 3,
        createdAt: now,
        updatedAt: now,
      }],
    },
    result: null,
    error: null,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  }
}

describe("KnowledgeBuildProgressSheet", () => {
  it("展示总体阶段、并行子任务和按需展开的安全事件", () => {
    render(
      <KnowledgeBuildProgressSheet
        open
        onOpenChange={vi.fn()}
        articleName="Fastfetch 使用手册"
        job={processingJob()}
        submitting={false}
        onRebuild={vi.fn()}
      />,
    )

    expect(screen.getByText("Fastfetch 使用手册")).toBeTruthy()
    expect(screen.getByText("30%")).toBeTruthy()
    expect(screen.getByText("文档 Agent 阅读与抽取")).toBeTruthy()
    expect(screen.getByText("2/4")).toBeTruthy()
    expect(screen.getByText("ADK 执行动态")).toBeTruthy()
    expect(screen.getByText("阅读正文分卷")).toBeTruthy()
    expect(screen.getByText(/part-002\.md/)).toBeTruthy()
    expect(screen.getByText("子 Agent")).toBeTruthy()
    expect(screen.getByText("第 3 轮")).toBeTruthy()
    expect(screen.queryByText("文档工作区准备完成")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /运行记录/ }))
    expect(screen.getByText("文档工作区准备完成")).toBeTruthy()
  })

  it("完成后展示构建收据并允许用户主动重新构建", () => {
    const onRebuild = vi.fn()
    const base = processingJob()
    const job: ArticleKnowledgeBuildJobResponse = {
      ...base,
      status: "completed",
      progress: {
        ...base.progress,
        percent: 100,
        phase: "completed",
        message: "知识构建完成",
        stages: base.progress.stages?.map((stage) => ({
          ...stage,
          status: "completed" as const,
          children: stage.children?.map((child) => ({ ...child, status: "completed" as const })),
        })),
      },
      result: {
        articleId: "7",
        knowledgeBaseId: "1",
        fromCache: false,
        chunkCount: 16,
        recommendedQuestionCount: 18,
        entityCount: 8,
        conceptCount: 11,
        mergedKnowledgeCount: 2,
        relationCount: 9,
        sourcePage: {} as ArticleKnowledgeBuildResponse["sourcePage"],
        warnings: [],
      },
      completedAt: now,
    }

    render(
      <KnowledgeBuildProgressSheet
        open
        onOpenChange={vi.fn()}
        articleName="Fastfetch 使用手册"
        job={job}
        submitting={false}
        onRebuild={onRebuild}
      />,
    )

    expect(screen.getByText("构建结果")).toBeTruthy()
    expect(screen.getByText("合并知识")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "重新构建" }))
    expect(onRebuild).toHaveBeenCalledTimes(1)
  })
})
