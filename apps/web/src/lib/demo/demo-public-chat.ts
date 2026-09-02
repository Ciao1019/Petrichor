import { buildDemoPublicArticleList } from "./demo-public-data"

/* 公开问答的纯浏览器脚本回放。协议与真实 AI SDK UI Message Stream 完全一致，
 * 所以模式切换、流式文字、工具卡片、Wiki 链接和弹窗仍使用正式组件。 */

type QaMode = "normal" | "wiki"
type ScriptStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: unknown; output: unknown }
  | { kind: "pause"; ms: number }

let callSequence = 0

function extractUserText(init?: RequestInit) {
  if (typeof init?.body !== "string") return ""
  try {
    const body = JSON.parse(init.body) as { messages?: unknown[] }
    const messages = Array.isArray(body.messages) ? body.messages : []
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index] as { role?: unknown; parts?: unknown[] } | undefined
      if (message?.role !== "user" || !Array.isArray(message.parts)) continue
      return message.parts.map((part) => {
        const item = part as { type?: unknown; text?: unknown }
        return item.type === "text" && typeof item.text === "string" ? item.text : ""
      }).join("")
    }
  } catch {
    return ""
  }
  return ""
}

function publicArticleRows() {
  return buildDemoPublicArticleList().map((article) => ({
    articleId: article.articleId,
    title: article.title,
    href: article.href,
    snippet: article.excerpt,
    tags: article.tags,
  }))
}

function inventoryScript(wantsTable: boolean): ScriptStep[] {
  const rows = publicArticleRows()
  return [
    { kind: "text", text: "我先读取本站当前公开文章清单。\n\n" },
    { kind: "tool", name: "list_public_articles", input: { limit: 20 }, output: { total: rows.length, items: rows } },
    { kind: "pause", ms: 420 },
    {
      kind: "text",
      text: wantsTable
        ? "当前公开的是两份完整工具手册：\n\n| 文章 | 平台 | 重点 | 建议先看 |\n| --- | --- | --- | --- |\n| [小鼹鼠 Mole：macOS 清理工具完整使用指南](/p/mole-macos-guide) | macOS | 清理、卸载、磁盘分析、优化、监控 | `mo clean --dry-run` 与白名单 |\n| [Fastfetch 使用说明：安装、配置与高级技巧](/p/fastfetch-guide) | 跨平台 | 系统信息、模块、Logo、JSONC | `fastfetch --gen-config` 与 modules |\n\n两篇正文均来自演示站内置的完整 Markdown，而不是摘要占位。"
        : "当前有 **2 篇公开文章**：\n\n1. [小鼹鼠 Mole：macOS 清理工具完整使用指南](/p/mole-macos-guide)：从终端基础、安装开始，覆盖 `clean`、`uninstall`、`analyze`、`optimize`、`status` 和 `purge`。\n2. [Fastfetch 使用说明：安装、配置与高级技巧](/p/fastfetch-guide)：覆盖多平台安装、JSONC、模块、Logo、格式字符串、预设和故障排查。\n\n> 当前回答使用静态数据回放，没有把问题发送到后端或真实模型。",
    },
  ]
}

function moleScript(): ScriptStep[] {
  const row = publicArticleRows().find((item) => item.articleId === "demo-a-mole")
  return [
    {
      kind: "tool",
      name: "search_public_articles",
      input: { queries: ["Mole macOS 清理 dry-run 白名单"] },
      output: { total: row ? 1 : 0, items: row ? [row] : [] },
    },
    { kind: "pause", ms: 360 },
    {
      kind: "text",
      text: "Mole 是 macOS 上的开源系统维护工具。最常用的是 `mo clean`，但第一次不要直接删除，建议：\n\n```bash\nmo clean --dry-run\nmo clean --whitelist\nmo clean\n```\n\n先预览候选文件，再保护设计素材、模型缓存或工作目录，最后执行清理。它还提供 `mo uninstall`、`mo analyze`、`mo optimize`、`mo status` 和 `mo purge`。完整步骤见 [Mole 使用指南](/p/mole-macos-guide)。",
    },
  ]
}

function fastfetchScript(): ScriptStep[] {
  const row = publicArticleRows().find((item) => item.articleId === "demo-a-fastfetch")
  return [
    {
      kind: "tool",
      name: "search_public_articles",
      input: { queries: ["Fastfetch JSONC modules Logo"] },
      output: { total: row ? 1 : 0, items: row ? [row] : [] },
    },
    { kind: "pause", ms: 360 },
    {
      kind: "text",
      text: "Fastfetch 是积极维护、注重性能的 Neofetch 替代方案。安装后直接运行 `fastfetch`；要开始定制，可以先生成配置：\n\n```bash\nfastfetch --gen-config\nfastfetch --list-modules\nfastfetch -s title:os:kernel:cpu:memory:disk\n```\n\n默认配置位于 `~/.config/fastfetch/config.jsonc`，支持 JSON Schema、模块对象、Logo、颜色与格式字符串。完整说明见 [Fastfetch 使用指南](/p/fastfetch-guide)。",
    },
  ]
}

function summaryScript(): ScriptStep[] {
  return [
    {
      kind: "tool",
      name: "search_public_articles",
      input: { queries: ["系统维护", "系统信息展示"] },
      output: { total: 2, items: publicArticleRows() },
    },
    { kind: "pause", ms: 380 },
    {
      kind: "text",
      text: "本站目前围绕一条很实用的主线：**先看清系统，再安全地维护系统**。Fastfetch 负责快速获取并定制展示操作系统、硬件和软件环境；Mole 负责在 macOS 上清理缓存、分析磁盘、卸载应用与执行优化。前者偏观察，后者偏操作；涉及删除时，应始终先 dry-run、备份并配置白名单。",
    },
  ]
}

function wikiScript(userText: string): ScriptStep[] {
  const mole = /Mole|鼹鼠|清理|白名单|macOS/i.test(userText)
  const page = mole
    ? { pageKey: "concept-safe-cleanup", title: "安全清理流程", kind: "concept", summary: "使用 dry-run、备份和白名单建立可检查、可控制的清理流程。" }
    : { pageKey: "concept-jsonc-config", title: "Fastfetch JSONC 配置", kind: "concept", summary: "通过 JSONC 配置模块顺序、Logo、颜色与格式字符串。" }
  return [
    { kind: "text", text: "我会先检索公开 Wiki，再沿来源回到完整文章。\n\n" },
    { kind: "tool", name: "search_wiki_pages", input: { query: [page.title] }, output: { query: [page.title], items: [page] } },
    { kind: "pause", ms: 420 },
    { kind: "tool", name: "read_wiki_page_detail", input: { pageKey: page.pageKey }, output: page },
    { kind: "pause", ms: 300 },
    {
      kind: "text",
      text: mole
        ? "[[concept-safe-cleanup|安全清理流程]]的核心是：**备份 → `mo clean --dry-run` → [[concept-mole-whitelist|配置白名单]] → 确认后执行**。Mole 会涉及应用缓存和开发工具构建缓存，因此工作设备不应跳过预览步骤。"
        : "[[concept-jsonc-config|Fastfetch JSONC 配置]]位于 `~/.config/fastfetch/config.jsonc`。`modules` 决定输出结构，模块对象可以设置 key、颜色和 format；配合 [[concept-fastfetch-modules|模块系统]]与 `$schema`，即可获得可维护的定制配置。",
    },
  ]
}

function fallbackScript(userText: string): ScriptStep[] {
  return [{
    kind: "text",
    text: `纯前端演示不会把「${userText.slice(0, 36)}」发送给真实模型。你可以试试：\n\n- “这个站点有哪些公开文章？”\n- “Mole 第一次清理应该怎么做？”\n- “Fastfetch 的 JSONC 怎么配置？”\n- 切换到 **Wiki 问答** 后询问“安全清理流程是什么？”`,
  }]
}

function pickScript(userText: string, mode: QaMode): ScriptStep[] {
  if (mode === "wiki") return wikiScript(userText)
  if (/鼹鼠|Mole|mo clean|清理|白名单/i.test(userText)) return moleScript()
  if (/Fastfetch|Neofetch|JSONC|系统信息|Logo/i.test(userText)) return fastfetchScript()
  if (/总结|核心主题|一段话|对比|区别/.test(userText)) return summaryScript()
  if (/文章|公开|表格|整理|哪些|什么内容/.test(userText)) return inventoryScript(/表格|整理/.test(userText))
  return fallbackScript(userText)
}

function sleep(ms: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer)
      reject(new DOMException("aborted", "AbortError"))
    }, { once: true })
  })
}

function splitText(text: string) {
  const chunks: string[] = []
  let buffer = ""
  for (const char of text) {
    buffer += char
    if (buffer.length >= 3 || char === "\n") {
      chunks.push(buffer)
      buffer = ""
    }
  }
  if (buffer) chunks.push(buffer)
  return chunks
}

export function demoPublicQaResponse(init: RequestInit | undefined, mode: QaMode): Response {
  const userText = extractUserText(init) || "这个站点有哪些公开文章？"
  const script = pickScript(userText, mode)
  const signal = init?.signal
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      }
      try {
        send({ type: "start", messageId: `demo-public-reply-${Date.now()}` })
        send({ type: "start-step" })
        let textSequence = 0
        for (const step of script) {
          if (step.kind === "pause") {
            await sleep(step.ms, signal)
            continue
          }
          if (step.kind === "text") {
            textSequence += 1
            const id = `demo-public-text-${textSequence}`
            send({ type: "text-start", id })
            for (const delta of splitText(step.text)) {
              send({ type: "text-delta", id, delta })
              await sleep(14 + Math.random() * 18, signal)
            }
            send({ type: "text-end", id })
            continue
          }
          callSequence += 1
          const toolCallId = `demo-public-call-${callSequence}`
          send({ type: "tool-input-start", toolCallId, toolName: step.name })
          await sleep(180, signal)
          send({ type: "tool-input-available", toolCallId, toolName: step.name, input: step.input })
          await sleep(280, signal)
          send({ type: "tool-output-available", toolCallId, output: step.output })
        }
        send({ type: "finish-step" })
        send({ type: "finish" })
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      } catch {
        // 停止生成属于正常交互。
      } finally {
        try {
          controller.close()
        } catch {
          // 取消后流可能已经关闭。
        }
      }
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  })
}
