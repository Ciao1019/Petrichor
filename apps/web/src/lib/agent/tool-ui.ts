/**
 * Tool → UI 语义映射（§162.9）。
 *
 * 纯函数模块，前后端共用：后端在 tool_started 事件里带上人类可读 title，
 * 前端 activity-mapper 用同一张表做聚合与文案，避免两边各写一套 if/else。
 * 不要向普通用户展示内部 Tool ID。
 */

export type AgentActivityType =
    | "knowledge_search"
    | "knowledge_read"
    | "graph_search"
    | "web_search"
    | "web_read"
    | "memory_search"
    | "skill_load"
    | "delegation"
    | "analysis"
    | "writing"
    | "document_operation"
    | "tool"
    | "error"

type ToolUiSpec = {
    activityType: AgentActivityType
    /** 运行中文案 */
    running: string
    /** 完成后文案 */
    done: string
    /** 聚合分组 key：同 key 的活动在 UI 上合并成一条 */
    group?: string
}

const TOOL_UI: Record<string, ToolUiSpec> = {
    "knowledge.search": { activityType: "knowledge_search", running: "正在搜索知识库", done: "搜索知识库", group: "knowledge" },
    "knowledge.read": { activityType: "knowledge_read", running: "正在阅读知识文档", done: "阅读知识文档", group: "knowledge" },
    "knowledge.list_bases": { activityType: "knowledge_search", running: "正在查看知识库列表", done: "查看知识库列表", group: "knowledge" },
    "graph.search": { activityType: "graph_search", running: "正在查询知识图谱", done: "查询知识图谱", group: "graph" },
    "graph.expand": { activityType: "graph_search", running: "正在扩展关联实体", done: "扩展关联实体", group: "graph" },
    "graph.get_entity": { activityType: "graph_search", running: "正在读取实体信息", done: "读取实体信息", group: "graph" },
    "graph.get_relations": { activityType: "graph_search", running: "正在读取实体关系", done: "读取实体关系", group: "graph" },
    "research.search": { activityType: "web_search", running: "正在搜索外部资料", done: "搜索外部资料", group: "research" },
    "research.fetch": { activityType: "web_read", running: "正在阅读外部来源", done: "阅读外部来源", group: "research" },
    "research.extract": { activityType: "web_read", running: "正在提取来源要点", done: "提取来源要点", group: "research" },
    "memory.search": { activityType: "memory_search", running: "正在检索长期记忆", done: "检索长期记忆", group: "memory" },
    "memory.write": { activityType: "tool", running: "正在保存长期记忆", done: "保存长期记忆", group: "memory" },
    "memory.update": { activityType: "tool", running: "正在更新长期记忆", done: "更新长期记忆", group: "memory" },
    "memory.delete": { activityType: "tool", running: "正在删除长期记忆", done: "删除长期记忆", group: "memory" },
    "document.search": { activityType: "document_operation", running: "正在检索文档库", done: "检索文档库", group: "document" },
    "document.read": { activityType: "document_operation", running: "正在阅读文档", done: "阅读文档", group: "document" },
    "document.create": { activityType: "document_operation", running: "正在创建文档", done: "创建文档" },
    "document.update": { activityType: "document_operation", running: "正在更新文档", done: "更新文档" },
    "document.export": { activityType: "document_operation", running: "正在导出文档", done: "导出文档" },
    "writer.compose": { activityType: "writing", running: "正在整理并生成内容", done: "整理并生成内容", group: "writer" },
    "writer.rewrite": { activityType: "writing", running: "正在改写内容", done: "改写内容", group: "writer" },
    "writer.summarize": { activityType: "writing", running: "正在归纳要点", done: "归纳要点", group: "writer" },
    "writer.structure": { activityType: "writing", running: "正在梳理结构", done: "梳理结构", group: "writer" },
    "agent.load_skill": { activityType: "skill_load", running: "正在加载能力", done: "加载能力" },
    "agent.delegate": { activityType: "delegation", running: "正在委派子任务", done: "委派子任务" },
    "system.overview": { activityType: "analysis", running: "正在查看系统概览", done: "查看系统概览", group: "system" },
}

const NAMESPACE_FALLBACK: Record<string, ToolUiSpec> = {
    knowledge: { activityType: "knowledge_search", running: "正在使用知识库", done: "使用知识库", group: "knowledge" },
    graph: { activityType: "graph_search", running: "正在查询知识图谱", done: "查询知识图谱", group: "graph" },
    research: { activityType: "web_search", running: "正在查询外部资料", done: "查询外部资料", group: "research" },
    memory: { activityType: "memory_search", running: "正在使用记忆", done: "使用记忆", group: "memory" },
    document: { activityType: "document_operation", running: "正在处理文档", done: "处理文档", group: "document" },
    writer: { activityType: "writing", running: "正在生成内容", done: "生成内容", group: "writer" },
    admin: { activityType: "tool", running: "正在执行管理操作", done: "执行管理操作" },
    system: { activityType: "analysis", running: "正在分析", done: "分析", group: "system" },
    agent: { activityType: "delegation", running: "正在协调子任务", done: "协调子任务" },
}

const GENERIC: ToolUiSpec = { activityType: "tool", running: "正在处理", done: "处理" }

export function resolveToolUiSpec(toolId: string): ToolUiSpec {
    if (TOOL_UI[toolId]) return TOOL_UI[toolId]
    const namespace = toolId.split(".")[0]
    return NAMESPACE_FALLBACK[namespace] ?? GENERIC
}

export function toolActivityType(toolId: string): AgentActivityType {
    return resolveToolUiSpec(toolId).activityType
}

export function toolActivityGroup(toolId: string): string {
    return resolveToolUiSpec(toolId).group ?? toolId
}

/** 运行中标题；带上 query 之类的关键参数让用户知道在查什么 */
export function toolActivityTitle(toolId: string, input?: unknown): string {
    const spec = resolveToolUiSpec(toolId)
    const hint = extractHint(input)
    return hint ? `${spec.running}：${hint}` : spec.running
}

export function toolActivityDoneTitle(toolId: string): string {
    return resolveToolUiSpec(toolId).done
}

function extractHint(input: unknown): string | null {
    if (!input || typeof input !== "object") return null
    const record = input as Record<string, unknown>
    for (const key of ["query", "objective", "goal", "title", "keyword"]) {
        const value = record[key]
        if (typeof value === "string" && value.trim()) {
            const text = value.trim()
            return text.length > 40 ? `${text.slice(0, 40)}…` : text
        }
    }
    return null
}
