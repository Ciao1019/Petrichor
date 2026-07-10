import { tool, type ToolSet } from "ai"
import { createTool } from "@mastra/core/tools"
import type { AgentDomainId, AssistantToolContext, AssistantToolRegistration } from "./domain-types"

// 进程内域工具注册表（契约 4.3）。工具由各域 feature 在模块加载时注册；
// runtime 每轮按意图路由结果装载子集，禁止一次挂载全站 tools。
// 站内 Assistant 运行时以 Mastra Agent 执行；loadMastraToolsForDomains 为正式装载入口。
// loadToolsForDomains 保留 AI SDK ToolSet 形态，供单测与兼容检查。

const registry = new Map<string, AssistantToolRegistration>()

export function registerAssistantTools(tools: AssistantToolRegistration[]): void {
    for (const registration of tools) {
        const existing = registry.get(registration.name)
        if (existing && existing !== registration) {
            throw new Error(`assistant 工具重名：${registration.name}`)
        }
        registry.set(registration.name, registration)
    }
}

/** @deprecated 运行时已迁 Mastra；保留供单测断言域过滤与 ctx 绑定 */
export function loadToolsForDomains(domains: AgentDomainId[], ctx: AssistantToolContext): ToolSet {
    const wanted = new Set(domains)
    const tools: ToolSet = {}
    for (const registration of registry.values()) {
        if (!wanted.has(registration.domain)) continue
        tools[registration.name] = tool({
            description: registration.description,
            inputSchema: registration.inputSchema,
            execute: async (input: unknown) => await registration.execute(ctx, input),
        })
    }
    return tools
}

export function loadMastraToolsForDomains(domains: AgentDomainId[], ctx: AssistantToolContext) {
    const wanted = new Set(domains)
    const tools: Record<string, ReturnType<typeof createTool>> = {}
    for (const registration of registry.values()) {
        if (!wanted.has(registration.domain)) continue
        tools[registration.name] = createTool({
            id: registration.name,
            description: registration.description,
            inputSchema: registration.inputSchema,
            execute: async (input: unknown) => await registration.execute(ctx, input),
        })
    }
    return tools
}

export function getAssistantToolDomain(name: string): AgentDomainId | null {
    return registry.get(name)?.domain ?? null
}

export function clearAssistantToolRegistryForTests(): void {
    registry.clear()
}
