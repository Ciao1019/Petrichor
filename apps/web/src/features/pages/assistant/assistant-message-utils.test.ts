import { afterEach, describe, expect, it, vi } from "vitest"
import type { AssistantThreadSummary } from "@/lib/api"
import {
  asRecord,
  asRows,
  deriveQaTocText,
  extractLatestAssistantUsage,
  extractPersistedMessageMetadata,
  extractPersistedParts,
  extractTextFromContent,
  firstTextOfParts,
  focusFromThread,
  focusToRequestBody,
  formatCompactTokens,
  formatContextWindow,
  formatRelativeTime,
  formatStreamMs,
  formatStreamTime,
  groupThreadsByRecency,
  isPresent,
  isSameLocalDay,
  normalizeAssistantPersistedContent,
  normalizeUsageRecord,
  parseLegacyDocumentHref,
  readPersistedTiming,
  readSubAgentUsage,
  resolveApiErrorMessage,
  sanitizeUIMessagePart,
  stripInlineMarkdown,
  threadRecencyKey,
  toInitialMessages,
  toInternalAppPath,
  toolStatusLabel,
} from "./assistant-message-utils"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("assistant message 基础归一化", () => {
  it("转换焦点并读取会话时间", () => {
    expect(focusToRequestBody({ kind: "knowledge", knowledgeBaseId: "1" })).toEqual({ knowledgeBaseId: "1" })
    expect(focusToRequestBody({ kind: "doc_library", libraryId: "2" })).toEqual({ libraryId: "2" })
    expect(focusToRequestBody({ kind: "none" })).toBeNull()
    expect(focusFromThread({ knowledgeBaseId: "3" })).toEqual({ kind: "knowledge", knowledgeBaseId: "3" })
    expect(focusFromThread({ libraryId: "4" })).toEqual({ kind: "doc_library", libraryId: "4" })
    expect(focusFromThread(null)).toEqual({ kind: "none" })
    expect(threadRecencyKey({ updatedAt: "u", createdAt: "c" } as AssistantThreadSummary)).toBe("u")
    expect(threadRecencyKey({ updatedAt: "", createdAt: "c" } as AssistantThreadSummary)).toBe("c")
  })

  it("安全读取对象和数组", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
    expect(asRecord(null)).toBeNull()
    expect(asRecord([])).toBeNull()
    expect(isPresent(0)).toBe(true)
    expect(isPresent(null)).toBe(false)
    expect(asRows([{ a: 1 }, null, []])).toEqual([{ a: 1 }])
    expect(asRows({ rows: [{ b: 2 }, "bad"] }, "rows")).toEqual([{ b: 2 }])
    expect(asRows({ rows: "bad" }, "rows")).toEqual([])
    expect(asRows("bad")).toEqual([])
  })

  it("只接受站内路径并兼容旧文档链接", () => {
    expect(toInternalAppPath("/dashboard?a=1")).toBe("/dashboard?a=1")
    expect(toInternalAppPath("//evil.example/x")).toBe(false)
    expect(toInternalAppPath("")).toBe(false)
    expect(toInternalAppPath("relative")).toBe(false)
    vi.stubGlobal("window", { location: { origin: "https://app.example" } })
    expect(toInternalAppPath("https://app.example/a?q=1#x")).toBe("/a?q=1#x")
    expect(toInternalAppPath("https://evil.example/a")).toBe(false)
    expect(toInternalAppPath("http://[")).toBe(false)
    expect(parseLegacyDocumentHref("/document/42")).toBe("42")
    expect(parseLegacyDocumentHref("/document/nope")).toBeNull()
    expect(parseLegacyDocumentHref("http://[")).toBeNull()
    expect(parseLegacyDocumentHref("")).toBeNull()
  })
})

describe("时间、状态和错误文案", () => {
  it("覆盖相对时间的全部区间", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-31T12:00:00Z"))
    expect(formatRelativeTime(null)).toBe("")
    expect(formatRelativeTime("bad")).toBe("")
    expect(formatRelativeTime("2026-01-31T11:59:30Z")).toBe("刚刚")
    expect(formatRelativeTime("2026-01-31T11:30:00Z")).toBe("30 分钟前")
    expect(formatRelativeTime("2026-01-31T10:00:00Z")).toBe("2 小时前")
    expect(formatRelativeTime("2026-01-28T12:00:00Z")).toBe("3 天前")
    expect(formatRelativeTime("2025-12-01T12:00:00Z")).not.toBe("")
  })

  it("格式化工具状态、错误和流耗时", () => {
    expect(toolStatusLabel({ type: "running" })).toBe("运行中")
    expect(toolStatusLabel({ type: "incomplete", reason: "error" })).toBe("未完成")
    expect(toolStatusLabel({ type: "requires-action", reason: "interrupt" })).toBe("待操作")
    expect(toolStatusLabel()).toBe("完成")
    expect(resolveApiErrorMessage({ response: { data: { msg: "接口错误" } } }, "默认")).toBe("接口错误")
    expect(resolveApiErrorMessage({ response: { data: { msg: 1 } } }, "默认")).toBe("默认")
    expect(resolveApiErrorMessage(new Error("异常"), "默认")).toBe("异常")
    expect(resolveApiErrorMessage({}, "默认")).toBe("默认")
    expect(formatStreamTime(undefined)).toBeNull()
    expect(formatStreamTime(999.4)).toBe("999ms")
    expect(formatStreamTime(1500)).toBe("1.5s")
    expect(formatStreamMs(undefined)).toBe("—")
    expect(formatStreamMs(500.2)).toBe("500ms")
    expect(formatStreamMs(1234)).toBe("1.23s")
  })
})

describe("会话分组", () => {
  it("覆盖今天到更早以及非法日期", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 2, 20, 12, 0, 0))
    const make = (id: string, updatedAt: string | null) => ({
      id,
      title: id,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt,
    }) as AssistantThreadSummary
    const threads = [
      make("today", new Date(2026, 2, 20, 8).toISOString()),
      make("yesterday", new Date(2026, 2, 19, 8).toISOString()),
      make("week", new Date(2026, 2, 16, 8).toISOString()),
      make("month", new Date(2026, 2, 5, 8).toISOString()),
      make("older", new Date(2025, 11, 1).toISOString()),
      make("invalid", "bad"),
      make("missing", null),
    ]
    const result = groupThreadsByRecency(threads)
    expect(result.groups.map((group) => group.key)).toEqual(["today", "yesterday", "week", "month", "older"])
    expect(result.totalShown).toBe(7)
    expect(result.groups.at(-1)?.threads).toHaveLength(3)
    expect(isSameLocalDay(new Date(2026, 2, 20, 1).getTime(), new Date(2026, 2, 20, 23).getTime())).toBe(true)
    expect(isSameLocalDay(new Date(2026, 2, 20).getTime(), new Date(2026, 2, 21).getTime())).toBe(false)
  })
})

describe("持久消息恢复", () => {
  it("恢复允许的消息、正文和 metadata", () => {
    const messages = toInitialMessages([
      { id: "1", role: "system", content: "skip" },
      { id: "2", role: "user", content: "hello" },
      {
        id: "3",
        role: "assistant",
        content: {
          parts: [{ type: "text", text: "answer" }],
          usage: { totalTokens: 3 },
          modelId: "m1",
        },
      },
    ])
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ id: "persisted-2", role: "user", parts: [{ type: "text", text: "hello" }] })
    expect(messages[1]).toMatchObject({ id: "persisted-3", metadata: { custom: { modelId: "m1" } } })
    expect(normalizeAssistantPersistedContent("text")).toBe("text")
    const content = { role: "assistant", parts: [] }
    expect(normalizeAssistantPersistedContent(content)).toBe(content)
  })

  it("提取正文、metadata 与合法 parts", () => {
    expect(extractTextFromContent("plain")).toBe("plain")
    expect(extractTextFromContent(1)).toBe("")
    expect(extractTextFromContent({ text: "direct" })).toBe("direct")
    expect(extractTextFromContent({ parts: [{ type: "text", text: "a" }, null, { type: "reasoning", text: "x" }, { type: "text", text: "b" }] })).toBe("a\nb")
    expect(extractPersistedParts(null)).toBeNull()
    expect(extractPersistedParts({ parts: [] })).toBeNull()
    expect(extractPersistedParts({ parts: [{ type: "unknown" }] })).toBeNull()
    expect(extractPersistedParts({ parts: [
      { type: "data-intent-route", data: 1 },
      { type: "text", text: "x" },
      { type: "data-intent-route", data: 2 },
    ] })).toEqual([{ type: "text", text: "x" }, { type: "data-intent-route", data: 2 }])
    expect(extractPersistedMessageMetadata(null)).toBeNull()
    expect(extractPersistedMessageMetadata({})).toBeNull()
    expect(extractPersistedMessageMetadata({
      usage: {}, modelId: "m", modelName: "M", firstTokenTime: 1, totalStreamTime: 2,
      totalChunks: 3, tokensPerSecond: 4, subAgentUsage: {}, ignored: true,
    })).toEqual({ custom: {
      usage: {}, modelId: "m", modelName: "M", firstTokenTime: 1, totalStreamTime: 2,
      totalChunks: 3, tokensPerSecond: 4, subAgentUsage: {},
    } })
  })

  it("清洗所有 part 类型和流式工具状态", () => {
    expect(sanitizeUIMessagePart(null)).toBeNull()
    expect(sanitizeUIMessagePart({})).toBeNull()
    expect(sanitizeUIMessagePart({ type: "text", text: 1 })).toBeNull()
    expect(sanitizeUIMessagePart({ type: "reasoning", text: "r" })).toEqual({ type: "reasoning", text: "r" })
    expect(sanitizeUIMessagePart({ type: "step-start", extra: 1 })).toEqual({ type: "step-start" })
    expect(sanitizeUIMessagePart({ type: "tool-search", state: "input-streaming", result: 3 })).toMatchObject({ state: "output-available", output: 3 })
    expect(sanitizeUIMessagePart({ type: "dynamic-tool", state: "input-available" })).toMatchObject({ state: "output-available" })
    expect(sanitizeUIMessagePart({ type: "tool-x", state: "output-error", output: null })).toMatchObject({ state: "output-error" })
    expect(sanitizeUIMessagePart({ type: "tool-x" })).toMatchObject({ state: "output-available" })
    for (const type of ["source-url", "source-document", "file", "data-custom"]) {
      expect(sanitizeUIMessagePart({ type, value: 1 })).toEqual({ type, value: 1 })
    }
    expect(sanitizeUIMessagePart({ type: "image" })).toBeNull()
  })
})

describe("用量和展示格式", () => {
  it("格式化上下文窗口和 token", () => {
    for (const value of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatContextWindow(value)).toBeNull()
    }
    expect(formatContextWindow(500)).toBe("500")
    expect(formatContextWindow(1000)).toBe("1K")
    expect(formatContextWindow(1500)).toBe("2K")
    expect(formatContextWindow(1_000_000)).toBe("1M")
    expect(formatContextWindow(1_500_000)).toBe("1.5M")
    expect(formatCompactTokens(999)).toBe("999")
    expect(formatCompactTokens(1500)).toBe("1.5k")
    expect(formatCompactTokens(1_500_000)).toBe("1.5M")
  })

  it("读取新旧 timing 和子代理用量", () => {
    expect(readPersistedTiming({ custom: { totalStreamTime: 1200, tokensPerSecond: 40, firstTokenTime: 200 } })).toEqual({
      firstTokenTime: 200, totalStreamTime: 1200, tokensPerSecond: 40, totalChunks: 0,
    })
    expect(readPersistedTiming({ timing: { totalStreamTime: 800, tokensPerSecond: 12.5, totalChunks: 3 } })).toEqual({
      firstTokenTime: undefined, totalStreamTime: 800, tokensPerSecond: 12.5, totalChunks: 3,
    })
    expect(readPersistedTiming({ totalStreamTime: 100, firstTokenTime: 20, tokensPerSecond: 2, totalChunks: 1 })).toEqual({
      firstTokenTime: 20, totalStreamTime: 100, tokensPerSecond: 2, totalChunks: 1,
    })
    expect(readPersistedTiming({ custom: { usage: {} } })).toBeUndefined()
    expect(readPersistedTiming(null)).toBeUndefined()
    expect(readSubAgentUsage(null)).toBeUndefined()
    expect(readSubAgentUsage({ custom: {} })).toBeUndefined()
    expect(readSubAgentUsage({ subAgentUsage: { calls: 0 } })).toBeUndefined()
    expect(readSubAgentUsage({ subAgentUsage: { calls: 2, inputTokens: 3, outputTokens: 4 } })).toEqual({ calls: 2, totalTokens: 7 })
    expect(readSubAgentUsage({ custom: { subAgentUsage: { calls: 1, totalTokens: 9 } } })).toEqual({ calls: 1, totalTokens: 9 })
  })

  it("归一化并查找最新 assistant 用量", () => {
    expect(normalizeUsageRecord(null)).toBeUndefined()
    expect(normalizeUsageRecord({ nope: 1, inputTokens: -1, outputTokens: Number.NaN })).toBeUndefined()
    expect(normalizeUsageRecord({ inputTokens: 2, outputTokens: 3 })).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5 })
    expect(normalizeUsageRecord({ totalTokens: 10, reasoningTokens: 2, cachedInputTokens: 1 })).toEqual({ totalTokens: 10, reasoningTokens: 2, cachedInputTokens: 1 })
    expect(extractLatestAssistantUsage(null)).toBeUndefined()
    expect(extractLatestAssistantUsage([{ role: "user" }, null, { role: "assistant" }])).toBeUndefined()
    expect(extractLatestAssistantUsage([{ role: "assistant", metadata: { usage: { totalTokens: 3 } } }])).toEqual({ totalTokens: 3 })
    expect(extractLatestAssistantUsage([{ role: "assistant", metadata: { custom: { usage: { inputTokens: 1 } } } }])).toEqual({ inputTokens: 1 })
    expect(extractLatestAssistantUsage([{ role: "assistant", metadata: { content: { usage: { outputTokens: 2 } } } }])).toEqual({ outputTokens: 2 })
  })
})

describe("TOC 文案", () => {
  it("清理 Markdown 并提取第一段", () => {
    expect(stripInlineMarkdown(" # **标题** [链接](https://x) ![图](x) `code`  ")).toBe("标题 链接 图 code")
    expect(firstTextOfParts([null, { type: "reasoning", text: "x" }, { type: "text", text: "  " }, { type: "text", text: " ok " }])).toBe("ok")
    expect(firstTextOfParts([])).toBe("")
    expect(deriveQaTocText("user", "")).toBe("（空消息）")
    expect(deriveQaTocText("assistant", "")).toBe("AI 回答")
    expect(deriveQaTocText("assistant", "正文\n## **主标题**")).toBe("主标题")
    expect(deriveQaTocText("assistant", "```ts\ncode\n```\n普通首行")).toBe("code")
    expect(deriveQaTocText("assistant", "***")).toBe("AI 回答")
    expect(deriveQaTocText("user", "[问题](x)")).toBe("问题")
    expect(deriveQaTocText("user", "***")).toBe("（空消息）")
  })
})
