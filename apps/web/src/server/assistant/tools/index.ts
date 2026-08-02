import type { AssistantToolRegistration } from "../domain-types"
import { registerAssistantTools } from "../tool-registry"
import { adminAssistantTools } from "./admin"
import { contentWriteAssistantTools } from "./content-write"
import { docLibraryAssistantTools } from "./doc-library"
import { knowledgeAssistantTools } from "./knowledge"
import { researchFanoutTools } from "./research-fanout"
import { researchSubagentTools } from "./research-subagent"
import { systemAssistantTools } from "./system"
import { loadSkillTools } from "./load-skill"
import { memoryManageTools } from "./memory-manage"
import { searchOperatorHistoryTools } from "./search-operator-history"
import { writeSubagentTools } from "./write-subagent"

export const readonlyAssistantTools: AssistantToolRegistration[] = [
    ...knowledgeAssistantTools,
    ...docLibraryAssistantTools,
    ...systemAssistantTools,
    ...loadSkillTools,
    ...researchSubagentTools,
    ...researchFanoutTools,
]

export const allAssistantTools: AssistantToolRegistration[] = [
    ...readonlyAssistantTools,
    ...memoryManageTools,
    ...searchOperatorHistoryTools,
    ...contentWriteAssistantTools,
    ...writeSubagentTools,
    ...adminAssistantTools,
]

export function registerReadonlyAssistantTools(): void {
    registerAssistantTools(readonlyAssistantTools)
}

export function registerAllAssistantTools(): void {
    registerAssistantTools(allAssistantTools)
}

registerAllAssistantTools()
