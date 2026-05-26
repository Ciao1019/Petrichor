import { describe, expect, it } from "vitest"
import {
    extractAgentBearerToken,
    generateAgentApiKey,
    hashAgentApiKey,
    parseAgentScopes,
    toAgentApiKeyPrefix,
} from "./api-key"

describe("Agent API Key 工具函数", () => {
    it("生成带固定前缀且可哈希的 API Key", () => {
        const apiKey = generateAgentApiKey()

        expect(apiKey.startsWith("ptc_live_")).toBe(true)
        expect(hashAgentApiKey(apiKey)).toMatch(/^[a-f0-9]{64}$/)
        expect(toAgentApiKeyPrefix(apiKey)).toBe(`${apiKey.slice(0, 16)}...`)
    })

    it("从 Authorization 或 x-petrichor-api-key 读取密钥", () => {
        const bearerRequest = new Request("https://example.com", {
            headers: { Authorization: "Bearer ptc_live_token" },
        })
        const headerRequest = new Request("https://example.com", {
            headers: { "x-petrichor-api-key": "ptc_live_header" },
        })

        expect(extractAgentBearerToken(bearerRequest)).toBe("ptc_live_token")
        expect(extractAgentBearerToken(headerRequest)).toBe("ptc_live_header")
    })

    it("忽略未知 scope", () => {
        expect(parseAgentScopes(JSON.stringify(["doc:read", "unknown", "qa:read"]))).toEqual([
            "doc:read",
            "qa:read",
        ])
    })
})
