import { PERMISSIONS } from "../permissions"
import { adaptAssistantTool, readArray, type AdaptOptions } from "./adapter"
import type { AgentToolDefinition, ToolNormalizerResult } from "../types"

/**
 * 既有 Assistant 工具的命名空间化注册（§11/§109）。
 *
 * 只在此处声明元数据（namespace / 风险 / 副作用 / 是否核心 / 归一化），
 * 执行体继续复用 apps/web/src/server/assistant/tools/*，不产生第二套实现。
 */

type LegacySpec = AdaptOptions & { legacyName: string }

const listNormalizer = (label: string, ...keys: string[]) => (output: unknown): ToolNormalizerResult => {
    const items = readArray(output, ...keys)
    return {
        summary: items.length === 0 ? `没有找到${label}` : `找到 ${items.length} 条${label}`,
        data: { items: items.slice(0, 20) },
    }
}

const LEGACY_SPECS: LegacySpec[] = [
    // ---------------------------------------------------------------- system
    {
        legacyName: "list_system_overview",
        id: "system.overview",
        namespace: "system",
        core: true,
        riskLevel: "low",
        sideEffect: false,
        description:
            "读取站点概览：知识库/文章/文档库/文档/对话计数与默认模型就绪状态。"
            + "何时用：回答「有多少知识库/文档」这类计数或清单问题。"
            + "输入：无。输出：各类资源计数。"
            + "何时不用：要查内容时用 search_knowledge / search_documents。",
    },
    {
        // 站内既有的引用芯片仍由本工具驱动（CitationToolUI），保持常驻以免破坏旧前端（§108）。
        // 它与 Evidence 驱动的来源面板并行存在：前者是模型显式声明的引用，后者是自动收集的证据。
        legacyName: "show_citations",
        id: "system.show_citations",
        namespace: "system",
        core: true,
        riskLevel: "low",
        sideEffect: false,
        allowedInSubAgent: true,
        description:
            "回显最终答案实际使用的引用。"
            + "何时用：答案基于检索/读取结果得出、需要给用户可点击来源时。"
            + "输入：citations 列表，href/title/snippet 必须直接来自工具返回结果。"
            + "输出：引用卡片。"
            + "何时不用：没有真实来源时不要调用，更不要编造链接。",
    },
    {
        legacyName: "show_data_table",
        id: "system.show_data_table",
        namespace: "system",
        riskLevel: "low",
        sideEffect: false,
    },
    {
        legacyName: "show_progress",
        id: "system.show_progress",
        namespace: "system",
        riskLevel: "low",
        sideEffect: false,
    },

    // -------------------------------------------------------------- document
    {
        legacyName: "list_doc_libraries",
        id: "document.list_libraries",
        namespace: "document",
        riskLevel: "low",
        sideEffect: false,
        normalize: listNormalizer("文档库", "libraries", "items"),
    },
    {
        legacyName: "search_documents",
        id: "document.search",
        namespace: "document",
        riskLevel: "low",
        sideEffect: false,
        normalize: (output): ToolNormalizerResult => {
            const hits = readArray(output, "hits", "items", "results")
            if (hits.length === 0) {
                return { summary: "文档库中未检索到相关内容", suggestedActions: ["rewrite_query", "knowledge.search"] }
            }
            return {
                progress: true,
                summary: `文档库中找到 ${hits.length} 个片段`,
                data: { hits: hits.slice(0, 12) },
                suggestedActions: ["document.read"],
            }
        },
    },
    {
        legacyName: "read_document",
        id: "document.read",
        namespace: "document",
        riskLevel: "low",
        sideEffect: false,
        normalize: (output, input): ToolNormalizerResult => {
            const record = (output ?? {}) as { title?: string; content?: string; text?: string; documentId?: string }
            const content = (record.content ?? record.text ?? "").trim()
            return {
                summary: content ? `已读取文档「${record.title ?? "未命名"}」（${content.length} 字）` : "文档没有可读内容",
                data: { title: record.title, excerpt: content.slice(0, 300) },
                evidence: content
                    ? [{
                        source: "knowledge",
                        title: record.title ?? "文档",
                        content: content.slice(0, 4_000),
                        ...(record.documentId ? { sourceId: String(record.documentId) } : {}),
                        relevance: 0.75,
                        confidence: 0.8,
                        metadata: { kind: "doc_library", requestedBy: input },
                    }]
                    : [],
            }
        },
    },
    {
        legacyName: "create_article",
        id: "document.create",
        namespace: "document",
        riskLevel: "medium",
        sideEffect: true,
        permissions: [PERMISSIONS.write],
        allowedInSubAgent: false,
    },
    {
        legacyName: "update_article",
        id: "document.update",
        namespace: "document",
        riskLevel: "medium",
        sideEffect: true,
        permissions: [PERMISSIONS.write],
        allowedInSubAgent: false,
    },
    {
        legacyName: "preview_article_update",
        id: "document.preview_update",
        namespace: "document",
        riskLevel: "low",
        sideEffect: false,
    },
    {
        legacyName: "move_article",
        id: "document.move",
        namespace: "document",
        riskLevel: "medium",
        sideEffect: true,
        permissions: [PERMISSIONS.write],
        allowedInSubAgent: false,
    },
    {
        legacyName: "create_article_share",
        id: "document.share",
        namespace: "document",
        riskLevel: "high",
        sideEffect: true,
        requiresConfirmation: true,
        permissions: [PERMISSIONS.write],
        allowedInSubAgent: false,
    },

    {
        legacyName: "request_user_confirmation",
        id: "agent.request_confirmation",
        namespace: "agent",
        riskLevel: "high",
        sideEffect: false,
        allowedInSubAgent: false,
        description:
            "对危险操作发起用户确认卡。"
            + "何时用：需要删除文章/文档、撤销分享、改动管理配置等不可逆操作时。"
            + "输入：title/description + action（目标工具名与参数）。"
            + "输出：确认卡；用户确认后运行时会执行并回传 executionOutcome。"
            + "何时不用：只读操作不需要确认；禁止绕过本工具直接声称已删除。",
    },

    // ---------------------------------------------------------------- memory
    {
        legacyName: "search_operator_history",
        id: "memory.search",
        namespace: "memory",
        riskLevel: "low",
        sideEffect: false,
        description:
            "跨线程检索历史对话（关键词 + 语义）。"
            + "何时用：需要回想以前某次是怎么处理的。"
            + "输入：query，可选 mode/limit。输出：历史片段。"
            + "何时不用：当前对话里已经说过的内容不需要查；不要把整段历史塞进回答。",
        normalize: (output): ToolNormalizerResult => {
            const hits = readArray(output, "hits")
            return {
                summary: hits.length === 0 ? "历史对话中没有相关记录" : `历史对话中找到 ${hits.length} 条记录`,
                data: { hits: hits.slice(0, 8) },
            }
        },
    },

    // ---------------------------------------------------------------- writer
    {
        legacyName: "save_answer_artifact",
        id: "writer.save_artifact",
        namespace: "writer",
        riskLevel: "medium",
        sideEffect: true,
        permissions: [PERMISSIONS.write],
        allowedInSubAgent: false,
        description:
            "把本轮可复用的回答、表格、时间线、报告或笔记保存为产物。"
            + "何时用：用户明确要求保存产出时。"
            + "输入：artifactType + title + 内容。输出：产物 id。"
            + "何时不用：普通问答不要顺手保存。",
    },

    // ----------------------------------------------------------------- admin
    {
        legacyName: "list_ai_models",
        id: "admin.list_models",
        namespace: "admin",
        riskLevel: "medium",
        sideEffect: false,
        permissions: [PERMISSIONS.admin],
        allowedInSubAgent: false,
        normalize: listNormalizer("模型配置", "models", "items"),
    },
    {
        legacyName: "list_agent_api_keys",
        id: "admin.list_api_keys",
        namespace: "admin",
        riskLevel: "medium",
        sideEffect: false,
        permissions: [PERMISSIONS.admin],
        allowedInSubAgent: false,
        normalize: listNormalizer("API Key", "keys", "items"),
    },
    {
        legacyName: "get_public_qa_setting",
        id: "admin.get_public_qa",
        namespace: "admin",
        riskLevel: "medium",
        sideEffect: false,
        permissions: [PERMISSIONS.admin],
        allowedInSubAgent: false,
    },
    {
        legacyName: "bind_ai_model",
        id: "admin.bind_model",
        namespace: "admin",
        riskLevel: "high",
        sideEffect: true,
        permissions: [PERMISSIONS.admin],
        allowedInSubAgent: false,
    },
]

/** 构建全部适配后的工具定义；旧工具未注册时抛错，避免静默丢能力 */
export function buildLegacyAgentTools(): AgentToolDefinition[] {
    return LEGACY_SPECS.map(({ legacyName, ...options }) => adaptAssistantTool(legacyName, options))
}

export const LEGACY_TOOL_IDS = LEGACY_SPECS.map((spec) => spec.id)
