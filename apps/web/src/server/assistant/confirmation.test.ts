import { beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"

import {
    assertConfirmationAction,
    buildRequestUserConfirmationTool,
    executeConfirmedDangerousAction,
    findPendingConfirmationExecution,
    isDangerousToolName,
    patchConfirmationExecutionOutcome,
} from "./confirmation"
import type { AssistantToolContext, AssistantToolRegistration } from "./domain-types"
import {
    clearAssistantToolRegistryForTests,
    loadMastraToolsForDomains,
    loadToolsForDomains,
    registerAssistantTools,
} from "./tool-registry"

const ctx: AssistantToolContext = { userId: 1, threadId: 2, runId: 3, focus: null }

function makeDangerous(name: string, execute: AssistantToolRegistration["execute"]): AssistantToolRegistration {
    return {
        name,
        domain: "content_write",
        risk: "dangerous",
        description: "test",
        inputSchema: z.object({ articleId: z.union([z.string(), z.number()]) }),
        execute,
    }
}

beforeEach(() => {
    clearAssistantToolRegistryForTests()
})

describe("confirmation protocol", () => {
    it("危险工具名识别与白名单映射", () => {
        expect(isDangerousToolName("delete_article")).toBe(true)
        expect(isDangerousToolName("create_article")).toBe(false)
    })

    it("装载时不对模型暴露 dangerous 工具", () => {
        registerAssistantTools([
            buildRequestUserConfirmationTool(),
            makeDangerous("delete_article", async () => ({ deleted: true })),
            {
                name: "create_article",
                domain: "content_write",
                risk: "write",
                description: "create",
                inputSchema: z.object({}),
                execute: async () => ({ ok: true }),
            },
        ])
        expect(Object.keys(loadToolsForDomains(["content_write"], ctx)).sort()).toEqual([
            "create_article",
            "request_user_confirmation",
        ])
        expect(Object.keys(loadMastraToolsForDomains(["content_write"], ctx)).sort()).toEqual([
            "create_article",
            "request_user_confirmation",
        ])
    })

    it("确认后 Runtime 执行危险工具；直接 execute 可走 __confirmExec", async () => {
        let ran = false
        registerAssistantTools([
            buildRequestUserConfirmationTool(),
            makeDangerous("delete_article", async (toolCtx) => {
                if (!(toolCtx as AssistantToolContext & { __confirmExec?: boolean }).__confirmExec) {
                    throw new Error("blocked")
                }
                ran = true
                return { deleted: true }
            }),
        ])
        const outcome = await executeConfirmedDangerousAction(ctx, {
            toolName: "delete_article",
            input: { articleId: "9" },
        })
        expect(ran).toBe(true)
        expect(outcome).toEqual({ deleted: true })
        expect(() => assertConfirmationAction({ toolName: "create_article", input: {} })).toThrow(/未知危险工具/)
    })

    it("从消息中找出待执行确认，并回写 executionOutcome", () => {
        const messages = [{
            role: "assistant",
            parts: [{
                type: "tool-call",
                toolName: "request_user_confirmation",
                args: {
                    id: "c1",
                    title: "删除文章",
                    risk: "dangerous",
                    action: { toolName: "delete_article", input: { articleId: "3" } },
                },
                result: { confirmed: true, confirmationId: "c1" },
            }],
        }]
        expect(findPendingConfirmationExecution(messages)).toEqual({
            confirmationId: "c1",
            action: { toolName: "delete_article", input: { articleId: "3" } },
        })
        const patched = patchConfirmationExecutionOutcome(messages, "c1", { deleted: true })
        expect(findPendingConfirmationExecution(patched)).toBeNull()
        expect((patched[0] as { parts: { result: { executionOutcome: unknown } }[] }).parts[0].result.executionOutcome)
            .toEqual({ deleted: true })
    })

    it("request_user_confirmation 校验 action 白名单", async () => {
        registerAssistantTools([
            buildRequestUserConfirmationTool(),
            makeDangerous("delete_article", async () => ({ deleted: true })),
        ])
        const tool = buildRequestUserConfirmationTool()
        await expect(tool.execute(ctx, {
            id: "c2",
            title: "删",
            risk: "dangerous",
            action: { toolName: "delete_article", input: { articleId: 1 } },
        })).resolves.toMatchObject({ id: "c2" })
        await expect(tool.execute(ctx, {
            id: "c3",
            title: "坏",
            risk: "dangerous",
            action: { toolName: "not_a_tool", input: {} },
        })).rejects.toThrow(/未知危险工具/)
    })
})
