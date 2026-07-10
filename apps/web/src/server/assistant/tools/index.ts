import type { AssistantToolRegistration } from "../domain-types"
import { registerAssistantTools } from "../tool-registry"
import { docLibraryAssistantTools } from "./doc-library"
import { knowledgeAssistantTools } from "./knowledge"
import { systemAssistantTools } from "./system"

export const readonlyAssistantTools: AssistantToolRegistration[] = [
    ...knowledgeAssistantTools,
    ...docLibraryAssistantTools,
    ...systemAssistantTools,
]

export function registerReadonlyAssistantTools(): void {
    registerAssistantTools(readonlyAssistantTools)
}

registerReadonlyAssistantTools()
