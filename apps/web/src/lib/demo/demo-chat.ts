import type { WikiMentionTarget } from "@/lib/wiki-mentions"

import { beginDemoExchange, completeDemoExchange } from "./demo-assistant"
import { demoStore } from "./demo-store"

/*
 * 演示模式复刻当前 Go Agent Runtime 的 UIMessage SSE 契约：
 * - data-agent-event 驱动执行过程、证据与流式答案；
 * - 标准 tool part 仅承载当前前端仍会渲染的工具结果；
 * - 不再用 show_citations / show_data_table / upsert_plan 等旧演示工具拼效果。
 */

const THREAD_HEADER = "X-Petrichor-Assistant-Thread-Id"
const RUN_HEADER = "X-Petrichor-Assistant-Run-Id"
const AGENT_EVENT_PART_TYPE = "data-agent-event"
const AGENT_ANSWER_TEXT_ID = "agent-answer"

interface DemoEvidence {
    id: string
    source: "knowledge" | "wiki" | "web" | "graph" | "memory" | "subagent" | "tool"
    title: string
    snippet?: string
    url?: string
    nodeKey?: string
    pageKey?: string
    articleId?: string
    knowledgeBaseId?: string
    path?: string[]
    relevance?: number
}

interface DemoActivity {
    toolId: string
    toolName: string
    title: string
    input: unknown
    output: unknown
    summary: string
    durationMs: number
    evidence?: DemoEvidence[]
}

interface DemoSkill {
    id: string
    name: string
}

interface DemoScript {
    complexity: "direct" | "simple" | "multi_step" | "complex"
    activities: DemoActivity[]
    answer: string
    skills?: DemoSkill[]
    wikiMentionTargets?: WikiMentionTarget[]
}

let runSequence = 0

function articleEvidence(input: {
    id: string
    articleId: string
    knowledgeBaseId: string
    title: string
    snippet: string
    path: string[]
    relevance?: number
}): DemoEvidence {
    return {
        id: input.id,
        source: "knowledge",
        title: input.title,
        snippet: input.snippet,
        nodeKey: input.id,
        articleId: input.articleId,
        knowledgeBaseId: input.knowledgeBaseId,
        path: input.path,
        relevance: input.relevance ?? 0.94,
    }
}

function knowledgeLookup(input: {
    query: string
    summary: string
    evidence: DemoEvidence[]
    durationMs?: number
}): DemoActivity {
    return {
        toolId: "knowledge.lookup",
        toolName: "lookup_knowledge",
        title: `正在检索并阅读知识库：${input.query}`,
        input: { query: input.query, topK: 6 },
        output: {
            summary: input.summary,
            evidenceIds: input.evidence.map((item) => item.id),
        },
        summary: input.summary,
        durationMs: input.durationMs ?? 680,
        evidence: input.evidence,
    }
}

function inventoryScript(): DemoScript {
    const articleCounts = new Map<string, number>()
    for (const article of demoStore.articles.values()) {
        articleCounts.set(article.knowledgeBaseId, (articleCounts.get(article.knowledgeBaseId) ?? 0) + 1)
    }
    const overview = {
        knowledgeBases: demoStore.knowledgeBases.length,
        articles: demoStore.articles.size,
        docLibraries: 1,
        documents: 2,
        assistantThreads: demoStore.threads.length,
        chatModelReady: true,
        embeddingModelReady: true,
    }
    return {
        complexity: "simple",
        activities: [{
            toolId: "system.overview",
            toolName: "list_system_overview",
            title: "正在查看系统概览",
            input: {},
            output: overview,
            summary: `知识库 ${overview.knowledgeBases} 个，文章 ${overview.articles} 篇，文档库 1 个`,
            durationMs: 420,
        }],
        answer:
            `当前共有 **${overview.knowledgeBases} 个知识库、${overview.articles} 篇文章、1 个文档库和 2 份文档**。\n\n` +
            demoStore.knowledgeBases.map((kb) =>
                `- **${kb.name}**（${articleCounts.get(kb.id) ?? 0} 篇）：${kb.description}`,
            ).join("\n") +
            "\n\n目前更新最集中的是「开源命令行工具手册」，适合继续追问 Mole 的安全清理流程或 Fastfetch 的配置方法。",
    }
}

function moleSafetyScript(): DemoScript {
    const evidence = articleEvidence({
        id: "demo-evidence-mole-safety",
        articleId: "demo-a-mole",
        knowledgeBaseId: "demo-kb-product",
        title: "Mole 首次清理与安全工作流",
        snippet: "首次使用前备份，先以 dry-run 检查候选项，再配置白名单并执行清理。",
        path: ["开源命令行工具手册", "macOS 工具", "首次清理"],
    })
    return {
        complexity: "simple",
        activities: [knowledgeLookup({
            query: "Mole 第一次清理 dry-run 白名单",
            summary: "通过语义与关键词召回并深读了 Mole 安全清理章节（语义 + 关键词；Wiki 目录导航；本地重排）",
            evidence: [evidence],
            durationMs: 760,
        })],
        wikiMentionTargets: [{
            pageKey: "concept-safe-cleanup",
            title: "安全清理流程",
            aliases: ["安全清理", "首次清理"],
            kind: "concept",
            citationIndex: 1,
        }],
        answer:
            "第一次运行 Mole，重点不是尽快删除，而是先建立**可检查、可恢复的安全边界**：\n\n" +
            "1. **先备份重要数据**：工作设备建议先完成一次 Time Machine 备份。\n" +
            "2. **先预览、不落盘**：运行 `mo clean --dry-run`，逐项检查候选内容。\n" +
            "3. **保护重要路径**：运行 `mo clean --whitelist`，也可以编辑 `~/.config/mole/whitelist`。\n" +
            "4. **留意开发缓存**：重点确认 Xcode DerivedData、Node.js 缓存等目录是否可以重建。\n" +
            "5. **确认后再清理**：候选项和白名单都核对无误，再运行 `mo clean`。\n\n" +
            "如果还要执行系统优化，同样先用 `mo optimize --dry-run`。这就是推荐的安全清理流程。[1]",
    }
}

function fastfetchConfigScript(): DemoScript {
    const evidence = articleEvidence({
        id: "demo-evidence-fastfetch-config",
        articleId: "demo-a-fastfetch",
        knowledgeBaseId: "demo-kb-product",
        title: "Fastfetch 配置与模块系统",
        snippet: "从生成 JSONC 配置开始，再按需调整 modules、Logo、颜色和 format。",
        path: ["开源命令行工具手册", "系统信息", "配置与高级技巧"],
    })
    return {
        complexity: "simple",
        activities: [knowledgeLookup({
            query: "Fastfetch JSONC modules Logo format",
            summary: "召回配置章节并深读模块、Logo 与格式化说明（语义 + 关键词；Wiki 目录导航；本地重排）",
            evidence: [evidence],
            durationMs: 720,
        })],
        wikiMentionTargets: [{
            pageKey: "concept-jsonc-config",
            title: "Fastfetch JSONC 配置",
            aliases: ["JSONC 配置", "模块系统"],
            kind: "concept",
            citationIndex: 1,
        }],
        answer:
            "建议从自动生成的配置开始，而不是直接手写整份 JSONC：\n\n" +
            "```bash\nfastfetch --gen-config\nfastfetch --list-modules\nfastfetch -s title:os:kernel:cpu:memory:disk\n```\n\n" +
            "默认配置位于 `~/.config/fastfetch/config.jsonc`。先调整 `modules` 的顺序与内容，确认信息结构后，再定制 Logo、颜色和 `format`；JSONC 支持注释，也可以配合 `$schema` 获得字段提示。[1]",
    }
}

function summaryScript(): DemoScript {
    const evidence = [
        articleEvidence({
            id: "demo-evidence-summary-mole",
            articleId: "demo-a-mole",
            knowledgeBaseId: "demo-kb-product",
            title: "Mole 与安全系统维护",
            snippet: "以预览、白名单和可恢复边界降低系统清理风险。",
            path: ["开源命令行工具手册", "macOS 工具"],
        }),
        articleEvidence({
            id: "demo-evidence-summary-rsc",
            articleId: "demo-a-rsc",
            knowledgeBaseId: "demo-kb-engineering",
            title: "RSC 心智模型速记",
            snippet: "用交互与取数需求判断 Server / Client 边界。",
            path: ["前端工程笔记", "React"],
        }),
        articleEvidence({
            id: "demo-evidence-summary-thinking",
            articleId: "demo-a-thinking-fast",
            knowledgeBaseId: "demo-kb-reading",
            title: "《思考，快与慢》：系统 1 的陷阱清单",
            snippet: "识别锚定、可得性与损失厌恶对产品判断的影响。",
            path: ["读书摘录", "思考，快与慢"],
        }),
    ]
    return {
        complexity: "multi_step",
        activities: [knowledgeLookup({
            query: "各知识库的核心主题与共同脉络",
            summary: "跨 3 个知识库召回并深读了 3 个代表章节（语义 + 关键词；本地重排）",
            evidence,
            durationMs: 980,
        })],
        answer:
            "现有知识围绕一条共同主线展开：**先观察事实，再明确边界，最后执行行动**。开源工具手册把它落实为系统信息观察和安全维护[1]；前端工程笔记把它应用到 React / TypeScript 的架构边界与交付性能[2]；读书摘录则从认知偏差和工程影响力补足判断框架[3]。三类内容共同组成了可检索、可追溯、可以直接用于决策的个人知识体系。",
    }
}

function documentReviewScript(): DemoScript {
    const moleDoc: DemoEvidence = {
        id: "demo-evidence-doc-mole",
        source: "tool",
        title: "Mole 命令速查",
        snippet: "清理前先 dry-run，随后核对白名单，再执行正式清理。",
        url: "/dashboard/documents",
        path: ["工具资料库", "mole-commands.xlsx", "命令速查"],
    }
    const fastfetchDoc: DemoEvidence = {
        id: "demo-evidence-doc-fastfetch",
        source: "tool",
        title: "Fastfetch 模块清单",
        snippet: "常用模块包括 os、cpu、gpu、memory、disk 与 command。",
        url: "/dashboard/documents",
        path: ["工具资料库", "fastfetch-modules.xlsx", "模块"],
    }
    return {
        complexity: "multi_step",
        skills: [{ id: "documents", name: "文档与内容管理" }],
        activities: [
            {
                toolId: "document.search",
                toolName: "search_documents",
                title: "正在检索文档库：最近值得复习的内容",
                input: { queries: ["安全清理", "系统信息模块"] },
                output: { hits: [{ title: moleDoc.title }, { title: fastfetchDoc.title }] },
                summary: "在工具资料库中找到 2 份相关文档",
                durationMs: 520,
            },
            {
                toolId: "document.read",
                toolName: "read_document",
                title: "正在阅读文档：Mole 命令速查",
                input: { documentId: "demo-doc-mole", locator: "命令速查" },
                output: { title: moleDoc.title, fileName: "mole-commands.xlsx", locator: "命令速查" },
                summary: "读取了 Mole 命令与风险说明",
                durationMs: 430,
                evidence: [moleDoc],
            },
            {
                toolId: "document.read",
                toolName: "read_document",
                title: "正在阅读文档：Fastfetch 模块清单",
                input: { documentId: "demo-doc-fastfetch", locator: "模块" },
                output: { title: fastfetchDoc.title, fileName: "fastfetch-modules.xlsx", locator: "模块" },
                summary: "读取了 Fastfetch 常用模块清单",
                durationMs: 410,
                evidence: [fastfetchDoc],
            },
        ],
        answer:
            "最近最值得复习的是两组内容：\n\n" +
            "- **Mole 命令速查**：重点记住 `mo clean --dry-run`、白名单和正式清理的先后顺序。[1]\n" +
            "- **Fastfetch 模块清单**：优先掌握 `os`、`cpu`、`gpu`、`memory`、`disk` 与 `command`，足够组合大多数终端概览。[2]\n\n" +
            "建议先复习 Mole 的预览与保护边界，再用 Fastfetch 做一份自己的系统状态预设。",
    }
}

function comparisonScript(): DemoScript {
    const mole = articleEvidence({
        id: "demo-evidence-compare-mole",
        articleId: "demo-a-mole",
        knowledgeBaseId: "demo-kb-product",
        title: "Mole：清理、卸载、分析与优化",
        snippet: "面向 macOS 的系统维护工具，危险操作前应先预览并核对白名单。",
        path: ["开源命令行工具手册", "macOS 工具"],
    })
    const fastfetch = articleEvidence({
        id: "demo-evidence-compare-fastfetch",
        articleId: "demo-a-fastfetch",
        knowledgeBaseId: "demo-kb-product",
        title: "Fastfetch：跨平台系统信息展示",
        snippet: "快速采集并展示操作系统、硬件和环境信息。",
        path: ["开源命令行工具手册", "系统信息"],
    })
    return {
        complexity: "multi_step",
        activities: [knowledgeLookup({
            query: "Mole 与 Fastfetch 的用途、平台和使用边界",
            summary: "召回并深读了两款工具的核心章节（语义 + 关键词；Wiki 目录导航；本地重排）",
            evidence: [mole, fastfetch],
            durationMs: 920,
        })],
        answer:
            "两款工具不是替代关系，而是对应不同阶段：\n\n" +
            "| 工具 | 核心用途 | 平台 | 建议入口 |\n" +
            "| --- | --- | --- | --- |\n" +
            "| Mole | 清理、卸载、分析与优化 | macOS | `mo clean --dry-run` [1] |\n" +
            "| Fastfetch | 获取并展示系统信息 | 跨平台 | `fastfetch --gen-config` [2] |\n\n" +
            "可以把它们理解为：**Fastfetch 负责观察，Mole 负责操作**。先看清系统状态，再在备份、预览和白名单保护下执行维护，是更稳妥的组合。",
    }
}

function noMatchingDocumentScript(): DemoScript {
    return {
        complexity: "simple",
        skills: [{ id: "documents", name: "文档与内容管理" }],
        activities: [{
            toolId: "document.search",
            toolName: "search_documents",
            title: "正在检索文档库：部署与回滚",
            input: { queries: ["部署", "回滚"] },
            output: { items: [], emptyMessage: "当前文档库中没有命中部署或回滚相关段落。" },
            summary: "当前文档库没有找到部署或回滚相关证据",
            durationMs: 460,
        }],
        answer: "当前「工具资料库」中没有检索到部署或回滚相关段落，因此我不会补写不存在的结论。现有资料主要是 Mole 命令速查和 Fastfetch 模块清单；导入部署手册后，可以继续按文件、工作表或段落定位。",
    }
}

function knowledgeGuideScript(): DemoScript {
    const evidence = [
        articleEvidence({
            id: "demo-evidence-guide-mole",
            articleId: "demo-a-mole",
            knowledgeBaseId: "demo-kb-product",
            title: "Mole 安全清理原则",
            snippet: "先备份和预览，再通过白名单保护重要路径。",
            path: ["开源命令行工具手册", "macOS 工具"],
        }),
        articleEvidence({
            id: "demo-evidence-guide-rsc",
            articleId: "demo-a-rsc",
            knowledgeBaseId: "demo-kb-engineering",
            title: "RSC 边界判断",
            snippet: "用交互需求判断 Server 与 Client 边界。",
            path: ["前端工程笔记", "React"],
        }),
        articleEvidence({
            id: "demo-evidence-guide-thinking",
            articleId: "demo-a-thinking-fast",
            knowledgeBaseId: "demo-kb-reading",
            title: "系统 1 的陷阱清单",
            snippet: "识别锚定、可得性与损失厌恶。",
            path: ["读书摘录", "思考，快与慢"],
        }),
    ]
    return {
        complexity: "simple",
        activities: [knowledgeLookup({
            query: "值得长期复用的目标、原则与结论",
            summary: "跨知识库找到 3 组可复用结论并核对原文（语义 + 关键词；本地重排）",
            evidence,
            durationMs: 860,
        })],
        answer:
            "当前资料中最值得长期复用的三条原则是：\n\n" +
            "1. **先观察再操作**：先确认状态和影响范围，再执行清理或优化。[1]\n" +
            "2. **先明确边界再引入交互**：组件是否需要进入客户端，应由真实交互需求决定。[2]\n" +
            "3. **先寻找证据再做判断**：主动检查锚定、可得性与损失厌恶，避免凭第一印象决策。[3]",
    }
}

function fallbackScript(userText: string): DemoScript {
    const query = userText.trim().slice(0, 80)
    return {
        complexity: "simple",
        activities: [knowledgeLookup({
            query,
            summary: "已检索现有知识库，但没有获得足够相关的可引用正文",
            evidence: [],
            durationMs: 540,
        })],
        answer:
            `现有知识库中没有找到足够证据直接回答「${query.slice(0, 40)}」，所以我先不推测。` +
            "\n\n当前资料覆盖 Mole 安全清理、Fastfetch 配置、React / TypeScript 工程实践和读书摘录；换一个更具体的目标或导入相关资料后，我可以继续检索。",
    }
}

function pickScript(userText: string): DemoScript {
    const text = userText.toLowerCase()
    if (/mole|鼹鼠|mo clean|清理|白名单|dry-run/.test(text)) return moleSafetyScript()
    if (/fastfetch|neofetch|jsonc|logo|系统信息/.test(text)) return fastfetchConfigScript()
    if (/总结|核心主题|共同主线|一段话/.test(text)) return summaryScript()
    if (/多少|盘点|现状|资源概览/.test(text)) return inventoryScript()
    if (/对比|表格|区别|分别适合/.test(text)) return comparisonScript()
    if (/部署|回滚/.test(text)) return noMatchingDocumentScript()
    if (/文档库|资料|文档|复习/.test(text)) return documentReviewScript()
    if (/可以问|哪些问题|引用|结论|目标|原则|搜索|长期复用/.test(text)) return knowledgeGuideScript()
    return fallbackScript(userText)
}

function extractUserText(body: unknown): string {
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    const messages = Array.isArray(record.messages) ? record.messages : []
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as Record<string, unknown> | null
        if (!message || message.role !== "user") continue
        const parts = Array.isArray(message.parts) ? message.parts : []
        const text = parts.map((part) => {
            const item = part as Record<string, unknown> | null
            return item && item.type === "text" && typeof item.text === "string" ? item.text : ""
        }).join("")
        if (text) return text
    }
    return ""
}

function sleep(ms: number, signal?: AbortSignal | null) {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener("abort", () => {
            clearTimeout(timer)
            reject(new DOMException("aborted", "AbortError"))
        }, { once: true })
    })
}

/** 模拟供应商的自然文本分块，不再用固定的逐字打字机。 */
function splitDeltas(text: string): string[] {
    const deltas: string[] = []
    let buffer = ""
    for (const char of text) {
        buffer += char
        if (buffer.length >= 5 || char === "\n") {
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
    runSequence += 1
    const runId = `demo-run-${Date.now()}-${runSequence}`
    const persistedParts: Array<Record<string, unknown>> = []
    const persistedPartIndex = new Map<string, number>()

    const persistPart = (id: string, part: Record<string, unknown>) => {
        const index = persistedPartIndex.get(id)
        if (index == null) {
            persistedPartIndex.set(id, persistedParts.length)
            persistedParts.push(part)
            return
        }
        persistedParts[index] = part
    }

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const send = (chunk: Record<string, unknown>) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
            }
            let sequence = 0
            const sendAgentEvent = (type: string, payload: Record<string, unknown> = {}) => {
                sequence += 1
                const event = { runId, sequence, type, timestamp: Date.now(), payload }
                const id = type === "final_answer_delta" ? `${runId}:answer-delta` : `${runId}:${sequence}`
                const part = { type: AGENT_EVENT_PART_TYPE, id, data: event }
                send(part)
                persistPart(id, part)
            }

            try {
                const startedAt = Date.now()
                send({ type: "start", messageId: `demo-reply-${startedAt}` })
                sendAgentEvent("agent_started", { goal: userText })
                sendAgentEvent("complexity_detected", { complexity: script.complexity })

                for (const skill of script.skills ?? []) {
                    sendAgentEvent("skill_loaded", { skillId: skill.id, name: skill.name })
                    await sleep(160, signal)
                }

                for (let index = 0; index < script.activities.length; index += 1) {
                    const activity = script.activities[index]!
                    const callId = `${runId}:tool:${index + 1}`
                    sendAgentEvent("tool_started", {
                        callId,
                        toolId: activity.toolId,
                        title: activity.title,
                    })
                    await sleep(Math.min(620, Math.max(280, activity.durationMs * 0.55)), signal)

                    send({ type: "tool-input-start", toolCallId: callId, toolName: activity.toolName })
                    send({ type: "tool-input-available", toolCallId: callId, toolName: activity.toolName, input: activity.input })
                    send({ type: "tool-output-available", toolCallId: callId, output: activity.output })
                    persistPart(callId, {
                        type: `tool-${activity.toolName}`,
                        toolCallId: callId,
                        state: "output-available",
                        input: activity.input,
                        output: activity.output,
                    })
                    const evidenceIds = (activity.evidence ?? []).map((item) => item.id)
                    sendAgentEvent("tool_completed", {
                        callId,
                        toolId: activity.toolId,
                        summary: activity.summary,
                        durationMs: activity.durationMs,
                        evidenceIds,
                    })
                    if (activity.evidence?.length) {
                        sendAgentEvent("evidence_created", { evidence: activity.evidence })
                    }
                    await sleep(110, signal)
                }

                if (script.wikiMentionTargets?.length) {
                    sendAgentEvent("wiki_mention_targets", { targets: script.wikiMentionTargets })
                }
                sendAgentEvent("final_answer_started")
                for (const delta of splitDeltas(script.answer)) {
                    sendAgentEvent("final_answer_delta", { delta })
                    await sleep(10 + Math.random() * 10, signal)
                }

                send({ type: "text-start", id: AGENT_ANSWER_TEXT_ID })
                send({ type: "text-delta", id: AGENT_ANSWER_TEXT_ID, delta: script.answer })
                send({ type: "text-end", id: AGENT_ANSWER_TEXT_ID })
                persistedParts.push({ type: "text", text: script.answer })
                sendAgentEvent("final_answer_completed", { text: script.answer })
                sendAgentEvent("agent_completed", {
                    status: "completed",
                    metrics: {
                        durationMs: Date.now() - startedAt,
                        toolCalls: script.activities.length,
                        evidenceCount: script.activities.reduce((count, item) => count + (item.evidence?.length ?? 0), 0),
                        subAgentCount: 0,
                        iterations: Math.max(1, script.activities.length + 1),
                    },
                })
                send({ type: "finish" })
                controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                completeDemoExchange(thread, persistedParts)
            } catch {
                completeDemoExchange(thread, persistedParts)
            } finally {
                try {
                    controller.close()
                } catch {
                    // 控制器可能已因用户停止而关闭
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
            [RUN_HEADER]: runId,
        },
    })
}
