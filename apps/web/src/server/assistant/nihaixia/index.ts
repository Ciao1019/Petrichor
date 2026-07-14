import type { AssistantFocus, AssistantPersona } from "../domain-types"

// 倪海厦旁路运行时的对外入口：人格常量、focus 判定、工具/技能/提示词导出。

export const NIHAIXIA_PERSONA: AssistantPersona = "nihaixia"

/** focus 是否命中倪海厦旁路（命中则 chat-handler 走脱离业务的独立运行时）。 */
export function isNihaixiaFocus(focus: AssistantFocus | null | undefined): boolean {
    return focus?.persona === NIHAIXIA_PERSONA
}

export { buildNihaixiaTools, NIHAIXIA_TOOL_NAMES } from "./tools"
export { nihaixiaSkill, buildNihaixiaSystemPrompt } from "./skill"
