import { cachePublicContent } from "@/server/public-content-cache"
import { loadPublicGraphPayload } from "./store"
import type { SiteGraphPayload } from "./types"

/**
 * 前台星图公开载荷的只读入口。
 *
 * 单独成模块，是为了让「只读」的调用方（问答图谱检索、公开 API）不必经由
 * service.ts 连带加载抽取 agent 与 AI generation 链路——那条链在助手每次请求的
 * 热路径上都会被拉进来，且在测试环境会因缺少运行时配置直接抛错。
 */

/** 前台点群载荷读缓存：与其他公开内容一致，写操作主动失效 */
const loadCachedPublicGraph = cachePublicContent("siteGraph", loadPublicGraphPayload)

export async function loadPublicSiteGraph(): Promise<SiteGraphPayload> {
    return await loadCachedPublicGraph()
}
