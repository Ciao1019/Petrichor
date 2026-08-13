import { describe, expect, it } from "vitest"

import type { KBSpanNode } from "@/lib/api"
import {
  buildAxisTicks,
  computeTraceWindow,
  countFinishedStages,
  flattenTrace,
  formatDuration,
  spanLabel,
  summarizePostprocess,
} from "@/components/knowledge/pipeline-trace"

const BASE = Date.parse("2026-08-13T10:00:00.000Z")

function iso(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString()
}

function node(partial: Partial<KBSpanNode> & Pick<KBSpanNode, "spanId" | "name" | "kind" | "status">): KBSpanNode {
  return { durationMs: 0, ...partial }
}

/** 一棵典型的流水线：根 → 两个阶段，多模态下挂两个并行的识别子任务。 */
function sampleTrace(): KBSpanNode {
  return node({
    spanId: "root",
    name: "document_processing",
    kind: "root",
    status: "done",
    startedAt: iso(0),
    finishedAt: iso(10_000),
    durationMs: 10_000,
    children: [
      node({
        spanId: "extract",
        name: "extract",
        kind: "stage",
        status: "done",
        startedAt: iso(0),
        finishedAt: iso(2_000),
        durationMs: 2_000,
      }),
      node({
        spanId: "multimodal",
        name: "multimodal",
        kind: "stage",
        status: "done",
        startedAt: iso(2_000),
        finishedAt: iso(10_000),
        durationMs: 8_000,
        children: [
          node({
            spanId: "page0",
            name: "multimodal.page[1]",
            kind: "generation",
            status: "done",
            startedAt: iso(2_000),
            finishedAt: iso(6_000),
            durationMs: 4_000,
          }),
          node({
            spanId: "page1",
            name: "multimodal.page[2]",
            kind: "generation",
            status: "failed",
            startedAt: iso(2_000),
            finishedAt: iso(10_000),
            durationMs: 8_000,
          }),
        ],
      }),
    ],
  })
}

describe("computeTraceWindow", () => {
  it("覆盖整棵树的起止时间", () => {
    const window = computeTraceWindow(sampleTrace(), BASE + 10_000)
    expect(window).not.toBeNull()
    expect(window?.start).toBe(BASE)
    expect(window?.totalMs).toBe(10_000)
  })

  it("进行中的行用当前时间当作右端，条形才会随时间生长", () => {
    const trace = node({
      spanId: "root",
      name: "document_processing",
      kind: "root",
      status: "running",
      startedAt: iso(0),
    })
    const window = computeTraceWindow(trace, BASE + 5_000)
    expect(window?.totalMs).toBe(5_000)
  })

  it("没有任何时间戳时返回 null", () => {
    expect(computeTraceWindow(node({ spanId: "root", name: "x", kind: "root", status: "pending" }))).toBeNull()
  })
})

describe("flattenTrace", () => {
  it("按层级摊平并按同一时间轴换算位置", () => {
    const trace = sampleTrace()
    const window = computeTraceWindow(trace, BASE + 10_000)
    const rows = flattenTrace(trace, new Set(), window, BASE + 10_000)

    expect(rows.map((row) => row.node.spanId)).toEqual(["root", "extract", "multimodal", "page0", "page1"])
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 1, 2, 2])

    const multimodal = rows.find((row) => row.node.spanId === "multimodal")
    expect(multimodal?.offsetRatio).toBeCloseTo(0.2)
    expect(multimodal?.widthRatio).toBeCloseTo(0.8)
    expect(multimodal?.indeterminate).toBe(false)
  })

  it("折叠的节点不展开其子树", () => {
    const trace = sampleTrace()
    const window = computeTraceWindow(trace, BASE + 10_000)
    const rows = flattenTrace(trace, new Set(["multimodal"]), window, BASE + 10_000)
    expect(rows.map((row) => row.node.spanId)).toEqual(["root", "extract", "multimodal"])
  })

  it("没有结束时间的行标记为时长未知", () => {
    const trace = node({
      spanId: "root",
      name: "document_processing",
      kind: "root",
      status: "pending",
      children: [node({ spanId: "extract", name: "extract", kind: "stage", status: "pending" })],
    })
    const rows = flattenTrace(trace, new Set(), null)
    expect(rows.every((row) => row.indeterminate)).toBe(true)
  })
})

describe("countFinishedStages", () => {
  it("跳过与取消也算这一段有了结论", () => {
    const trace = node({
      spanId: "root",
      name: "document_processing",
      kind: "root",
      status: "running",
      children: [
        node({ spanId: "a", name: "extract", kind: "stage", status: "done" }),
        node({ spanId: "b", name: "chunking", kind: "stage", status: "skipped" }),
        node({ spanId: "c", name: "embedding", kind: "stage", status: "cancelled" }),
        node({ spanId: "d", name: "multimodal", kind: "stage", status: "running" }),
        node({ spanId: "e", name: "postprocess", kind: "stage", status: "pending" }),
      ],
    })
    expect(countFinishedStages(trace)).toEqual({ done: 3, total: 5 })
  })
})

describe("summarizePostprocess", () => {
  it("只统计叶子任务，避免父节点被重复计入", () => {
    const trace = node({
      spanId: "root",
      name: "document_processing",
      kind: "root",
      status: "running",
      children: [
        node({
          spanId: "post",
          name: "postprocess",
          kind: "stage",
          status: "running",
          children: [
            node({
              spanId: "question",
              name: "postprocess.question",
              kind: "subspan",
              status: "running",
              children: [
                node({ spanId: "b0", name: "postprocess.question.batch[0]", kind: "generation", status: "done" }),
                node({ spanId: "b1", name: "postprocess.question.batch[1]", kind: "generation", status: "failed" }),
                node({ spanId: "b2", name: "postprocess.question.batch[2]", kind: "generation", status: "running" }),
              ],
            }),
            node({ spanId: "summary", name: "postprocess.summary", kind: "generation", status: "done" }),
          ],
        }),
      ],
    })
    expect(summarizePostprocess(trace)).toEqual({ running: 1, failed: 1, completed: 2, total: 4 })
  })

  it("没有后处理阶段时全为 0", () => {
    expect(summarizePostprocess(node({ spanId: "root", name: "x", kind: "root", status: "pending" }))).toEqual({
      running: 0,
      failed: 0,
      completed: 0,
      total: 0,
    })
  })
})

describe("formatDuration", () => {
  it("按量级切换单位", () => {
    expect(formatDuration(9)).toBe("9ms")
    expect(formatDuration(4_490)).toBe("4.49s")
    expect(formatDuration(79_600)).toBe("1m19.6s")
    expect(formatDuration(-1)).toBe("-")
  })
})

describe("spanLabel", () => {
  it("阶段显示中文名，子任务保留原始 span 名", () => {
    expect(spanLabel(node({ spanId: "a", name: "multimodal", kind: "stage", status: "done" }))).toBe("多模态识别")
    expect(spanLabel(node({ spanId: "b", name: "document_processing", kind: "root", status: "done" }))).toBe("知识处理")
    expect(spanLabel(node({ spanId: "c", name: "multimodal.page[3]", kind: "generation", status: "done" }))).toBe(
      "multimodal.page[3]"
    )
  })
})

describe("buildAxisTicks", () => {
  it("生成 0 起点加等分刻度", () => {
    const ticks = buildAxisTicks(10_000, 2)
    expect(ticks.map((tick) => tick.label)).toEqual(["0ms", "5.00s", "10.00s"])
  })

  it("总时长为 0 时只有起点", () => {
    expect(buildAxisTicks(0)).toEqual([{ ratio: 0, label: "0ms" }])
  })
})
