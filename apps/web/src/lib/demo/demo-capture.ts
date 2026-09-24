import type { CaptureJob, CaptureOptions, CaptureResult } from "@/lib/api-capture"
import type { InboxNote } from "@/lib/api-inbox"
import type { DemoHandler, DemoHandlerResult } from "./demo-adapter"

// 仅 /demo 使用的演示数据。所有提示明确标记，不调用真实服务或产生费用。
const jobs = new Map<string, CaptureJob>()
const deleted = new Set<string>()
const requests = new Map<string, string[]>()
const ok = (data: unknown): DemoHandlerResult => ({ data: structuredClone(data) })
const fail = (msg: string): DemoHandlerResult => ({ status: 400, data: { code: 400, msg } })
function advance(job: CaptureJob) {
  if (!["queued", "scraping", "processing"].includes(job.state)) return job
  const elapsed = Date.now() - new Date(job.createdAt).getTime()
  job.state = elapsed > 1800 ? "ready" : elapsed > 900 ? "processing" : "scraping"
  return job
}
function result(url: string, options: CaptureOptions): CaptureResult {
  const markdown = "# 从阅读到自己的笔记\n\n收藏只是开始，理解需要自己的参与。\n\n记录摘要，留下关键观点，再写一句自己的思考。保留网页来源，方便回看原始上下文。\n\n网页内容会更新，因此将原文快照和自己的笔记分开保存。"
  return { markdown, note: { title: "从阅读到自己的笔记（演示）", summary: options.mode === "read" && options.engine !== "none" ? "把值得回看的网页整理成笔记：保留摘要、关键观点和原文来源，再补充自己的理解。" : "", takeaways: options.mode === "read" && options.engine !== "none" ? ["采集与个人创作相结合。", "原文快照独立保留，便于追溯。"] : [], tags: ["阅读", "网页采集"], quotes: options.mode === "quote" ? [{ text: "收藏只是开始，理解需要自己的参与。", line: 3 }] : [] }, assets: [], links: ["https://docs.firecrawl.dev/features/scrape", "https://github.com/firecrawl/firecrawl"], warnings: ["演示数据：没有访问输入的网址，不产生采集或模型费用。"], url, finalUrl: url, language: "zh", fetchedAt: new Date().toISOString(), statusCode: 200, credits: 0, inputTokens: 0, outputTokens: 0, hash: "demo" }
}
const handlers: Record<string, DemoHandler> = {
  "POST /inbox/capture/lookup": (body) => ok({ rows: [...jobs.values()].filter((j) => !deleted.has(j.id) && Array.isArray(body.urls) && body.urls.includes(j.url) && ["ready", "partial"].includes(j.state)).reverse() }),
  "POST /inbox/capture/config": () => ok({ enabled: true, screenshot: true, actions: true, aiFormats: true, modelReady: true, maxBatch: 10, dailyLimit: 50, used: jobs.size }),
  "POST /inbox/capture/list": (body) => { const all = [...jobs.values()].filter((job) => !deleted.has(job.id)).map(advance).reverse(); const page = Math.max(1, Number(body.pageNum) || 1); return ok({ rows: all.slice((page - 1) * 20, page * 20).map(({ result: _result, ...job }) => job), total: all.length }) },
  "POST /inbox/capture/create": (body) => {
    if (typeof body.clientId !== "string" || !Array.isArray(body.urls) || !body.urls.length || body.urls.length > 10 || !body.options) return fail("采集参数无效")
    const existing = requests.get(body.clientId); if (existing) return existing.some((id) => deleted.has(id)) ? fail("这次采集已删除，请重新发起采集") : ok({ jobs: existing.map((id) => jobs.get(id)) })
    const options = body.options as CaptureOptions
    const created: CaptureJob[] = []
    for (const raw of body.urls) { if (typeof raw !== "string" || !/^https?:\/\//.test(raw)) return fail("网址格式无效") }
    for (const raw of body.urls as string[]) {
      const id = crypto.randomUUID(); const now = new Date().toISOString()
      const r = result(raw, options); if (body.previousId) { r.diff = "内容未变化（演示）"; r.change = "unchanged" }
      const job: CaptureJob = { id, url: raw, options, state: "queued", title: r.note.title, error: "", previousId: typeof body.previousId === "string" ? body.previousId : null, createdAt: now, updatedAt: now, saved: false, result: r }
      jobs.set(id, job); created.push(job)
    }
    requests.set(body.clientId, created.map((job) => job.id)); return ok({ jobs: created })
  },
  "POST /inbox/capture/result": (body) => { const job = jobs.get(String(body.id)); return job && !deleted.has(job.id) ? ok(advance(job)) : fail("演示任务不存在，刷新页面会重置演示记录") },
  "POST /inbox/capture/delete": (body) => {
    const job = jobs.get(String(body.id))
    if (!job) return fail("采集记录不存在")
    if (job.saved) return fail("该来源已保存到随笔或文章，不能删除")
    deleted.add(job.id)
    if (["queued", "scraping", "processing"].includes(job.state)) job.state = "cancelled"
    return ok({ success: true })
  },
  "POST /inbox/capture/cancel": (body) => { const job = jobs.get(String(body.id)); if (!job || deleted.has(job.id)) return fail("任务不存在"); job.state = "cancelled"; job.error = "演示任务已取消"; return ok({ success: true }) },
  "POST /inbox/capture/regenerate": (body) => { const source = jobs.get(String(body.id)); if (!source || deleted.has(source.id)) return fail("任务不存在"); const options = { ...source.options, engine: "model" as const }; const copy: CaptureJob = { ...source, id: crypto.randomUUID(), state: "processing", createdAt: new Date().toISOString(), saved: false, options, result: result(source.url, options) }; jobs.set(copy.id, copy); return ok(copy) },
}
export const resolveCaptureDemoHandler = (key: string) => handlers[key]
export function captureDemoSources(ids: unknown): NonNullable<InboxNote["sources"]> {
  if (!Array.isArray(ids)) return []
  return ids.flatMap((id) => { const job = jobs.get(String(id)); if (!job || deleted.has(job.id)) return []; job.saved = true; return [{ id: job.id, url: job.url, title: job.title, createdAt: job.createdAt }] })
}

export function validCaptureDemoSources(ids: unknown): boolean {
  return ids === undefined || (Array.isArray(ids) && ids.length <= 20 && ids.every((id) => {
    const job = typeof id === "string" ? jobs.get(id) : undefined
    return job && !deleted.has(job.id) && ["ready", "partial"].includes(advance(job).state)
  }))
}
