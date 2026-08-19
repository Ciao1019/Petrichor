import { retrieveTreeNodesForAgent, semanticSearchTreeNodes } from "@/server/kb/wiki-tree"
import { bm25RecallTreeNodes } from "@/server/kb/knowledge-recall"

const USER_ID = 2
const KB_ID = 1

async function timed<T>(label: string, run: () => Promise<T>): Promise<void> {
    const start = Date.now()
    try {
        const result = await run()
        const count = Array.isArray(result) ? result.length : 0
        console.log(`${label}: ${Date.now() - start}ms, ${count} 条`)
    } catch (error) {
        console.log(`${label}: ${Date.now() - start}ms, 失败 ${(error as Error).message.slice(0, 120)}`)
    }
}

console.log("单条查询各路召回耗时：")
await timed("  tree  (LLM 目录导航)", () =>
    retrieveTreeNodesForAgent({ userId: USER_ID, knowledgeBaseId: KB_ID, query: "小鼹鼠", limit: 10, maxContentChars: 600 }))
await timed("  vector(embedding)   ", () =>
    semanticSearchTreeNodes({ userId: USER_ID, knowledgeBaseId: KB_ID, query: "小鼹鼠", limit: 10, maxContentChars: 600 }))
await timed("  bm25  (纯 SQL)      ", () =>
    bm25RecallTreeNodes({ userId: USER_ID, knowledgeBaseId: KB_ID, query: "小鼹鼠", limit: 10 }))

process.exit(0)
