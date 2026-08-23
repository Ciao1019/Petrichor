/** 单篇知识构建包含多轮模型调用，长文耗时较长；显式声明到计划允许的时长上限 */
export const maxDuration = 300

export { articleKnowledgeBuild as POST } from "@/server/kb/wiki-agent-handlers"
