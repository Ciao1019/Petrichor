// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { useAgentRunsStore } from "@/features/agent-runs/store"
import type { AssistantUIMessage } from "@/features/pages/assistant/assistant-message-utils"
import {
  PUBLIC_QA_HISTORY_KEY,
  deletePublicQaThread,
  listPublicQaThreads,
  loadPublicQaThread,
  restoreRunsFromMessages,
  savePublicQaThread,
} from "./public-qa-history"

function event(sequence: number, type: string, payload: Record<string, unknown> = {}) {
  return { runId: "run-1", sequence, type, timestamp: 1_700_000_000_000 + sequence, payload }
}

function conversation(): AssistantUIMessage[] {
  return [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Mole 第一次清理应该怎么做？" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "data-agent-event", id: "run-1:1", data: event(1, "run_started", { goal: "Mole" }) },
        { type: "tool-search_knowledge", toolCallId: "t1", state: "output-available", input: { query: "Mole" }, output: { hits: [{ title: "大量检索输出" }] } },
        { type: "tool-show_citations", toolCallId: "t2", state: "output-available", input: {}, output: { citations: [] } },
        { type: "data-agent-event", id: "run-1:2", data: event(2, "final_answer_completed", { text: "先 dry-run 预览。" }) },
        { type: "data-agent-event", id: "run-1:3", data: event(3, "run_completed") },
        { type: "text", text: "先 dry-run 预览。" },
      ],
    },
  ] as unknown as AssistantUIMessage[]
}

beforeEach(() => {
  localStorage.clear()
  useAgentRunsStore.getState().reset()
})
afterEach(() => localStorage.clear())

describe("前台问答本地历史", () => {
  it("按首问生成标题，列表与后台历史同构，删除后消失", () => {
    savePublicQaThread({ id: "thread-1", knowledgeBaseId: "7", messages: conversation() })
    const [summary] = listPublicQaThreads()
    expect(summary).toMatchObject({ id: "thread-1", title: "Mole 第一次清理应该怎么做？", focus: { knowledgeBaseId: "7" } })
    deletePublicQaThread("thread-1")
    expect(listPublicQaThreads()).toEqual([])
    expect(loadPublicQaThread("thread-1")).toBeNull()
  })

  it("只保留回答内容类工具，检索过程的原始输出不写入浏览器", () => {
    savePublicQaThread({ id: "thread-1", knowledgeBaseId: null, messages: conversation() })
    const raw = localStorage.getItem(PUBLIC_QA_HISTORY_KEY) ?? ""
    expect(raw).not.toContain("大量检索输出")
    const parts = loadPublicQaThread("thread-1")?.messages[1]?.parts.map((part) => part.type)
    expect(parts).toContain("tool-show_citations")
    expect(parts).toContain("data-agent-event")
    expect(parts).not.toContain("tool-search_knowledge")
  })

  it("损坏或伪造的存储数据被忽略", () => {
    localStorage.setItem(PUBLIC_QA_HISTORY_KEY, JSON.stringify([{ id: 1 }, "x", { id: "ok", title: "t", updatedAt: "2026-09-23T00:00:00Z", knowledgeBaseId: null, messages: [] }]))
    expect(listPublicQaThreads().map((thread) => thread.id)).toEqual(["ok"])
    localStorage.setItem(PUBLIC_QA_HISTORY_KEY, "{not json")
    expect(listPublicQaThreads()).toEqual([])
  })

  it("按 Agent 事件重放恢复执行面板，并交给消息正文渲染答案", () => {
    restoreRunsFromMessages(conversation())
    const run = useAgentRunsStore.getState().runs["run-1"]
    expect(run?.lastSequence).toBe(3)
    expect(run?.hydrated).toBe(true)
    expect(run?.answer).toContain("dry-run")
  })
})
