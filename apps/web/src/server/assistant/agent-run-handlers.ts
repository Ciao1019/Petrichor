import type { AppRequest } from "@/server/http/request"
import { z } from "zod"
import { requireCurrentUser } from "@/server/auth/current-user"
import { forbidden, notFound, ok, readJson, toErrorResponse } from "@/server/http/response"
import { readAgentFeatureFlags } from "./agent-runtime/config"
import {
    listAgentRunsForConversation,
    loadAgentRunTrace,
    loadAgentRunView,
} from "./agent-runtime/store"
import { describeStopReasonForUser } from "./agent-runtime/stop-policy"
import { isAssistantOperator } from "./operator-gate"

/**
 * Agent Run 查询接口（§162.29/§162.37/§162.38）。
 *
 * - agentRunDetail：普通 Chat UI 用，只返回经过安全处理的执行视图（不含 raw args / 内部 prompt）；
 * - agentRunTrace：Debug UI 用，返回完整 Trace，需操作员或显式开启 AGENT_DEBUG。
 */

const runIdSchema = z.object({
    runId: z.string().trim().min(1).max(64),
})

const conversationSchema = z.object({
    conversationId: z.string().trim().min(1).max(64),
    limit: z.number().int().min(1).max(100).optional(),
})

export async function agentRunDetail(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = runIdSchema.parse(await readJson(request))
        const view = await loadAgentRunView(input.runId, user.id)
        if (!view) throw notFound("Agent Run 不存在")

        return ok({
            ...view,
            // 停止原因转成用户可读文案，内部策略名只留在 Debug 通道
            stopMessage: describeStopReasonForUser(view.stopReason as never) ?? undefined,
        })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

export async function agentRunList(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = conversationSchema.parse(await readJson(request))
        return ok({
            runs: await listAgentRunsForConversation(input.conversationId, user.id, input.limit ?? 50),
        })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

export async function agentRunTrace(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const operator = isAssistantOperator({ id: user.id, systemRole: user.systemRole })
        if (!operator && !readAgentFeatureFlags().debug) {
            throw forbidden("agent_debug_disabled")
        }
        const input = runIdSchema.parse(await readJson(request))
        const trace = await loadAgentRunTrace(input.runId, user.id)
        if (!trace) throw notFound("Agent Run 不存在")
        return ok(trace)
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}
