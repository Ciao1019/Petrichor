import type { NextRequest } from "next/server"
import {
    convertToModelMessages,
    createUIMessageStream,
    createUIMessageStreamResponse,
    type UIMessage,
    type UIMessageChunk,
} from "ai"
import { z } from "zod"
import { createChatLanguageModel } from "@/server/ai/generation"
import { badRequest, forbidden, toErrorResponse } from "@/server/http/response"
import { loadCachedPublicSiteAppearance } from "@/server/appearance/public-loader"
import {
    consumePublicQaQuota,
    resolveClientIp,
    resolveVisitorId,
} from "@/server/kb/public-qa-rate-limit"
import { buildPublicQaAgentTools } from "@/server/kb/public-agent-tools"
import { getSiteOwnerUserId, loadPublicArticleScope } from "@/server/kb/public-qa-logic"
import { extractLastUserText } from "@/server/assistant/message-text"
import { createAgentEventWriter } from "@/server/assistant/agent-runtime/chat-bridge"
import { AgentSkillRegistry } from "@/server/assistant/agent-runtime/skill-registry"
import { AgentToolRegistry } from "@/server/assistant/agent-runtime/tool-registry"
import { PetrichorAgentRuntime } from "@/server/assistant/agent-runtime/runtime"

/**
 * 前台公开问答（/ask）入口。
 *
 * 与后台 /api/assistant/chat 共用同一套 PetrichorAgentRuntime v2：
 * 相同的 Agentic Loop、证据管线、事件流与前端交互；差异只有三点：
 * 1. 匿名访问：不登录，以站点 owner 的 AI 配置驱动模型，靠功能开关 + 访客限流控制；
 * 2. 数据边界：全部检索/读取工具经 loadPublicArticleScope() 公开白名单收窄，
 *    只能读取「已公开分享」的文章及其 Wiki 页面；
 * 3. 检索范围：不提供知识库选择，始终全库检索后按白名单收窄。
 *
 * 匿名场景不做任何持久化（无线程、无 Run 落库），只做纯流式问答。
 */

export const maxDuration = 300

const chatRequestSchema = z.object({
    messages: z.array(z.unknown()).min(1),
    /** 与后台一致的请求体协议；同时兼容旧的 X-Petrichor-Qa-Mode 请求头 */
    qaMode: z.enum(["normal", "wiki"]).optional(),
})

/** 与后台 chat 相同的上下文预算 */
const MAX_CONTEXT_TOKENS = 100_000

function resolveQaMode(request: NextRequest, bodyQaMode?: "normal" | "wiki"): "normal" | "wiki" {
    if (bodyQaMode) return bodyQaMode
    return request.headers.get("x-petrichor-qa-mode") === "wiki" ? "wiki" : "normal"
}

export async function publicQaChat(request: NextRequest) {
    try {
        const appearance = await loadCachedPublicSiteAppearance()
        if (!appearance.publicQaEnabled) {
            throw forbidden("站长已关闭前台问答功能")
        }

        const input = chatRequestSchema.parse(await request.json())

        // 限流：visitor-id 主键（10/h）+ IP 兜底（60/h）。
        const visitorId = resolveVisitorId(request)
        const quota = await consumePublicQaQuota({
            visitorId,
            ip: resolveClientIp(request),
        })

        // 访客不配模型：以站点 owner（首个 SUPER_ADMIN）的默认 AI 配置驱动
        const ownerUserId = await getSiteOwnerUserId()
        if (ownerUserId == null) {
            throw badRequest("公开问答暂不可用：站点尚未初始化站长账号")
        }
        const { model, resolved } = await createChatLanguageModel({ userId: ownerUserId, modelRefId: null })

        // 公开白名单是本次请求内所有工具的唯一可达边界
        const scope = await loadPublicArticleScope()
        const toolRegistry = new AgentToolRegistry()
        toolRegistry.registerMany(buildPublicQaAgentTools(scope))

        const runtime = new PetrichorAgentRuntime({
            tools: toolRegistry,
            // 空技能注册表：匿名访客不可加载任何动态能力（load_skill 工具本身也不在注册表中）
            skills: new AgentSkillRegistry(),
        })

        const mode = resolveQaMode(request, input.qaMode)
        const goal = extractLastUserText(input.messages)

        const stream = createUIMessageStream<UIMessage>({
            originalMessages: input.messages as UIMessage[],
            execute: async ({ writer }) => {
                const events = createAgentEventWriter({
                    write: (chunk) => writer.write(chunk as UIMessageChunk),
                })
                try {
                    await runtime.run({
                        conversationId: `public-qa:${visitorId || "anonymous"}`,
                        userId: ownerUserId,
                        qaMode: mode,
                        goal,
                        messages: await convertToModelMessages(input.messages as UIMessage[]) as unknown[],
                        model,
                        modelName: String(resolved.model.modelId ?? resolved.model.id),
                        startedAt: Date.now(),
                        turnCount: input.messages.length,
                        abortSignal: request.signal,
                        injectionGuard: {
                            providerKey: resolved.provider.providerKey,
                            modelId: resolved.model.modelId,
                        },
                        isOperator: false,
                        systemRole: null,
                        contextTokenLimit: MAX_CONTEXT_TOKENS,
                        onEvent: events.onEvent,
                    })
                    events.finalize()
                } catch (error) {
                    events.finalize()
                    throw error
                }
            },
        })

        return createUIMessageStreamResponse({
            stream,
            headers: {
                "X-Petrichor-Qa-Remaining": String(quota.remaining),
                "X-Petrichor-Qa-Limit": String(quota.limit),
            },
        })
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}
