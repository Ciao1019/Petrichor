import { describe, expect, it } from "vitest"
import { AGENT_API_KEY_SCOPES } from "@/server/agent/api-key"
import {
    AGENT_MCP_TOOL_SPECS,
    buildAgentMcpDelegateHeaders,
    missingAgentMcpTokenResult,
    toAgentMcpToolResult,
} from "@/server/agent/mcp-tools"
import { buildAgentEndpointMap } from "@/server/agent/skill"

describe("AGENT_MCP_TOOL_SPECS", () => {
    it("工具名唯一且使用 snake_case", () => {
        const names = AGENT_MCP_TOOL_SPECS.map((spec) => spec.name)
        expect(new Set(names).size).toBe(names.length)
        for (const name of names) {
            expect(name).toMatch(/^[a-z][a-z0-9_]*$/)
        }
    })

    it("每个工具都委托到 REST 能力层的已知端点", () => {
        const knownPaths = new Set(Object.values(buildAgentEndpointMap()))
        for (const spec of AGENT_MCP_TOOL_SPECS) {
            expect(knownPaths, `工具 ${spec.name} 的端点 ${spec.endpointPath} 不在 endpoint map 中`).toContain(spec.endpointPath)
        }
    })

    it("每个工具声明的 scope 都是合法的 API Key scope", () => {
        const validScopes = new Set<string>(AGENT_API_KEY_SCOPES)
        for (const spec of AGENT_MCP_TOOL_SPECS) {
            expect(validScopes).toContain(spec.scope)
        }
    })

    it("每个工具都有非空的标题与描述", () => {
        for (const spec of AGENT_MCP_TOOL_SPECS) {
            expect(spec.title.trim().length).toBeGreaterThan(0)
            expect(spec.description.trim().length).toBeGreaterThan(10)
        }
    })
})

describe("toAgentMcpToolResult", () => {
    it("2xx 响应原样透传 JSON 文本", () => {
        const result = toAgentMcpToolResult(200, "{\"items\":[]}")
        expect(result.isError).toBeUndefined()
        expect(result.content).toEqual([{ type: "text", text: "{\"items\":[]}" }])
    })

    it("2xx 空响应体回退为 {}", () => {
        const result = toAgentMcpToolResult(200, "  ")
        expect(result.content[0].text).toBe("{}")
    })

    it("错误响应提取封套中的 msg", () => {
        const body = JSON.stringify({ code: 403, msg: "当前 API Key 缺少 doc:read 权限", path: "/api/agent/document/search" })
        const result = toAgentMcpToolResult(403, body)
        expect(result.isError).toBe(true)
        expect(result.content[0].text).toBe("请求失败（HTTP 403）：当前 API Key 缺少 doc:read 权限")
    })

    it("错误响应体不是 JSON 时使用原始文本", () => {
        const result = toAgentMcpToolResult(500, "Internal Server Error")
        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain("HTTP 500")
        expect(result.content[0].text).toContain("Internal Server Error")
    })

    it("错误响应体为空时给出兜底文案", () => {
        const result = toAgentMcpToolResult(502, "")
        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain("未知错误")
    })
})

describe("buildAgentMcpDelegateHeaders", () => {
    it("带上 Bearer 鉴权与 MCP 标记 User-Agent", () => {
        const headers = buildAgentMcpDelegateHeaders({
            token: "ptc_live_test",
            toolName: "search_documents",
            clientUserAgent: "claude-code/2.0",
            forwardedFor: "1.2.3.4",
        })
        expect(headers.authorization).toBe("Bearer ptc_live_test")
        expect(headers["content-type"]).toBe("application/json")
        expect(headers["user-agent"]).toBe("petrichor-mcp/search_documents claude-code/2.0")
        expect(headers["x-forwarded-for"]).toBe("1.2.3.4")
    })

    it("缺少客户端 UA / IP 时不附带对应头", () => {
        const headers = buildAgentMcpDelegateHeaders({
            token: "ptc_live_test",
            toolName: "view_document",
        })
        expect(headers["user-agent"]).toBe("petrichor-mcp/view_document")
        expect(headers["x-forwarded-for"]).toBeUndefined()
    })
})

describe("missingAgentMcpTokenResult", () => {
    it("返回带指引的错误结果", () => {
        const result = missingAgentMcpTokenResult()
        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain("Authorization: Bearer")
    })
})
