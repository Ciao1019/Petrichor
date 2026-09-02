import type { AgentStreamEvent } from "@/features/agent-runs/types"
import { afterEach, describe, expect, it, vi } from "vitest"

import { demoAssistantChatResponse } from "./demo-chat"

interface StreamPart {
  type?: string
  toolName?: string
  delta?: string
  data?: unknown
}

async function runDemoQuestion(question: string) {
  vi.useFakeTimers()
  const response = await demoAssistantChatResponse({
    body: JSON.stringify({
      messages: [{ role: "user", parts: [{ type: "text", text: question }] }],
    }),
  })
  const bodyPromise = response.text()
  await vi.runAllTimersAsync()
  const body = await bodyPromise
  const parts = body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as StreamPart)
  const events = parts
    .filter((part) => part.type === "data-agent-event")
    .map((part) => part.data)
    .filter((event): event is AgentStreamEvent => Boolean(event && typeof event === "object"))

  return {
    answer: events
      .filter((event) => event.type === "final_answer_delta")
      .map((event) => String(event.payload.delta ?? ""))
      .join(""),
    events,
    streamToolNames: parts
      .filter((part) => part.type === "tool-input-start")
      .map((part) => part.toolName ?? ""),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("demoAssistantChatResponse", () => {
  it("用当前 Agent 事件链回答 Mole 问题并产生可追溯证据", async () => {
    const result = await runDemoQuestion("Mole 第一次清理前需要注意什么？")
    const eventTypes = result.events.map((event) => event.type)
    const toolIds = result.events
      .filter((event) => event.type === "tool_started")
      .map((event) => event.payload.toolId)

    expect(eventTypes).toContain("agent_started")
    expect(eventTypes).toContain("complexity_detected")
    expect(eventTypes).toContain("evidence_created")
    expect(eventTypes).toContain("final_answer_completed")
    expect(eventTypes.at(-1)).toBe("agent_completed")
    expect(toolIds).toEqual(["knowledge.lookup"])
    expect(result.streamToolNames).toEqual(["lookup_knowledge"])
    expect(result.answer).toContain("mo clean --dry-run")
    expect(result.answer).toContain("mo clean --whitelist")
    expect(result.answer).not.toContain("答不了开放问题")
  })

  it("不再为旧的盘点提示生成 upsert_plan 或旧 Plan 侧栏事件", async () => {
    const result = await runDemoQuestion("把盘点我的知识库现状拆成可见计划，再逐步执行。")

    expect(result.streamToolNames).toEqual(["list_system_overview"])
    expect(result.streamToolNames).not.toContain("upsert_plan")
    expect(result.events.map((event) => event.type)).not.toContain("plan_created")
    expect(result.answer).toContain("当前共有")
  })

  it("文档检索通过技能与结构化活动事件回放", async () => {
    const result = await runDemoQuestion("在文档库里找找最近值得复习的内容。")

    expect(result.events.some((event) => event.type === "skill_loaded")).toBe(true)
    expect(result.streamToolNames).toEqual(["search_documents", "read_document", "read_document"])
    expect(result.answer).toContain("Mole 命令速查")
    expect(result.answer).toContain("Fastfetch 模块清单")
  })
})
