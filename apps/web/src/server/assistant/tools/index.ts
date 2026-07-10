import type { AssistantToolRegistration } from "../domain-types"
import { registerAssistantTools } from "../tool-registry"
import { adminAssistantTools } from "./admin"
import { contentWriteAssistantTools } from "./content-write"
import { docLibraryAssistantTools } from "./doc-library"
import { knowledgeAssistantTools } from "./knowledge"
import { systemAssistantTools } from "./system"

export const readonlyAssistantTools: AssistantToolRegistration[] = [
    ...knowledgeAssistantTools,
    ...docLibraryAssistantTools,
    ...systemAssistantTools,
]

export const allAssistantTools: AssistantToolRegistration[] = [
    ...readonlyAssistantTools,
    ...contentWriteAssistantTools,
    ...adminAssistantTools,
]

export function registerReadonlyAssistantTools(): void {
    registerAssistantTools(readonlyAssistantTools)
}

export function registerAllAssistantTools(): void {
    registerAssistantTools(allAssistantTools)
}

registerAllAssistantTools()
