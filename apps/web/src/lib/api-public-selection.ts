/**
 * 前台划词问 AI：POST /api/public/qa/selection。
 *
 * 响应是 SSE，帧沿用 UIMessage 协议的子集（text-delta / error / finish，末尾 [DONE]）；
 * 流开始前的错误（功能关闭、限流、文档不可见）仍是 { code, msg } JSON。
 * 走原生 fetch 而不是 axios：axios 在浏览器里拿不到可逐段读取的响应体。
 */

export type PublicSelectionAskSource =
  | { kind: "article"; shareCode: string; accessPassword?: string | null }
  | { kind: "wiki"; knowledgeBaseId: string; pageKey: string }

export interface PublicSelectionAskRequest {
  source: PublicSelectionAskSource
  selection: string
  question: string
}

export interface PublicSelectionAskQuota {
  remaining: number
  limit: number
}

/** 与服务端校验一致的长度上限；选区超出时前端先截断，问题框用 maxLength 限住。 */
export const PUBLIC_SELECTION_MAX_CHARS = 2000
export const PUBLIC_SELECTION_MAX_QUESTION_CHARS = 500

const DEFAULT_ERROR = "AI 回答失败，请稍后再试"

export class PublicSelectionAskError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "PublicSelectionAskError"
    this.status = status
  }
}

type SelectionAskFrame =
  | { type: "text-delta"; delta: string }
  | { type: "error"; errorText?: string }
  | { type: "finish" }

/** 从累积缓冲里切出完整的 SSE data 帧，返回帧内容与尚未收完的尾部。 */
export function takeSseData(buffer: string): { data: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n")
  const events = normalized.split("\n\n")
  const rest = events.pop() ?? ""
  const data = events.flatMap((event) => {
    const lines = event.split("\n").filter((line) => line.startsWith("data:"))
    if (lines.length === 0) return []
    return [lines.map((line) => line.slice(5).replace(/^ /, "")).join("\n")]
  })
  return { data, rest }
}

function parseFrame(data: string): SelectionAskFrame | null {
  try {
    const frame: unknown = JSON.parse(data)
    if (frame && typeof frame === "object" && "type" in frame) return frame as SelectionAskFrame
  } catch {
    // 非 JSON 帧（如 [DONE]）由调用方处理
  }
  return null
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { msg?: unknown }
    if (typeof body?.msg === "string" && body.msg.trim()) return body.msg
  } catch {
    // 非 JSON 错误体沿用默认文案
  }
  return DEFAULT_ERROR
}

function readQuota(headers: Headers): PublicSelectionAskQuota | null {
  const remaining = Number(headers.get("X-Petrichor-Qa-Remaining"))
  const limit = Number(headers.get("X-Petrichor-Qa-Limit"))
  if (!headers.has("X-Petrichor-Qa-Remaining") || !Number.isFinite(remaining) || !Number.isFinite(limit)) return null
  return { remaining, limit }
}

/**
 * 发起一次划词提问并逐段回调文本；正常结束时 resolve 剩余额度，失败抛 PublicSelectionAskError。
 * fingerprint 为空时服务端按 IP 限流。
 */
export async function streamPublicSelectionAsk(
  request: PublicSelectionAskRequest,
  options: { fingerprint?: string; signal?: AbortSignal; onDelta: (delta: string) => void },
): Promise<PublicSelectionAskQuota | null> {
  const headers = new Headers({ "Content-Type": "application/json" })
  if (options.fingerprint) headers.set("X-Petrichor-Fingerprint", options.fingerprint)
  const response = await fetch("/api/public/qa/selection", {
    method: "POST",
    credentials: "omit",
    headers,
    body: JSON.stringify(request),
    signal: options.signal,
  })
  if (!response.ok) throw new PublicSelectionAskError(await readErrorMessage(response), response.status)
  if (!response.body) throw new PublicSelectionAskError(DEFAULT_ERROR, response.status)

  const quota = readQuota(response.headers)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    const { data, rest } = takeSseData(buffer + decoder.decode(value, { stream: true }))
    buffer = rest
    for (const item of data) {
      if (item === "[DONE]") return quota
      const frame = parseFrame(item)
      if (frame?.type === "text-delta" && frame.delta) options.onDelta(frame.delta)
      if (frame?.type === "error") throw new PublicSelectionAskError(frame.errorText || DEFAULT_ERROR, 500)
    }
  }
  return quota
}
