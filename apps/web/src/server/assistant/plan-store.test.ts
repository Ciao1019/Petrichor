import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SerializablePlan } from "@/components/tool-ui/plan/schema"

const dbMocks = vi.hoisted(() => ({
    getDb: vi.fn(),
}))

vi.mock("@/server/db/client", () => dbMocks)

import {
    listActiveAssistantPlans,
    planHasIncompleteTodos,
    planRecordToSerializable,
    upsertAssistantPlan,
} from "./plan-store"

const samplePlan: SerializablePlan = {
    id: "p1",
    title: "盘点知识库",
    description: "先概览再列表",
    todos: [
        { id: "t1", label: "概览", status: "completed" },
        { id: "t2", label: "列表", status: "pending" },
    ],
}

describe("plan-store helpers", () => {
    it("planRecordToSerializable 把 plan_key 映射为 Plan.id", () => {
        const plan = planRecordToSerializable({
            id: 9,
            threadId: 11,
            userId: 7,
            planKey: "p1",
            title: "盘点知识库",
            description: "先概览再列表",
            todosJson: JSON.stringify(samplePlan.todos),
            status: "active",
            createdAt: new Date(),
            updatedAt: new Date(),
        })
        expect(plan).toEqual(samplePlan)
    })

    it("todos_json 损坏时返回 null", () => {
        expect(planRecordToSerializable({
            id: 9,
            threadId: 11,
            userId: 7,
            planKey: "p1",
            title: "坏",
            description: null,
            todosJson: "{bad",
            status: "active",
            createdAt: new Date(),
            updatedAt: new Date(),
        })).toBeNull()
    })

    it("planHasIncompleteTodos 识别 pending / in_progress", () => {
        expect(planHasIncompleteTodos(samplePlan)).toBe(true)
        expect(planHasIncompleteTodos({
            ...samplePlan,
            todos: samplePlan.todos.map((todo) => ({ ...todo, status: "completed" as const })),
        })).toBe(false)
    })
})

describe("upsertAssistantPlan / listActiveAssistantPlans", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("upsert 写入 thread/user/plan_key 并 onConflict 覆盖", async () => {
        const onConflictDoUpdate = vi.fn(async () => undefined)
        const values = vi.fn(() => ({ onConflictDoUpdate }))
        const insert = vi.fn(() => ({ values }))
        dbMocks.getDb.mockReturnValue({ insert })

        await upsertAssistantPlan({ userId: 7, threadId: 11, plan: samplePlan })

        expect(insert).toHaveBeenCalled()
        expect(values).toHaveBeenCalledWith(expect.objectContaining({
            threadId: 11,
            userId: 7,
            planKey: "p1",
            title: "盘点知识库",
            status: "active",
        }))
        expect(onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
            set: expect.objectContaining({
                title: "盘点知识库",
                status: "active",
            }),
        }))
    })

    it("list 只返回可解析的 active plans", async () => {
        const rows = [
            {
                id: 1,
                threadId: 11,
                userId: 7,
                planKey: "p1",
                title: "盘点知识库",
                description: null,
                todosJson: JSON.stringify(samplePlan.todos),
                status: "active",
                createdAt: new Date(),
                updatedAt: new Date(),
            },
            {
                id: 2,
                threadId: 11,
                userId: 7,
                planKey: "bad",
                title: "坏",
                description: null,
                todosJson: "{",
                status: "active",
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        ]
        const orderBy = vi.fn(async () => rows)
        const where = vi.fn(() => ({ orderBy }))
        const from = vi.fn(() => ({ where }))
        const select = vi.fn(() => ({ from }))
        dbMocks.getDb.mockReturnValue({ select })

        await expect(listActiveAssistantPlans({ userId: 7, threadId: 11 })).resolves.toEqual([
            { ...samplePlan, description: undefined },
        ])
        expect(where).toHaveBeenCalled()
    })
})
