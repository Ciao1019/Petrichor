// 调用 /api/ai/write/stream 并把文本块通过回调暴露给调用方
import type { AiAssistantRequest } from "./types"

export interface StreamCallbacks {
  onChunk: (chunk: string) => void
  onError: (message: string) => void
  onDone: () => void
  signal: AbortSignal
}

export async function streamAiWrite(req: AiAssistantRequest, callbacks: StreamCallbacks) {
  let response: Response
  try {
    response = await fetch("/api/ai/write/stream", {
      method: "POST",
      credentials: "include",
      signal: callbacks.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: req.action,
        selectedText: req.selectedText,
        contextBefore: req.contextBefore,
        contextAfter: req.contextAfter,
        language: req.language,
        tone: req.tone,
      }),
    })
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      return
    }
    callbacks.onError(resolveErrorMessage(error, "请求失败"))
    return
  }

  if (!response.ok) {
    const message = await safeReadErrorMessage(response)
    callbacks.onError(message)
    return
  }
  if (!response.body) {
    callbacks.onError("服务器未返回流式响应")
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      if (chunk) callbacks.onChunk(chunk)
    }
    const tail = decoder.decode()
    if (tail) callbacks.onChunk(tail)
    callbacks.onDone()
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      return
    }
    callbacks.onError(resolveErrorMessage(error, "读取流失败"))
  }
}

async function safeReadErrorMessage(response: Response) {
  try {
    const data = await response.json() as { msg?: unknown }
    if (typeof data?.msg === "string" && data.msg.trim()) {
      return data.msg
    }
  } catch {
    // ignore
  }
  return `请求失败（${response.status}）`
}

function resolveErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return fallback
}
