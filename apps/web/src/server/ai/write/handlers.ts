import { createTextStreamResponse, streamText, toTextStream } from "ai"
import type { AppRequest } from "@/server/http/request"
import { createChatLanguageModel } from "@/server/ai/generation"
import { requireCurrentUser } from "@/server/auth/current-user"
import { toErrorResponse } from "@/server/http/response"
import { validateWriteRequest } from "./actions"
import { buildWriteSystemPrompt, buildWriteUserMessage } from "./prompt"

export async function streamAiWrite(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const payload = validateWriteRequest(await request.json())
        const { model } = await createChatLanguageModel({ userId: user.id })

        const result = streamText({
            model,
            instructions: buildWriteSystemPrompt(payload.action),
            prompt: buildWriteUserMessage(payload),
            temperature: 0.4,
        })

        return createTextStreamResponse({
            stream: toTextStream({ stream: result.stream }),
            headers: {
                "Cache-Control": "no-store",
                "X-Petrichor-Write-Action": payload.action,
            },
        })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}
