import { describe, expect, it } from "vitest"
import { SESSION_COOKIE_NAME, hashSessionToken, issueSessionToken } from "./session"

describe("session token helpers", () => {
    it("使用 Petrichor 命名的会话 Cookie", () => {
        expect(SESSION_COOKIE_NAME).toBe("petrichor_session")
    })

    it("生成足够长的不透明 token", () => {
        const token = issueSessionToken()

        expect(token.length).toBeGreaterThanOrEqual(43)
    })

    it("同一 token 的 hash 稳定且不等于明文", async () => {
        const token = "example-token"

        await expect(hashSessionToken(token)).resolves.toBe(await hashSessionToken(token))
        await expect(hashSessionToken(token)).resolves.not.toBe(token)
    })
})
