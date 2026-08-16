import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/server/auth/current-user", () => ({ requireCurrentUser: vi.fn() }))
vi.mock("@/server/ai/generation", () => ({ createChatLanguageModel: vi.fn() }))

import { buildAssistantSystemPrompt } from "../chat-handler"
import { DANGEROUS_TOOL_WHITELIST } from "../confirmation"
import type { AssistantToolContext } from "../domain-types"
import {
    clearAssistantToolRegistryForTests,
    loadToolsForDomains,
} from "../tool-registry"
import { adminAssistantTools } from "./admin"
import { allAssistantTools, registerAllAssistantTools } from "."

const ctx: AssistantToolContext = {
    userId: 1,
    threadId: 2,
    runId: 3,
    focus: null,
}

const ADMIN_MODEL_VISIBLE = [
    "get_public_qa_setting",
    "list_agent_api_keys",
    "list_ai_models",
    "bind_ai_model",
].sort()

const ADMIN_DANGEROUS = [
    "delete_ai_provider",
    "revoke_agent_api_key",
    "set_public_qa_enabled",
    "update_ai_credential",
].sort()

describe("admin assistant tools", () => {
    beforeEach(() => {
        clearAssistantToolRegistryForTests()
        registerAllAssistantTools()
    })

    it("注册 8 个 admin 工具，装载时排除 dangerous", () => {
        expect(adminAssistantTools.map((tool) => tool.name).sort()).toEqual([
            ...ADMIN_DANGEROUS,
            ...ADMIN_MODEL_VISIBLE,
        ].sort())
        expect(Object.keys(loadToolsForDomains(["admin"], ctx)).sort()).toEqual(ADMIN_MODEL_VISIBLE)
        expect(adminAssistantTools.filter((tool) => tool.risk === "dangerous").map((t) => t.name).sort())
            .toEqual(ADMIN_DANGEROUS)
    })

    it("危险工具白名单映射齐全", () => {
        for (const name of ADMIN_DANGEROUS) {
            expect(DANGEROUS_TOOL_WHITELIST[name]).toBeTruthy()
        }
    })

    it("直接调用危险工具无副作用（拒绝对调）", async () => {
        const deleteTool = adminAssistantTools.find((tool) => tool.name === "delete_ai_provider")!
        await expect(deleteTool.execute(ctx, { providerId: 1 })).rejects.toThrow(/request_user_confirmation/)
    })

    it("admin 提示含确认纪律与管理 skill", () => {
        const prompt = buildAssistantSystemPrompt(["admin", "content_write", "system"])
        expect(prompt).toContain("admin-ops")
        expect(prompt).toContain("article-write")
        expect(prompt).toContain("request_user_confirmation")
    })

    it("默认只读三域不含 admin", () => {
        expect(Object.keys(loadToolsForDomains(["system", "knowledge", "doc_library"], ctx)))
            .not.toContain("list_ai_models")
        expect(allAssistantTools.some((tool) => tool.domain === "admin")).toBe(true)
    })
})
