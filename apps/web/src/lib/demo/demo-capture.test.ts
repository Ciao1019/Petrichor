import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { CaptureJob } from "@/lib/api-capture"
import { defaultCaptureOptions } from "@/features/pages/inbox/capture/capture-utils"

beforeEach(() => { vi.resetModules(); vi.useFakeTimers() })
afterEach(() => vi.useRealTimers())

async function setup() {
  const { resolveCaptureDemoHandler } = await import("./demo-capture")
  const { resolveInboxDemoHandler } = await import("./demo-inbox")
  const call = (path: string, body: Record<string, unknown> = {}) => resolveCaptureDemoHandler(`POST /inbox/capture/${path}`)!(body)
  const save = (id: string) => resolveInboxDemoHandler("POST /inbox/create")!({ clientId: `note-${id}`, contentMd: "保存来源", captureIds: [id] })
  const input = { clientId: "demo-discard", urls: ["https://example.com/article"], options: defaultCaptureOptions }
  const { jobs } = call("create", input).data as { jobs: CaptureJob[] }
  return { call, save, input, id: jobs[0]!.id }
}

it("删除后列表和重复提示消失，额度不返还，旧请求与来源不能复活", async () => {
  const { call, save, input, id } = await setup()
  vi.advanceTimersByTime(2000)
  call("result", { id })
  expect(call("lookup", { urls: input.urls }).data).toMatchObject({ rows: [expect.objectContaining({ id })] })
  expect(call("delete", { id }).status).toBeUndefined()
  expect(call("delete", { id }).status).toBeUndefined()
  expect(call("list").data).toEqual({ rows: [], total: 0 })
  expect(call("lookup", { urls: input.urls }).data).toEqual({ rows: [] })
  expect(call("config").data).toMatchObject({ used: 1 })
  expect(call("result", { id }).status).toBe(400)
  expect(call("create", input).status).toBe(400)
  expect(call("regenerate", { id }).status).toBe(400)
  expect(save(id).status).toBe(400)
})

it("已保存来源拒绝删除；正在运行的任务可以直接丢弃", async () => {
  const { call, save, input, id } = await setup()
  vi.advanceTimersByTime(2000)
  expect(save(id).status).toBeUndefined()
  expect(call("delete", { id }).status).toBe(400)
  const created = call("create", { ...input, clientId: "still-running" }).data as { jobs: CaptureJob[] }
  expect(call("delete", { id: created.jobs[0]!.id }).status).toBeUndefined()
  expect(call("list").data).toMatchObject({ total: 1, rows: [expect.objectContaining({ id, saved: true })] })
})
