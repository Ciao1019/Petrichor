export { articleKnowledgeBuild as POST } from "@/server/kb/wiki-agent-handlers"

// after() 中的后台构建仍受 Route Handler 最大执行时长约束。
export const maxDuration = 300
