import { afterEach, describe, expect, it, vi } from "vitest"

import {
  PublicSelectionAskError,
  streamPublicSelectionAsk,
  takeSseData,
  type PublicSelectionAskRequest,
} from "./api-public-selection"

const request: PublicSelectionAskRequest = {
  source: { kind: "article", shareCode: "abc123" },
  selection: "选中的片段",
  question: "这是什么意思？",
}

/** 把若干段文本按给定切分方式塞进一个流式响应体，模拟网络分片。 */
function sseResponse(chunks: string[], headers: Record<string, string> = {}) {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream", ...headers } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("takeSseData", () => {
  it("只切出完整的帧，残缺的尾部留到下一次", () => {
    const { data, rest } = takeSseData('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"')
    expect(data).toEqual(['{"a":1}', '{"b":2}'])
    expect(rest).toBe('data: {"c"')
  })

  it("兼容 CRLF 与多行 data，忽略注释行", () => {
    const { data, rest } = takeSseData(": ping\r\n\r\ndata: 第一行\r\ndata: 第二行\r\n\r\n")
    expect(data).toEqual(["第一行\n第二行"])
    expect(rest).toBe("")
  })
})

describe("streamPublicSelectionAsk", () => {
  it("逐段回调文本、带上指纹并返回剩余额度", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(
      [
        'data: {"type":"text-delta","delta":"缓存"}\n\ndata: {"type":"text-',
        'delta","delta":"击穿"}\n\n',
        'data: {"type":"finish"}\n\ndata: [DONE]\n\n',
      ],
      { "X-Petrichor-Qa-Remaining": "19", "X-Petrichor-Qa-Limit": "20" },
    ))
    vi.stubGlobal("fetch", fetchMock)
    const deltas: string[] = []

    const quota = await streamPublicSelectionAsk(request, {
      fingerprint: "0123456789abcdef0123456789abcdef",
      onDelta: (delta) => deltas.push(delta),
    })

    expect(deltas).toEqual(["缓存", "击穿"])
    expect(quota).toEqual({ remaining: 19, limit: 20 })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/public/qa/selection")
    expect(init.credentials).toBe("omit")
    expect(new Headers(init.headers).get("X-Petrichor-Fingerprint")).toBe("0123456789abcdef0123456789abcdef")
    expect(JSON.parse(String(init.body))).toEqual(request)
  })

  it("流开始前的错误读出服务端文案与状态码", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 429, msg: "划词提问次数已达每小时 20 次的上限，请 12 分钟后再试" }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    )))

    const error = await streamPublicSelectionAsk(request, { onDelta: () => {} }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PublicSelectionAskError)
    expect(error).toMatchObject({ status: 429, message: "划词提问次数已达每小时 20 次的上限，请 12 分钟后再试" })
  })

  it("没有指纹时不发请求头；流中的错误帧转成异常", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"text-delta","delta":"半句"}\n\n',
      'data: {"type":"error","errorText":"AI 回答失败，请稍后再试"}\n\n',
    ]))
    vi.stubGlobal("fetch", fetchMock)
    const deltas: string[] = []

    const error = await streamPublicSelectionAsk(request, { fingerprint: "", onDelta: (delta) => deltas.push(delta) })
      .catch((caught: unknown) => caught)

    expect(deltas).toEqual(["半句"])
    expect(error).toMatchObject({ status: 500, message: "AI 回答失败，请稍后再试" })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(new Headers(init.headers).has("X-Petrichor-Fingerprint")).toBe(false)
  })
})
