import { readRouterMode } from "./config"
import { routeAssistantIntent } from "../intent-router"
import type { AgentDomainId, AssistantFocus } from "../domain-types"
import type { RoutingHint } from "./types"

/**
 * Soft Router（§5/§84/§128）。
 *
 * 只输出提示，永远不裁剪 Agent 能力：
 * - 结果只用于 Skill 预加载、工具排序、Prompt 提示、Trace 与 Eval；
 * - 规则优先、低延迟，失败一律返回 null，绝不阻塞主流程；
 * - 生产路径不存在 hard 模式。
 */
export async function resolveRoutingHint(input: {
    userText: string
    focus: AssistantFocus | null
    recentToolNames?: string[]
    recentIntentDomains?: AgentDomainId[]
}): Promise<RoutingHint | null> {
    if (readRouterMode() === "disabled") return null
    try {
        const route = await routeAssistantIntent({
            userText: input.userText,
            focus: input.focus,
            recentToolNames: input.recentToolNames ?? [],
            recentIntentDomains: input.recentIntentDomains ?? [],
        })
        return {
            domains: route.domains,
            confidence: route.confidence,
            ...(route.rationale ? { reasoning: route.rationale } : {}),
        }
    } catch {
        // Router 失败不影响 Main Agent（§141）
        return null
    }
}
