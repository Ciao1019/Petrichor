import "../../tools"
import { agentToolRegistry } from "../tool-registry"
import { agentSkillRegistry } from "../skill-registry"
import { agentMetaTools } from "./agent"
import { graphTools } from "./graph"
import { knowledgeTools, wikiQaTools } from "./knowledge"
import { documentExportTools } from "./document"
import { buildLegacyAgentTools } from "./legacy"
import { memoryTools } from "./memory"
import { writerTools } from "./writer"
import { researchTools } from "./research"
import type { AgentToolDefinition } from "../types"

/**
 * Agent 工具装配入口（§12）。
 *
 * 模块加载即完成注册：Runtime / Skill / SubAgent 之后都只从 agentToolRegistry 取工具，
 * 不再出现散落 import 现拼工具集的写法。
 */

let registered = false

export function buildAllAgentTools(): AgentToolDefinition[] {
    return [
        ...agentMetaTools,
        ...knowledgeTools,
        ...wikiQaTools,
        ...graphTools,
        ...researchTools,
        ...writerTools,
        ...memoryTools,
        ...documentExportTools,
        ...buildLegacyAgentTools(),
    ]
}

export function registerAgentTools(): void {
    if (registered) return
    registered = true
    agentToolRegistry.registerMany(buildAllAgentTools())
    pruneSkillToolIds()
}

/**
 * 技能声明的工具与实际注册表对齐：
 * 去掉未实现的 toolId，避免 Skill 加载后暴露空能力（§111 元数据不重复定义）。
 */
function pruneSkillToolIds(): void {
    for (const skill of agentSkillRegistry.list()) {
        const available = skill.toolIds.filter((id) => agentToolRegistry.has(id))
        if (available.length !== skill.toolIds.length) {
            agentSkillRegistry.register({ ...skill, toolIds: available })
        }
    }
}

export function resetAgentToolsForTests(): void {
    registered = false
    agentToolRegistry.clear()
}

registerAgentTools()
