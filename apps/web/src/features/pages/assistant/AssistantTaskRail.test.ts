import { describe, expect, it } from "vitest"

import { settleLiveTask, type AssistantLiveTask } from "./AssistantTaskRail"

function sampleTask(overrides?: Partial<AssistantLiveTask>): AssistantLiveTask {
  return {
    id: "plan-1",
    title: "统计知识库",
    source: "plan",
    steps: [
      { id: "1", label: "概览", status: "completed" },
      { id: "2", label: "列表", status: "in_progress" },
      { id: "3", label: "汇总", status: "pending" },
    ],
    ...overrides,
  }
}

describe("settleLiveTask", () => {
  it("运行中不改状态", () => {
    const task = sampleTask()
    expect(settleLiveTask(task, true)).toEqual(task)
  })

  it("流结束后把 in_progress 收成 completed、pending 收成 cancelled", () => {
    expect(settleLiveTask(sampleTask(), false).steps.map((s) => s.status)).toEqual([
      "completed",
      "completed",
      "cancelled",
    ])
  })

  it("已有 failed 时 in_progress 收成 cancelled", () => {
    const task = sampleTask({
      steps: [
        { id: "1", label: "概览", status: "failed" },
        { id: "2", label: "列表", status: "in_progress" },
        { id: "3", label: "汇总", status: "pending" },
      ],
    })
    expect(settleLiveTask(task, false).steps.map((s) => s.status)).toEqual([
      "failed",
      "cancelled",
      "cancelled",
    ])
  })
})
