import type { AssistantPersistedPlan } from "@/lib/api"

import { beginDemoExchange, completeDemoExchange } from "./demo-assistant"
import { demoStore } from "./demo-store"

/*
 * 演示模式的助手对话：不接任何模型，按脚本以 AI SDK v7 UI Message Stream
 * 协议（SSE）回放，含真实的工具调用卡片、Plan 侧栏与打字机节奏。
 * 回放结束后把消息落进内存线程，切换会话/刷新列表行为与真实后端一致。
 */

const THREAD_HEADER = "X-Petrichor-Assistant-Thread-Id"

type ScriptStep =
    | { kind: "text"; text: string }
    | { kind: "tool"; name: string; input: unknown; output: unknown }
    | { kind: "pause"; ms: number }

interface DemoScript {
    steps: ScriptStep[]
    plan?: AssistantPersistedPlan
}

let toolSeq = 0

function nextToolCallId() {
    toolSeq += 1
    return `demo-call-${toolSeq}`
}

/* ---------- 脚本 ---------- */

function inventoryScript(): DemoScript {
    const kbs = demoStore.knowledgeBases
    return {
        steps: [
            { kind: "text", text: "好的，我先看一眼你的知识库分布。\n\n" },
            {
                kind: "tool",
                name: "list_knowledge_bases",
                input: {},
                output: {
                    knowledgeBases: kbs.map((kb) => ({ id: kb.id, name: kb.name, description: kb.description })),
                },
            },
            { kind: "pause", ms: 350 },
            {
                kind: "text",
                text:
                    `目前一共 **${kbs.length} 个知识库**、**${demoStore.articles.size} 篇文章**：\n\n` +
                    kbs
                        .map((kb) => {
                            const count = [...demoStore.articles.values()].filter(
                                (article) => article.knowledgeBaseId === kb.id,
                            ).length
                            return `- **${kb.name}**（${count} 篇）—— ${kb.description}`
                        })
                        .join("\n") +
                    "\n\n从更新频率看，「Petrichor 产品手记」是当前主线。要不要我基于某个库做一次结构化盘点？\n\n" +
                    "> 💡 这是演示模式的脚本回放；部署自己的实例后，这里会接入你配置的真实模型。",
            },
        ],
    }
}

function planScript(): DemoScript {
    const planId = "demo-plan-inventory"
    const labels = [
        { id: "t1", label: "枚举全部知识库与文章数" },
        { id: "t2", label: "抽取每个库的核心主题" },
        { id: "t3", label: "标记超过 30 天未更新的库" },
        { id: "t4", label: "输出盘点结论与建议" },
    ] as const

    const makeTodos = (activeIndex: number, completedThrough: number): AssistantPersistedPlan["todos"] =>
        labels.map((item, index) => ({
            id: item.id,
            label: item.label,
            status:
                index < completedThrough
                    ? ("completed" as const)
                    : index === activeIndex
                        ? ("in_progress" as const)
                        : ("pending" as const),
        }))

    const planMeta = {
        id: planId,
        title: "盘点我的知识库现状",
        description: "分四步执行，可在右侧勾选进度",
    }

    // 落库态故意留最后一项未完成，方便演示侧栏勾选；流式过程中逐步推进让观众看清
    const persistedTodos = makeTodos(3, 3)

    return {
        plan: { ...planMeta, todos: persistedTodos },
        steps: [
            { kind: "text", text: "收到，我把这件事拆成可见的计划，边执行边同步进度。\n\n" },
            {
                kind: "tool",
                name: "upsert_plan",
                input: { ...planMeta, todos: makeTodos(0, 0) },
                output: { ok: true, planId },
            },
            // 计划刚出现：多停一会，让侧栏被注意到
            { kind: "pause", ms: 1600 },
            {
                kind: "tool",
                name: "list_knowledge_bases",
                input: {},
                output: {
                    knowledgeBases: demoStore.knowledgeBases.map((kb) => ({ id: kb.id, name: kb.name })),
                },
            },
            { kind: "pause", ms: 900 },
            {
                kind: "tool",
                name: "upsert_plan",
                input: { ...planMeta, todos: makeTodos(1, 1) },
                output: { ok: true, planId },
            },
            { kind: "pause", ms: 1300 },
            {
                kind: "tool",
                name: "upsert_plan",
                input: { ...planMeta, todos: makeTodos(2, 2) },
                output: { ok: true, planId },
            },
            { kind: "pause", ms: 1300 },
            {
                kind: "tool",
                name: "upsert_plan",
                input: { ...planMeta, todos: makeTodos(3, 3) },
                output: { ok: true, planId },
            },
            // 结论打出来前再停一下，避免「做完 → 文字」连成一闪
            { kind: "pause", ms: 1100 },
            {
                kind: "text",
                text:
                    "盘点完成，结论如下：\n\n" +
                    "| 知识库 | 文章 | 核心主题 | 状态 |\n" +
                    "| --- | --- | --- | --- |\n" +
                    "| Petrichor 产品手记 | 3 | 架构决策 / 路线图 | 🟢 活跃 |\n" +
                    "| 前端工程笔记 | 3 | React / TS / 性能 | 🟢 活跃 |\n" +
                    "| 读书摘录 | 2 | 认知 / 职业 | 🟡 5 天未更新 |\n\n" +
                    "**建议**：读书摘录可以考虑和产品手记打通——《思考，快与慢》那篇的锚定效应，正好能引用到定价页设计的讨论里。\n\n" +
                    "右侧 Plan 侧栏的最后一项还没勾完，你可以手动把它标记为完成试试。",
            },
            // 结论写完后再留一点观看时间，再结束流（结束时 settle 会收口）
            { kind: "pause", ms: 1800 },
        ],
    }
}

function summaryScript(): DemoScript {
    const article = demoStore.articles.get("demo-a-runtime")
    return {
        steps: [
            { kind: "text", text: "我先读一下最相关的那篇文章。\n\n" },
            {
                kind: "tool",
                name: "read_knowledge_node",
                input: { articleId: article?.articleId ?? "demo-a-runtime" },
                output: { title: article?.title ?? "为什么助手运行时要自己写", kind: "article" },
            },
            { kind: "pause", ms: 400 },
            {
                kind: "text",
                text:
                    "三个知识库的核心主题，一段话版本：\n\n" +
                    "这套笔记围绕「**把知识管理做成一个可编程的系统**」展开——产品手记记录 Petrichor 自身的架构取舍" +
                    "（自研助手运行时、多层记忆分区），工程笔记沉淀支撑它的前端技术（RSC、类型收窄、拆包实战），" +
                    "读书摘录则补充决策层的认知框架（系统 1 偏差、Staff 工程师的影响力模型）。三者从实现、工具到思维方式，" +
                    "构成一条完整的「造工具的人」的学习路径。\n\n" +
                    "> 💡 演示模式为脚本回放；真实部署后由你配置的模型基于全文生成。",
            },
        ],
    }
}

function fallbackScript(userText: string): DemoScript {
    return {
        steps: [
            {
                kind: "text",
                text:
                    `关于「${userText.slice(0, 40)}」——演示模式里我只能按预设脚本回放，接不了真实模型，` +
                    "所以答不了开放问题。\n\n不过你可以试试这几个能完整走通的：\n\n" +
                    "- **「我现在有多少个知识库和文件？」** —— 看工具调用卡片\n" +
                    "- **「把盘点我的知识库现状拆成可见计划，再逐步执行」** —— 看 Plan 侧栏\n" +
                    "- **「用一段话总结所有知识库的核心主题」** —— 看阅读工具 + 长文生成\n\n" +
                    "部署自己的实例后，这里就是接入你自己模型的完整助手了。",
            },
        ],
    }
}

function pickScript(userText: string): DemoScript {
    const text = userText.toLowerCase()
    if (/计划|拆成|拆解|plan|逐步/.test(text)) return planScript()
    if (/总结|主题|一段话/.test(text)) return summaryScript()
    if (/知识库|文件|多少|盘点|现状/.test(text)) return inventoryScript()
    return fallbackScript(userText)
}

/* ---------- 请求解析 ---------- */

function extractUserText(body: unknown): string {
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    const messages = Array.isArray(record.messages) ? record.messages : []
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as Record<string, unknown> | null
        if (!message || message.role !== "user") continue
        const parts = Array.isArray(message.parts) ? message.parts : []
        const text = parts
            .map((part) => {
                const item = part as Record<string, unknown> | null
                return item && item.type === "text" && typeof item.text === "string" ? item.text : ""
            })
            .join("")
        if (text) return text
    }
    return ""
}

/* ---------- SSE 回放 ---------- */

function sleep(ms: number, signal?: AbortSignal | null) {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer)
                reject(new DOMException("aborted", "AbortError"))
            },
            { once: true },
        )
    })
}

/** 中文按 2-3 字一跳、英文按词，节奏接近真实流式输出 */
function splitDeltas(text: string): string[] {
    const deltas: string[] = []
    let buffer = ""
    for (const char of text) {
        buffer += char
        if (buffer.length >= 3 || char === "\n") {
            deltas.push(buffer)
            buffer = ""
        }
    }
    if (buffer) deltas.push(buffer)
    return deltas
}

export async function demoAssistantChatResponse(init?: RequestInit): Promise<Response> {
    let body: unknown = {}
    if (init && typeof init.body === "string") {
        try {
            body = JSON.parse(init.body)
        } catch {
            body = {}
        }
    }
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    const requestThreadId = typeof record.threadId === "string" ? record.threadId : null
    const userText = extractUserText(body) || "（空消息）"
    const signal = init?.signal ?? null

    const thread = beginDemoExchange(requestThreadId, userText)
    const script = pickScript(userText)

    // 回放过程中同步收集「持久化 parts」，结束时落线程
    const persistedParts: unknown[] = []

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const send = (chunk: Record<string, unknown>) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
            }
            try {
                send({ type: "start", messageId: `demo-reply-${Date.now()}` })
                send({ type: "start-step" })

                let textBlock = 0
                for (const step of script.steps) {
                    if (step.kind === "pause") {
                        await sleep(step.ms, signal)
                        continue
                    }
                    if (step.kind === "text") {
                        textBlock += 1
                        const id = `demo-text-${textBlock}`
                        send({ type: "text-start", id })
                        for (const delta of splitDeltas(step.text)) {
                            send({ type: "text-delta", id, delta })
                            await sleep(14 + Math.random() * 22, signal)
                        }
                        send({ type: "text-end", id })
                        persistedParts.push({ type: "text", text: step.text })
                        continue
                    }
                    const toolCallId = nextToolCallId()
                    const isPlanTool = step.name === "upsert_plan"
                    send({ type: "tool-input-start", toolCallId, toolName: step.name })
                    await sleep((isPlanTool ? 480 : 220) + Math.random() * (isPlanTool ? 260 : 200), signal)
                    send({ type: "tool-input-available", toolCallId, toolName: step.name, input: step.input })
                    await sleep((isPlanTool ? 620 : 320) + Math.random() * (isPlanTool ? 320 : 280), signal)
                    send({ type: "tool-output-available", toolCallId, output: step.output })
                    persistedParts.push({
                        type: `tool-${step.name}`,
                        toolCallId,
                        state: "output-available",
                        input: step.input,
                        output: step.output,
                    })
                }

                send({ type: "finish-step" })
                send({ type: "finish" })
                controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                completeDemoExchange(thread, persistedParts, script.plan)
            } catch {
                // 用户点了停止：已有内容照样落库，保持「可中断」的真实手感
                completeDemoExchange(thread, persistedParts, script.plan)
            } finally {
                try {
                    controller.close()
                } catch {
                    // 控制器可能已因取消而关闭
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
            [THREAD_HEADER]: thread.summary.id,
        },
    })
}
