import { and, desc, eq } from "drizzle-orm"
import {
    SerializablePlanSchema,
    type SerializablePlan,
} from "@/components/tool-ui/plan/schema"
import { getDb } from "@/server/db/client"
import { assistantPlans, type AssistantPlanRecord } from "@/server/db/schema"
import { badRequest, notFound } from "@/server/http/response"

export function planRecordToSerializable(row: AssistantPlanRecord): SerializablePlan | null {
    try {
        return SerializablePlanSchema.parse({
            id: row.planKey,
            title: row.title,
            description: row.description ?? undefined,
            todos: JSON.parse(row.todosJson),
        })
    } catch {
        return null
    }
}

export function planHasIncompleteTodos(plan: SerializablePlan): boolean {
    return plan.todos.some((todo) => todo.status === "pending" || todo.status === "in_progress")
}

export async function upsertAssistantPlan(input: {
    userId: number
    threadId: number
    plan: SerializablePlan
}): Promise<void> {
    const now = new Date()
    const todosJson = JSON.stringify(input.plan.todos)
    await getDb()
        .insert(assistantPlans)
        .values({
            threadId: input.threadId,
            userId: input.userId,
            planKey: input.plan.id,
            title: input.plan.title,
            description: input.plan.description ?? null,
            todosJson,
            status: "active",
            createdAt: now,
            updatedAt: now,
        })
        .onConflictDoUpdate({
            target: [assistantPlans.threadId, assistantPlans.planKey],
            set: {
                userId: input.userId,
                title: input.plan.title,
                description: input.plan.description ?? null,
                todosJson,
                status: "active",
                updatedAt: now,
            },
        })
}

export async function patchAssistantPlanTodo(input: {
    userId: number
    threadId: number
    planId: string
    todoId: string
    status: "pending" | "in_progress" | "completed" | "cancelled"
}): Promise<SerializablePlan> {
    const [row] = await getDb()
        .select()
        .from(assistantPlans)
        .where(and(
            eq(assistantPlans.threadId, input.threadId),
            eq(assistantPlans.userId, input.userId),
            eq(assistantPlans.planKey, input.planId),
            eq(assistantPlans.status, "active"),
        ))
        .limit(1)
    if (!row) throw notFound("计划不存在")
    const plan = planRecordToSerializable(row)
    if (!plan) throw badRequest("计划数据损坏")
    const todos = plan.todos.map((todo) => (
        todo.id === input.todoId ? { ...todo, status: input.status } : todo
    ))
    if (!todos.some((todo) => todo.id === input.todoId)) {
        throw notFound("步骤不存在")
    }
    const next = { ...plan, todos }
    await upsertAssistantPlan({
        userId: input.userId,
        threadId: input.threadId,
        plan: next,
    })
    return next
}

export async function listActiveAssistantPlans(input: {
    userId: number
    threadId: number
}): Promise<SerializablePlan[]> {
    const rows = await getDb()
        .select()
        .from(assistantPlans)
        .where(and(
            eq(assistantPlans.threadId, input.threadId),
            eq(assistantPlans.userId, input.userId),
            eq(assistantPlans.status, "active"),
        ))
        .orderBy(desc(assistantPlans.updatedAt), desc(assistantPlans.id))

    const plans: SerializablePlan[] = []
    for (const row of rows) {
        const plan = planRecordToSerializable(row)
        if (plan) plans.push(plan)
    }
    return plans
}
