import { createRequire } from "node:module"
import { beforeAll, describe, expect, it } from "vitest"

/**
 * 持久化层真实数据库往返测试。
 *
 * 之前这层只有单测，导致「表结构没跟上代码」这类问题只能到线上才暴露。
 * 这里跑真正的 SQLite（迁移由 db/client 自动执行，SQL 与 Postgres 同源），
 * 覆盖：建 Run → 落 Trace/Evidence/SubTask → 读执行视图 → 读 Debug Trace → 列 Run。
 */

const require = createRequire(import.meta.url)
const hasSqlite = (() => {
    try {
        require("better-sqlite3")
        return true
    } catch {
        return false
    }
})()

let store: typeof import("./store")
let AgentStateStore: typeof import("./state").AgentStateStore
let EvidenceStore: typeof import("./evidence").EvidenceStore
let TraceCollector: typeof import("./trace").TraceCollector

describe.runIf(hasSqlite)("agent-runtime store 数据库往返", () => {
    beforeAll(async () => {
        process.env.PETRICHOR_DB_DIALECT = "sqlite"
        process.env.DATABASE_URL = `file:/tmp/petrichor-agent-store-${process.pid}-${Date.now()}.sqlite`
        process.env.SESSION_SECRET = "01234567890123456789012345678901"

        store = await import("./store")
        ;({ AgentStateStore } = await import("./state"))
        ;({ EvidenceStore } = await import("./evidence"))
        ;({ TraceCollector } = await import("./trace"))
    })

    function buildRun(runKey: string) {
        const state = new AgentStateStore({
            runId: runKey,
            conversationId: "17",
            userId: "2",
            goal: "我们项目 Redis 是怎么部署的？",
            complexity: "multi_step",
        })
        const evidence = new EvidenceStore()
        const trace = new TraceCollector(runKey, "17", "2", "deepseek-v4-flash")

        state.setPlan([{ goal: "检索架构文档" }, { goal: "阅读部署说明" }])
        state.markSkillLoaded("knowledge")
        state.incrementIteration()
        state.incrementToolCall()
        state.addTokenUsage({ input: 120, output: 80 })

        const items = evidence.addMany([{
            source: "knowledge",
            title: "Redis 部署说明",
            content: "使用 Sentinel 三节点部署",
            sourceId: "a1-3",
            relevance: 0.9,
            confidence: 0.8,
            metadata: { nodeKey: "a1-3", knowledgeBaseId: "5", articleId: "12" },
        }])
        state.addEvidence(items)

        trace.event("run_started", { goal: state.current.goal })
        trace.recordToolCall({
            id: "call_1",
            toolId: "knowledge.search",
            toolName: "search_knowledge",
            namespace: "knowledge",
            input: { query: "Redis 部署", apiKey: "sk-should-be-redacted" },
            rawOutput: { hits: [{ nodeKey: "a1-3" }] },
            summary: "找到 1 个相关知识节点",
            ok: true,
            durationMs: 123,
            retries: 0,
            evidenceIds: items.map((item) => item.id),
            permissionDecision: "allowed",
            startedAt: Date.now(),
        })
        trace.recordDelegation({
            taskId: "task_1",
            objective: "研究 Redis Streams",
            status: "completed",
            depth: 1,
            durationMs: 800,
            evidenceCount: 2,
            traceId: "trace_1",
        })
        state.finish("completed", "goal_completed")
        trace.finish("goal_completed")

        return { state, evidence, trace }
    }

    it("建 Run → 落库 → 读回执行视图，字段完整", async () => {
        const runKey = "run_roundtrip_1"
        const { state, evidence, trace } = buildRun(runKey)

        await store.createAgentRunRecord({
            runKey,
            conversationId: "17",
            threadId: 17,
            userId: 2,
            model: "deepseek-v4-flash",
            goal: state.current.goal,
            complexity: "multi_step",
        })
        await store.persistAgentRun({
            state: state.snapshot(),
            trace: trace.build(),
            answer: "我们用 Sentinel 三节点部署 [1]。",
            evidence: evidence.all,
        })

        const view = await store.loadAgentRunView(runKey, 2)
        expect(view).not.toBeNull()
        expect(view!.status).toBe("completed")
        expect(view!.complexity).toBe("multi_step")
        expect(view!.goal).toContain("Redis")
        expect(view!.answer).toContain("Sentinel")
        expect(view!.plan).toHaveLength(2)
        expect(view!.loadedSkills).toEqual(["knowledge"])
        expect(view!.metrics.toolCalls).toBe(1)
    })

    it("证据可读回，且带定位信息", async () => {
        const view = await store.loadAgentRunView("run_roundtrip_1", 2)
        expect(view!.evidence).toHaveLength(1)
        const [item] = view!.evidence
        expect(item.title).toBe("Redis 部署说明")
        expect(item.nodeKey).toBe("a1-3")
        expect(item.knowledgeBaseId).toBe("5")
        expect(item.relevance).toBeCloseTo(0.9, 1)
    })

    it("工具调用被还原成活动，子任务可恢复", async () => {
        const view = await store.loadAgentRunView("run_roundtrip_1", 2)
        expect(view!.activities.length).toBeGreaterThan(0)
        expect(view!.activities[0].toolId).toBe("knowledge.search")
        expect(view!.activities[0].status).toBe("completed")
        expect(view!.subagents).toHaveLength(1)
        expect(view!.subagents[0].objective).toBe("研究 Redis Streams")
    })

    it("Debug Trace 可读回，且敏感字段已脱敏", async () => {
        const trace = await store.loadAgentRunTrace("run_roundtrip_1", 2)
        expect(trace).not.toBeNull()
        expect(trace!.events.length).toBeGreaterThan(0)

        const serialized = JSON.stringify(trace!.events)
        expect(serialized).toContain("knowledge.search")
        expect(serialized).not.toContain("sk-should-be-redacted")
        expect(serialized).toContain("[redacted]")
    })

    it("按会话可列出 Run", async () => {
        const runs = await store.listAgentRunsForConversation("17", 2)
        expect(runs.map((run) => run.runKey)).toContain("run_roundtrip_1")
    })

    it("跨用户不可见", async () => {
        expect(await store.loadAgentRunView("run_roundtrip_1", 999)).toBeNull()
        expect(await store.loadAgentRunTrace("run_roundtrip_1", 999)).toBeNull()
        expect(await store.listAgentRunsForConversation("17", 999)).toEqual([])
    })

    it("不存在的 Run 返回 null 而不是抛错", async () => {
        expect(await store.loadAgentRunView("run_missing", 2)).toBeNull()
    })

    it("同一份结果重复落库是幂等的（重试/并发收尾不会写重）", async () => {
        const runKey = "run_idempotent"
        const { state, evidence, trace } = buildRun(runKey)
        const payload = {
            state: state.snapshot(),
            trace: trace.build(),
            answer: "幂等落库",
            evidence: evidence.all,
        }

        await store.createAgentRunRecord({
            runKey,
            conversationId: "17",
            threadId: 17,
            userId: 2,
            model: "deepseek-v4-flash",
            goal: state.current.goal,
            complexity: "multi_step",
        })
        await store.persistAgentRun(payload)
        await store.persistAgentRun(payload)

        const view = await store.loadAgentRunView(runKey, 2)
        expect(view!.evidence).toHaveLength(1)
        expect(view!.subagents).toHaveLength(1)
        // 工具调用不会因为重复落库翻倍
        expect(view!.activities).toHaveLength(1)
        const runs = await store.listAgentRunsForConversation("17", 2)
        expect(runs.filter((run) => run.runKey === runKey)).toHaveLength(1)
    })

    it("retryOfRunKey 会被记录，重试不复用旧 Run", async () => {
        await store.createAgentRunRecord({
            runKey: "run_retry_child",
            conversationId: "17",
            threadId: 17,
            userId: 2,
            model: "deepseek-v4-flash",
            goal: "重试同一个问题",
            complexity: "simple",
            retryOfRunKey: "run_roundtrip_1",
        })
        const trace = await store.loadAgentRunTrace("run_retry_child", 2)
        expect((trace!.run as { retryOfRunKey?: string }).retryOfRunKey).toBe("run_roundtrip_1")
    })
})
