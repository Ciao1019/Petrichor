// 抽取 Agent 需要按批调用模型，文章多时耗时较长，放宽到平台上限
export const maxDuration = 300

export { adminSiteGraphGenerate as POST } from "@/server/site-graph/handlers"
