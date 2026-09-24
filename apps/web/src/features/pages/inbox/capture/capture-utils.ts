import type { CaptureJob, CaptureOptions, CaptureResult } from "@/lib/api-capture"

export const defaultCaptureOptions: CaptureOptions = { mode: "read", engine: "none", focus: "", language: "zh", screenshot: false, fullPage: true, mainContent: true, fresh: false, mobile: false, loading: "auto", includeTags: [], excludeTags: [] }
// 旧草稿保留网址与整理意图；采集器参数统一回到正文采集的默认值。
export function simpleCaptureOptions(options?: Partial<CaptureOptions>): CaptureOptions {
  return { ...defaultCaptureOptions, engine: options?.engine === "model" || options?.engine === "firecrawl" ? options.engine : "none" }
}
export const captureStates: Record<CaptureJob["state"], string> = { queued: "排队中", scraping: "正在采集", processing: "正在整理", ready: "可保存", partial: "部分完成", failed: "采集失败", cancelled: "已取消" }
export const captureBusy = (job: CaptureJob) => ["queued", "scraping", "processing"].includes(job.state)
export function parseCaptureURLs(text: string, limit: number): string[] {
  const urls = [...new Set(text.split(/\s+/).filter(Boolean).map((raw) => {
    let url: URL
    try { url = new URL(raw) } catch { throw new Error(`网址格式不正确：${raw.slice(0,80)}`) }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("请输入不含账号密码的 HTTP(S) 网址")
    url.hash = ""
    return url.toString()
  }))]
  if (!urls.length || urls.length > limit) throw new Error(`每次请输入 1 到 ${limit} 个网址`)
  return urls
}
export const sourceHost = (value: string) => { try { return new URL(value).hostname } catch { return value } }
export const markdownLink = (url: string) => url.replace(/[<>\s()]/g, (char) => encodeURIComponent(char))
export interface CaptureSelection { summary: boolean; takeaways: boolean; quotes: boolean; original: boolean; assets: string[]; links: string[] }
export function initialSelection(r: CaptureResult): CaptureSelection { return { summary: true, takeaways: true, quotes: true, original: !r.note.summary && !r.note.quotes.length && Array.from(r.markdown).length < 17000, assets: [], links: [] } }
export function buildCaptureMarkdown(r: CaptureResult, selection: CaptureSelection, thought: string): string {
  const onlyOriginal = selection.original && !(selection.summary && r.note.summary) && !(selection.takeaways && r.note.takeaways.length) && !(selection.quotes && r.note.quotes.length)
  const blocks = onlyOriginal && /^#{1,6}\s/.test(r.markdown.trimStart()) ? [] : [`## ${r.note.title.replace(/[\r\n]/g, " ")}`]
  if (selection.summary && r.note.summary) blocks.push(`### AI 摘要\n\n${r.note.summary}`)
  if (selection.takeaways && r.note.takeaways.length) blocks.push(`### 关键要点\n\n${r.note.takeaways.map((s) => `- ${s}`).join("\n")}`)
  if (selection.quotes && r.note.quotes.length) blocks.push(`### 摘录\n\n${r.note.quotes.map((q) => `${q.text.split("\n").map((line) => `> ${line}`).join("\n")}\n\n${q.line > 0 ? `原文第 ${q.line} 行` : "AI 返回片段，未匹配到原文；请核对"}`).join("\n\n")}`)
  if (selection.original) blocks.push(onlyOriginal ? r.markdown : `### 原文\n\n${r.markdown}`)
  for (const a of r.assets) if (selection.assets.includes(a.id) && a.key) blocks.push(`![${a.kind === "screenshot" ? "网页快照" : "网页素材"}](s4key:${a.key})`)
  if (selection.links.length) blocks.push(`### 参考链接\n\n${selection.links.map((url) => `- <${markdownLink(url)}>`).join("\n")}`)
  if (thought.trim()) blocks.push(`### 我的想法\n\n${thought.trim()}`)
  blocks.push(`来源：<${markdownLink(r.url)}>\n\n采集于 ${new Date(r.fetchedAt).toLocaleString("zh-CN")}${r.cachedAt ? `（复用 ${new Date(r.cachedAt).toLocaleString("zh-CN")} 的缓存）` : ""}`)
  return blocks.join("\n\n")
}
export function downloadMarkdown(content: string, title: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }))
  const a = document.createElement("a"); a.href = url; a.download = `${title.replace(/[\\/:*?"<>|]/g, "-").slice(0,80) || "网页原文"}.md`; a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
