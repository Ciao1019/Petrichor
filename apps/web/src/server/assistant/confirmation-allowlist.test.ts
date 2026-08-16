import { describe, expect, it } from "vitest"
import {
    DESTRUCTIVE_CRITICAL_TOOL_NAMES,
    isAllowlistExpired,
    isDestructiveCriticalTool,
    parseDangerAllowlistJson,
} from "./confirmation-allowlist"

describe("confirmation-allowlist", () => {
    it("critical 工具不可会话放行", () => {
        expect(isDestructiveCriticalTool("delete_article")).toBe(true)
        expect(isDestructiveCriticalTool("revoke_agent_api_key")).toBe(true)
        expect(isDestructiveCriticalTool("set_public_qa_enabled")).toBe(true)
        expect(isDestructiveCriticalTool("update_ai_credential")).toBe(false)
        expect(DESTRUCTIVE_CRITICAL_TOOL_NAMES.has("update_ai_credential")).toBe(false)
    })

    it("parseDangerAllowlistJson 校验形状", () => {
        expect(parseDangerAllowlistJson(null)).toBeNull()
        expect(parseDangerAllowlistJson("{")).toBeNull()
        expect(parseDangerAllowlistJson(JSON.stringify({
            toolNames: ["update_ai_credential"],
            updatedAt: "2026-07-16T00:00:00.000Z",
        }))).toEqual({
            toolNames: ["update_ai_credential"],
            updatedAt: "2026-07-16T00:00:00.000Z",
        })
    })

    it("TTL 24h 过期判定", () => {
        const fresh = {
            toolNames: ["update_ai_credential"],
            updatedAt: new Date().toISOString(),
        }
        expect(isAllowlistExpired(fresh)).toBe(false)
        const stale = {
            toolNames: ["update_ai_credential"],
            updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        }
        expect(isAllowlistExpired(stale)).toBe(true)
    })
})
