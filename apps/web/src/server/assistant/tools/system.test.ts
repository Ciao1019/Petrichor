import { beforeEach, describe, expect, it, vi } from "vitest"
import { SerializableCitationSchema } from "@/components/tool-ui/citation/schema"
import { SerializableDataTableSchema } from "@/components/tool-ui/data-table/schema"
import { SerializablePlanSchema } from "@/components/tool-ui/plan/schema"
import { SerializableProgressTrackerSchema } from "@/components/tool-ui/progress-tracker/schema"
import type { AssistantToolContext } from "../domain-types"

const dbMocks = vi.hoisted(() => ({
    getDb: vi.fn(),
}))
const logMocks = vi.hoisted(() => ({ error: vi.fn() }))

vi.mock("@/server/db/client", () => dbMocks)
vi.mock("@/lib/logger", () => ({
    createLogger: () => logMocks,
    toLogError: (error: unknown) => error instanceof Error ? error : new Error(String(error)),
}))

import { listSystemOverview, saveAnswerArtifact, systemAssistantTools } from "./system"

const ctx: AssistantToolContext = {
    userId: 7,
    threadId: 11,
    runId: 13,
    focus: null,
}

type QueryChain = {
    from: ReturnType<typeof vi.fn>
    innerJoin: ReturnType<typeof vi.fn>
    limit: ReturnType<typeof vi.fn>
    returning: ReturnType<typeof vi.fn>
    then: Promise<unknown>["then"]
    values: ReturnType<typeof vi.fn>
    where: ReturnType<typeof vi.fn>
}

function createQueryChain(result: unknown): QueryChain {
    const chain = {} as QueryChain
    chain.from = vi.fn(() => chain)
    chain.innerJoin = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    chain.returning = vi.fn(async () => result)
    chain.values = vi.fn(() => chain)
    chain.where = vi.fn(() => chain)
    chain.then = (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected)
    return chain
}

function findTool(name: string) {
    const registration = systemAssistantTools.find((tool) => tool.name === name)
    if (!registration) throw new Error(`未找到工具：${name}`)
    return registration
}

describe("system assistant tools", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("list_system_overview 返回当前用户计数与用途绑定就绪状态", async () => {
        // 前 5 次是各实体计数，后 2 次是 CHAT / EMBEDDING 的用途绑定探测
        const selectResults = [
            [{ total: 2 }],
            [{ total: 15 }],
            [{ total: 1 }],
            [{ total: 8 }],
            [{ total: 4 }],
            [{ id: 1 }],
            [],
        ]
        let selectIndex = 0
        const db = {
            select: vi.fn(() => createQueryChain(selectResults[selectIndex++] ?? [])),
        }
        dbMocks.getDb.mockReturnValue(db)

        await expect(listSystemOverview(ctx.userId)).resolves.toEqual({
            knowledgeBases: 2,
            articles: 15,
            docLibraries: 1,
            documents: 8,
            assistantThreads: 4,
            chatModelReady: true,
            embeddingModelReady: false,
        })
        expect(db.select).toHaveBeenCalledTimes(7)
    })

    it("save_answer_artifact 把 thread/run/kind/title/content_json 写入既有表", async () => {
        const insertChain = createQueryChain([{ id: 21 }])
        const db = { insert: vi.fn(() => insertChain) }
        dbMocks.getDb.mockReturnValue(db)

        const result = await saveAnswerArtifact(ctx, {
            artifactType: "report",
            title: "部署报告",
            contentMd: "# 结论",
            payload: { passed: true },
        })

        expect(insertChain.values).toHaveBeenCalledWith({
            threadId: 11,
            runId: 13,
            kind: "report",
            title: "部署报告",
            contentJson: JSON.stringify({
                contentMd: "# 结论",
                payload: { passed: true },
            }),
        })
        expect(result).toEqual({ id: "21", artifactType: "report", title: "部署报告" })
    })

    it("upsert_plan 回显 Plan 并尝试落库", async () => {
        const onConflictDoUpdate = vi.fn(async () => undefined)
        const values = vi.fn(() => ({ onConflictDoUpdate }))
        const insert = vi.fn(() => ({ values }))
        dbMocks.getDb.mockReturnValue({ insert })

        const input = {
            id: "plan-deploy",
            title: "部署计划",
            todos: [
                { id: "build", label: "构建", status: "completed" as const },
                { id: "deploy", label: "部署", status: "in_progress" as const },
            ],
        }
        const output = await findTool("upsert_plan").execute(ctx, input)

        expect(SerializablePlanSchema.parse(output)).toEqual(input)
        expect(insert).toHaveBeenCalled()
        expect(values).toHaveBeenCalledWith(expect.objectContaining({
            threadId: 11,
            userId: 7,
            planKey: "plan-deploy",
        }))
        expect(() => findTool("upsert_plan").inputSchema.parse({
            ...input,
            todos: [{ id: "build", label: "构建", status: "done" }],
        })).toThrow()
    })

    it("upsert_plan 落库失败时仍返回 Plan（fail-open）", async () => {
        const values = vi.fn(() => ({
            onConflictDoUpdate: vi.fn(async () => {
                throw new Error("db down")
            }),
        }))
        dbMocks.getDb.mockReturnValue({
            insert: vi.fn(() => ({ values })),
        })
        const input = {
            id: "plan-1",
            title: "计划",
            todos: [{ id: "a", label: "A", status: "pending" as const }],
        }
        await expect(findTool("upsert_plan").execute(ctx, input)).resolves.toEqual(input)
        expect(logMocks.error).toHaveBeenCalledWith(expect.objectContaining({
            err: expect.any(Error),
            userId: 7,
            threadId: 11,
        }), expect.any(String))
    })

    it("三个 UI 回显工具的输出均符合现有组件 schema", async () => {
        const progress = await findTool("show_progress").execute(ctx, {
            id: "progress-search",
            steps: [{ id: "search", label: "检索", status: "completed" }],
        })
        expect(SerializableProgressTrackerSchema.parse(progress)).toEqual(progress)

        const citations = await findTool("show_citations").execute(ctx, {
            id: "citations-answer",
            citations: [{
                id: "article-3",
                href: "/dashboard/knowledge/2/articles/3",
                title: "部署说明",
                type: "article",
            }],
            variant: "default",
        }) as { citations: unknown[] }
        expect(citations.citations.map((item) => SerializableCitationSchema.parse(item))).toHaveLength(1)

        const table = await findTool("show_data_table").execute(ctx, {
            id: "table-counts",
            title: "系统计数",
            columns: [{ key: "name", label: "项目" }, { key: "count", label: "数量" }],
            data: [{ name: "知识库", count: 2 }],
        })
        expect(SerializableDataTableSchema.parse(table)).toMatchObject({ id: "table-counts" })
    })

    it("system 域仅 save_answer_artifact 为 write，其余工具均为 read", () => {
        expect(systemAssistantTools.map(({ name, risk }) => ({ name, risk }))).toEqual([
            { name: "list_system_overview", risk: "read" },
            { name: "show_progress", risk: "read" },
            { name: "show_citations", risk: "read" },
            { name: "show_data_table", risk: "read" },
            { name: "save_answer_artifact", risk: "write" },
            { name: "upsert_plan", risk: "read" },
        ])
    })
})
