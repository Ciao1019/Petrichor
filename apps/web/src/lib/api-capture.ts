import { api } from "@/lib/api-client"

export type CaptureMode = "read" | "quote" | "assets"
export interface CaptureOptions {
  mode: CaptureMode
  engine: "model" | "firecrawl" | "none"
  focus: string
  language: "zh" | "original"
  screenshot: boolean
  fullPage: boolean
  mainContent: boolean
  fresh: boolean
  mobile: boolean
  loading: "auto" | "wait" | "scroll"
  includeTags: string[]
  excludeTags: string[]
}
export interface CaptureConfig { enabled: boolean; screenshot: boolean; actions: boolean; aiFormats: boolean; modelReady: boolean; maxBatch: number; dailyLimit: number; used: number }
export interface CaptureAsset { id: string; sourceUrl: string; key?: string; url?: string; kind: "image" | "screenshot"; error?: string }
export interface CaptureResult {
  markdown: string
  note: { title: string; summary: string; takeaways: string[]; tags: string[]; quotes: { text: string; line: number }[] }
  assets: CaptureAsset[]
  links: string[]
  warnings: string[]
  url: string
  finalUrl: string
  language: string
  fetchedAt: string
  cachedAt?: string
  statusCode: number
  credits?: number | null
  inputTokens: number
  outputTokens: number
  markdownKey?: string
  hash: string
  diff?: string
  change?: "changed" | "unchanged"
}
export interface CaptureJob {
  id: string; url: string; options: CaptureOptions
  state: "queued" | "scraping" | "processing" | "ready" | "partial" | "failed" | "cancelled"
  title: string; error: string; previousId: string | null; createdAt: string; updatedAt: string; saved: boolean
  result?: CaptureResult
}
export interface CreateCaptureInput { urls: string[]; clientId: string; options: CaptureOptions; previousId?: string }
export const captureApi = {
  lookup: (urls: string[], signal?: AbortSignal) => api.post<{ rows: CaptureJob[] }>("/inbox/capture/lookup", { urls }, { signal }),
  config: (signal?: AbortSignal) => api.post<CaptureConfig>("/inbox/capture/config", {}, { signal }),
  create: (input: CreateCaptureInput) => api.post<{ jobs: CaptureJob[] }>("/inbox/capture/create", input),
  list: (pageNum = 1, signal?: AbortSignal) => api.post<{ rows: CaptureJob[]; total: number }>("/inbox/capture/list", { pageNum, pageSize: 20 }, { signal }),
  result: (id: string, signal?: AbortSignal) => api.post<CaptureJob>("/inbox/capture/result", { id }, { signal }),
  delete: (id: string) => api.post<{ success: boolean }>("/inbox/capture/delete", { id }),
  cancel: (id: string) => api.post<{ success: boolean }>("/inbox/capture/cancel", { id }),
  regenerate: (id: string, clientId: string) => api.post<CaptureJob>("/inbox/capture/regenerate", { id, clientId }),
}
