import { z } from "zod"
import type { AssistantToolRegistration } from "../domain-types"
import { isAssistantOperator } from "../operator-gate"
import { searchOperatorHistory } from "../operator-episodic"

const schema = z.object({
    query: z.string().trim().min(1).max(500),
    mode: z.enum(["keyword", "semantic", "both"]).optional().default("both"),
    limit: z.number().int().min(1).max(20).optional().default(8),
    excludeCurrentThread: z.boolean().optional().default(true),
})

export const searchOperatorHistoryTools: AssistantToolRegistration[] = [
    {
        name: "search_operator_history",
        domain: "system",
        risk: "read",
        requiresOperator: true,
        description:
            "跨线程检索操作员历史对话（关键词 FTS + 语义向量）。需要回想以前某次做法时调用；不要把整段历史塞进回答。",
        inputSchema: schema,
        execute: async (ctx, input) => {
            if (!isAssistantOperator({ id: ctx.userId, systemRole: ctx.systemRole })) {
                return { ok: false, errorCode: "assistant_operator_only" }
            }
            const parsed = schema.parse(input)
            const hits = await searchOperatorHistory({
                userId: ctx.userId,
                query: parsed.query,
                mode: parsed.mode,
                limit: parsed.limit,
                excludeThreadId: parsed.excludeCurrentThread ? ctx.threadId : null,
            })
            return { ok: true, hits }
        },
    },
]
