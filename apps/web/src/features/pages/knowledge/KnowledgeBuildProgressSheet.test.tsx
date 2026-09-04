// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type {
  ArticleKnowledgeBuildAgentActivity,
  ArticleKnowledgeBuildJobResponse,
  ArticleKnowledgeBuildPhase,
  ArticleKnowledgeBuildResponse,
} from "@/lib/api"
import { KnowledgeBuildAgentActivity } from "./KnowledgeBuildAgentActivity"
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

function jobWithoutStages(
  status: ArticleKnowledgeBuildJobResponse["status"],
  percent: number,
  phase: ArticleKnowledgeBuildPhase = "retrying",
): ArticleKnowledgeBuildJobResponse {
  const base = processingJob()
  return {
    ...base,
    status,
    progress: {
      ...base.progress,
      percent,
      phase,
      stages: [],
      events: [],
      agentActivities: [],
    },
    result: null,
    error: status === "failed" ? "构建失败" : null,
    completedAt: status === "completed" || status === "failed" ? now : null,
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

  it("覆盖无任务、提交中和空运行记录状态", () => {
    const onOpenChange = vi.fn()
    const view = render(
      <KnowledgeBuildProgressSheet
        open
        onOpenChange={onOpenChange}
        articleName=""
        job={undefined}
        submitting={false}
        onRebuild={vi.fn()}
      />,
    )

    expect(screen.getByText("知识构建详情")).toBeTruthy()
    expect(screen.getByText("正在获取状态")).toBeTruthy()
    expect(screen.getByText("等待任务状态")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "运行记录" }))
    expect(screen.getByText("暂无阶段事件")).toBeTruthy()

    view.rerender(
      <KnowledgeBuildProgressSheet
        open
        onOpenChange={onOpenChange}
        articleName=""
        job={undefined}
        submitting
        onRebuild={vi.fn()}
      />,
    )
    expect(screen.getAllByText("正在提交").length).toBeGreaterThan(0)

    view.rerender(
      <KnowledgeBuildProgressSheet
        open={false}
        onOpenChange={onOpenChange}
        articleName=""
        job={undefined}
        submitting={false}
        onRebuild={vi.fn()}
      />,
    )
    view.rerender(
      <KnowledgeBuildProgressSheet
        open
        onOpenChange={onOpenChange}
        articleName=""
        job={undefined}
        submitting={false}
        onRebuild={vi.fn()}
      />,
    )
    expect(screen.queryByText("暂无阶段事件")).toBeNull()
  })

  it.each([96, 92, 80, 50, 10, 0])(
    "在缺少阶段明细时按 %i%% 推导回退阶段",
    (percent) => {
      render(
        <KnowledgeBuildProgressSheet
          open
          onOpenChange={vi.fn()}
          articleName="等待任务"
          job={jobWithoutStages("pending", percent)}
          submitting={false}
          onRebuild={vi.fn()}
        />,
      )

      expect(screen.getByText("等待重试")).toBeTruthy()
      expect(screen.getByLabelText(`知识构建进度 ${percent}%`)).toBeTruthy()
    },
  )

  it("展示失败阶段、全部子任务状态和无效事件时间", () => {
    const base = processingJob()
    const job: ArticleKnowledgeBuildJobResponse = {
      ...base,
      status: "failed",
      startedAt: "not-a-date",
      completedAt: now,
      error: "",
      progress: {
        ...base.progress,
        percent: 120,
        phase: "failed",
        message: "阶段失败",
        attempt: 0,
        total: 5,
        completed: 2,
        heartbeatAt: "not-a-date",
        agentActivities: [],
        stages: [{
          id: "unknown-stage",
          status: "failed",
          children: [
            { id: "failed-child", status: "failed", completed: undefined, total: 2 },
            { id: "pending-child", status: "pending", total: 0 },
            { id: "completed-child", status: "completed" },
            { id: "running-child", status: "running", completed: 1, total: 4 },
          ],
        }],
        events: [{
          id: "invalid-time",
          stageId: "unknown-stage",
          message: "失败事件",
          createdAt: "not-a-date",
        }],
      },
    }

    render(
      <KnowledgeBuildProgressSheet
        open
        onOpenChange={vi.fn()}
        articleName="失败任务"
        job={job}
        submitting={false}
        onRebuild={vi.fn()}
      />,
    )

    expect(screen.getByText("构建失败")).toBeTruthy()
    expect(screen.getAllByText("阶段失败").length).toBeGreaterThan(0)
    expect(screen.getByText("当前阶段")).toBeTruthy()
    expect(screen.getByText("0/2")).toBeTruthy()
    expect(screen.getByText("1/4")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /运行记录/ }))
    expect(screen.getByText("失败事件")).toBeTruthy()
    expect(screen.getByText("--:--:--")).toBeTruthy()
  })

  it("完成但有警告时展示部分完成和缺省统计", () => {
    const job = jobWithoutStages("completed", 100, "completed")
    job.startedAt = null
    job.result = {
      articleId: "7",
      knowledgeBaseId: "1",
      fromCache: false,
      chunkCount: 1,
      recommendedQuestionCount: 2,
      entityCount: 3,
      conceptCount: 4,
      sourcePage: {} as ArticleKnowledgeBuildResponse["sourcePage"],
      warnings: ["向量索引稍后补齐"],
    }

    render(
      <KnowledgeBuildProgressSheet
        open
        onOpenChange={vi.fn()}
        articleName="部分完成任务"
        job={job}
        submitting={false}
        onRebuild={vi.fn()}
      />,
    )

    expect(screen.getByText("部分完成")).toBeTruthy()
    expect(screen.getByText(/向量索引稍后补齐/)).toBeTruthy()
    expect(screen.getAllByText("0")).toHaveLength(2)
  })

  it("完成但尚无构建收据时保持完成状态", () => {
    render(
      <KnowledgeBuildProgressSheet
        open
        onOpenChange={vi.fn()}
        articleName="无收据任务"
        job={jobWithoutStages("completed", -5, "completed")}
        submitting={false}
        onRebuild={vi.fn()}
      />,
    )

    expect(screen.getByText("已完成")).toBeTruthy()
    expect(screen.queryByText("构建结果")).toBeNull()
    expect(screen.getByLabelText("知识构建进度 0%")).toBeTruthy()
  })
})

describe("KnowledgeBuildAgentActivity", () => {
  it("没有活动时不渲染时间线", () => {
    const { container } = render(<KnowledgeBuildAgentActivity activities={[]} />)
    expect(container.textContent).toBe("")
  })

  it("映射全部活动类型、失败细节和缺省字段", () => {
    const definitions: Array<{
      kind: ArticleKnowledgeBuildAgentActivity["kind"]
      status: ArticleKnowledgeBuildAgentActivity["status"]
      title: string
      detail?: string
      updatedAt?: string
    }> = [
      { kind: "lifecycle", status: "completed", title: "生命周期" },
      { kind: "plan", status: "completed", title: "规划" },
      { kind: "delegation", status: "completed", title: "委派" },
      { kind: "context", status: "completed", title: "上下文" },
      { kind: "retry", status: "completed", title: "重试" },
      { kind: "validation", status: "failed", title: "校验", detail: "校验未通过", updatedAt: "not-a-date" },
      { kind: "tool", status: "failed", title: "工具失败", detail: "   " },
      {
        kind: "unknown" as ArticleKnowledgeBuildAgentActivity["kind"],
        status: "completed",
        title: "未知动作",
      },
    ]
    const activities = definitions.map((definition, index): ArticleKnowledgeBuildAgentActivity => ({
      id: `activity-${index}`,
      kind: definition.kind,
      status: definition.status,
      title: definition.title,
      detail: definition.detail,
      agentName: index === 1 ? "主 Agent" : undefined,
      toolName: index === 6 ? "read_file" : undefined,
      round: index === 2 ? 2 : undefined,
      createdAt: now,
      updatedAt: definition.updatedAt ?? "",
    }))

    render(<KnowledgeBuildAgentActivity activities={activities} />)

    for (const definition of definitions) {
      expect(screen.getAllByText(definition.title).length).toBeGreaterThan(0)
    }
    for (const label of ["Agent", "计划", "委派", "上下文", "重试", "校验", "工具", "动作"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
    expect(screen.getByText("8 条")).toBeTruthy()
    expect(screen.getByText("未完成 · 校验未通过")).toBeTruthy()
    expect(screen.getByText("未完成")).toBeTruthy()
    expect(screen.getByText("--:--:--")).toBeTruthy()
    expect(screen.getByText("主 Agent")).toBeTruthy()
    expect(screen.getByText("第 2 轮")).toBeTruthy()
    expect(screen.getByText("read_file")).toBeTruthy()
    expect(screen.getByText("ADK 执行动态已更新")).toBeTruthy()
  })
})
