import { describe, expect, it } from "vitest"
import type { SerializablePlan } from "@/components/tool-ui/plan/schema"

import {
  pickPersistedTaskForRail,
  resolveRailTask,
  settleLiveTask,
  type AssistantLiveTask,
} from "./AssistantTaskRail"

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

const incompletePlan: SerializablePlan = {
  id: "p-old",
  title: "旧计划",
  todos: [
    { id: "a", label: "A", status: "completed" },
    { id: "b", label: "B", status: "pending" },
  ],
}

const completePlan: SerializablePlan = {
  id: "p-done",
  title: "已完成",
  todos: [
    { id: "a", label: "A", status: "completed" },
    { id: "b", label: "B", status: "cancelled" },
  ],
}

describe("settleLiveTask", () => {
  it("运行中不改状态", () => {
    const task = sampleTask()
    expect(settleLiveTask(task, true)).toEqual(task)
  })

  it("流结束后若仍有未开始的 pending，则收口 in_progress / pending", () => {
    expect(settleLiveTask(sampleTask(), false).steps.map((s) => s.status)).toEqual([
      "completed",
      "completed",
      "cancelled",
    ])
  })

  it("只剩 in_progress、没有 pending 时留给用户收尾", () => {
    const task = sampleTask({
      steps: [
        { id: "1", label: "概览", status: "completed" },
        { id: "2", label: "列表", status: "completed" },
        { id: "3", label: "汇总", status: "in_progress" },
      ],
    })
    expect(settleLiveTask(task, false)).toEqual(task)
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

describe("pickPersistedTaskForRail", () => {
  it("跳过全完成计划，取最新未完成", () => {
    const task = pickPersistedTaskForRail([completePlan, incompletePlan])
    expect(task?.id).toBe("p-old")
    expect(task?.title).toBe("旧计划")
  })

  it("全部完成时返回 null", () => {
    expect(pickPersistedTaskForRail([completePlan])).toBeNull()
  })
})

describe("resolveRailTask", () => {
  it("live 优先于 persisted", () => {
    const live = sampleTask({ id: "live" })
    const persisted = sampleTask({ id: "persisted" })
    expect(resolveRailTask({
      liveTask: live,
      persistedTask: persisted,
      sawLiveThisMount: true,
    })?.id).toBe("live")
  })

  it("本轮无 live 时冷启动回落 persisted", () => {
    const persisted = sampleTask({ id: "persisted" })
    expect(resolveRailTask({
      liveTask: null,
      persistedTask: persisted,
      sawLiveThisMount: false,
    })?.id).toBe("persisted")
  })

  it("本轮曾有 live 后不再回落 persisted", () => {
    expect(resolveRailTask({
      liveTask: null,
      persistedTask: sampleTask({ id: "persisted" }),
      sawLiveThisMount: true,
    })).toBeNull()
  })
})
