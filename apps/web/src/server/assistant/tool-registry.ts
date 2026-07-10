import { tool, type ToolSet } from "ai"
import { createTool } from "@mastra/core/tools"
import type { AgentDomainId, AssistantToolContext, AssistantToolRegistration } from "./domain-types"
import type { ToolResilienceController } from "./tool-resilience"

// 进程内域工具注册表（契约 4.3）。工具由各域 feature 在模块加载时注册；
// runtime 每轮按意图路由结果装载子集，禁止一次挂载全站 tools。
// 站内 Assistant 运行时以 Mastra Agent 执行；loadMastraToolsForDomains 为正式装载入口。
// loadToolsForDomains 保留 AI SDK ToolSet 形态，供单测与兼容检查。

const registry = new Map<string, AssistantToolRegistration>()

export function registerAssistantTools(tools: AssistantToolRegistration[]): void {
    // 同一次调用内的真重名仍抛错；跨次调用同名覆盖（Next.js HMR 下 tools 模块重载、registry 未重载时对象引用会变）
    const batchNames = new Set<string>()
    for (const registration of tools) {
        if (batchNames.has(registration.name)) {
            throw new Error(`assistant 工具重名：${registration.name}`)
        }
        batchNames.add(registration.name)
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

export function loadMastraToolsForDomains(
    domains: AgentDomainId[],
    ctx: AssistantToolContext,
    resilience?: ToolResilienceController,
) {
    const wanted = new Set(domains)
    const tools: Record<string, ReturnType<typeof createTool>> = {}
    for (const registration of registry.values()) {
        if (!wanted.has(registration.domain)) continue
        const toolName = registration.name
        tools[toolName] = createTool({
            id: toolName,
            description: registration.description,
            inputSchema: registration.inputSchema,
            execute: async (input: unknown) => {
                const run = () => registration.execute(ctx, input)
                return resilience ? await resilience.run(toolName, run) : await run()
            },
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
