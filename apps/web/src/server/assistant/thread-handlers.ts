import type { AppRequest } from "@/server/http/request"
import { z } from "zod"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, readJson, toErrorResponse } from "@/server/http/response"
import { assertAssistantFocusOwnership } from "./focus-guard"
import { patchAssistantPlanTodo } from "./plan-store"
import {
    assistantFocusSchema,
    assistantIdSchema,
    assistantThreadDeleteManySchema,
    assistantThreadListSchema,
    createAssistantThread,
    getAssistantThreadDetail,
    listAssistantThreads,
    softDeleteAssistantThread,
    softDeleteAssistantThreads,
    toAssistantThreadResponse,
} from "./thread-logic"

const threadIdInputSchema = z.object({
    threadId: assistantIdSchema,
})

const threadCreateInputSchema = z.object({
    title: z.string().trim().max(120).optional().nullable(),
    focus: assistantFocusSchema.optional().nullable(),
})

const planTodoPatchSchema = z.object({
    threadId: assistantIdSchema,
    planId: z.string().trim().min(1).max(120),
    todoId: z.string().trim().min(1).max(120),
    status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
})

export async function assistantThreadList(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = assistantThreadListSchema.parse(await readJson(request).catch(() => ({})))
        return ok(await listAssistantThreads({
            userId: user.id,
            cursor: input.cursor,
            limit: input.limit,
            q: input.q,
        }))
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

export async function assistantThreadDetail(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = threadIdInputSchema.parse(await readJson(request))
        return ok(await getAssistantThreadDetail({ userId: user.id, threadId: input.threadId }))
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

export async function assistantThreadCreate(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = threadCreateInputSchema.parse(await readJson(request).catch(() => ({})))
        const focus = input.focus ?? null
        await assertAssistantFocusOwnership(user.id, focus)
        const thread = await createAssistantThread({
            userId: user.id,
            title: input.title ?? null,
            focus,
        })
        return ok({ thread: toAssistantThreadResponse(thread) })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

export async function assistantThreadDelete(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = threadIdInputSchema.parse(await readJson(request))
        return ok(await softDeleteAssistantThread({ userId: user.id, threadId: input.threadId }))
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

export async function assistantThreadDeleteMany(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = assistantThreadDeleteManySchema.parse(await readJson(request))
        return ok(await softDeleteAssistantThreads(user.id, input.threadIds))
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

export async function assistantPlanTodoPatch(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = planTodoPatchSchema.parse(await readJson(request))
        const plan = await patchAssistantPlanTodo({
            userId: user.id,
            threadId: input.threadId,
            planId: input.planId,
            todoId: input.todoId,
            status: input.status,
        })
        return ok({ plan })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}
