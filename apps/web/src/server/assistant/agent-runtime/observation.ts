import { newId } from "./ids"
import { stableHash } from "./loop-detector"
import type { AgentObservation, AgentToolDefinition, AgentToolErrorShape } from "./types"

/**
 * 观察构建与去重（§17/§61）。
 *
 * 原则：原始 Tool Result 只进 Trace；进 LLM Context 的是紧凑 observation。
 * 详细数据由 Context Manager 按需注入。
 */
export class ObservationStore {
    private readonly items: AgentObservation[] = []
    /** 观察指纹 → observation id，用于去重 */
    private readonly index = new Map<string, string>()

    add(observation: AgentObservation): AgentObservation {
        const fingerprint = `${observation.type}:${observation.source}:${stableHash({
            summary: observation.summary,
            data: observation.data,
            isError: observation.isError === true,
        })}`
        const existingId = this.index.get(fingerprint)
        if (existingId) {
            const existing = this.items.find((item) => item.id === existingId)
            if (existing) {
                // 同一观察再次出现：合并证据 id，不新增条目（§17 去重）
                for (const id of observation.evidenceIds) {
                    if (!existing.evidenceIds.includes(id)) existing.evidenceIds.push(id)
                }
                return existing
            }
        }
        this.items.push(observation)
        this.index.set(fingerprint, observation.id)
        return observation
    }

    get all(): AgentObservation[] {
        return this.items
    }

    recent(n: number): AgentObservation[] {
        return this.items.slice(-n)
    }

    get size(): number {
        return this.items.length
    }
}

export function createObservation(init: {
    type: string
    source: string
    summary: string
    data?: unknown
    evidenceIds?: string[]
    suggestedActions?: string[]
    isError?: boolean
    now?: number
}): AgentObservation {
    return {
        id: newId("obs"),
        type: init.type,
        source: init.source,
        summary: init.summary,
        ...(init.data === undefined ? {} : { data: init.data }),
        evidenceIds: init.evidenceIds ?? [],
        ...(init.suggestedActions?.length ? { suggestedActions: init.suggestedActions } : {}),
        ...(init.isError ? { isError: true } : {}),
        createdAt: init.now ?? Date.now(),
    }
}

/** 工具错误 → 观察（§61）：给模型可执行的下一步，而不是丢一个异常 */
export function errorObservation(
    tool: Pick<AgentToolDefinition, "id" | "namespace">,
    error: AgentToolErrorShape,
    now = Date.now(),
): AgentObservation {
    return createObservation({
        type: "tool_error",
        source: tool.id,
        summary: `${tool.id} 执行失败：${error.message}`,
        data: { code: error.code },
        suggestedActions: suggestedActionsForError(error),
        isError: true,
        now,
    })
}

function suggestedActionsForError(error: AgentToolErrorShape): string[] {
    switch (error.code) {
        case "TOOL_TIMEOUT":
            return ["retry", "use_alternative_source"]
        case "TOOL_VALIDATION_ERROR":
            return ["fix_arguments"]
        case "TOOL_PERMISSION_DENIED":
            return ["explain_permission_limit"]
        case "SKILL_NOT_FOUND":
            return ["list_available_skills"]
        case "RETRIEVAL_FAILED":
            return ["rewrite_query", "use_alternative_source"]
        case "SUBAGENT_FAILED":
            return ["handle_inline", "reduce_scope"]
        default:
            return error.retryable ? ["retry"] : ["use_alternative_source"]
    }
}

/**
 * 默认归一化器：工具没有自定义 normalizer 时的兜底摘要。
 * 只描述"拿到了什么形状的结果"，不把正文塞进 Context。
 */
export function defaultSummarize(toolId: string, output: unknown): string {
    if (output == null) return `${toolId} 返回空结果`
    if (typeof output === "string") {
        const text = output.trim()
        return text.length > 200 ? `${toolId} 返回文本（${text.length} 字）：${text.slice(0, 200)}…` : `${toolId}：${text}`
    }
    if (Array.isArray(output)) return `${toolId} 返回 ${output.length} 条结果`
    if (typeof output === "object") {
        const record = output as Record<string, unknown>
        for (const key of ["hits", "items", "results", "articles", "nodes", "rows"]) {
            const value = record[key]
            if (Array.isArray(value)) {
                return value.length === 0
                    ? `${toolId} 未找到结果`
                    : `${toolId} 找到 ${value.length} 条结果`
            }
        }
        if (typeof record.summary === "string" && record.summary.trim()) {
            return record.summary.trim().slice(0, 400)
        }
        return `${toolId} 返回结构化结果（字段：${Object.keys(record).slice(0, 8).join(", ")}）`
    }
    return `${toolId} 返回 ${String(output)}`
}

/** observation 渲染进 prompt 的紧凑一行 */
export function renderObservation(observation: AgentObservation): string {
    const flag = observation.isError ? "✗" : "✓"
    const actions = observation.suggestedActions?.length
        ? `（建议：${observation.suggestedActions.join(" / ")}）`
        : ""
    const refs = observation.evidenceIds.length ? ` [证据 ${observation.evidenceIds.length} 条]` : ""
    return `${flag} ${observation.source}：${observation.summary}${refs}${actions}`
}
