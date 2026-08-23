/** 整库编译由前端逐篇驱动，单次请求只处理一篇文章；仍显式声明到计划允许的时长上限 */
export const maxDuration = 300

export { wikiIngest as POST } from "@/server/kb/wiki-agent-handlers"
