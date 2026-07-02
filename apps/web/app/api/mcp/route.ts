import { createMcpHandler, withMcpAuth } from "mcp-handler"
import {
    AGENT_MCP_SERVER_INSTRUCTIONS,
    AGENT_MCP_SERVER_NAME,
    AGENT_MCP_SERVER_VERSION,
    registerAgentMcpTools,
    verifyAgentMcpToken,
} from "@/server/agent/mcp"

export const maxDuration = 300

// 无状态 Streamable HTTP MCP Server（不启用 SSE 传输，无需 Redis）。
// 鉴权复用 Agent API Key：客户端配置 Authorization: Bearer <ptc_live_...>。
const handler = createMcpHandler(
    (server) => {
        registerAgentMcpTools(server)
    },
    {
        serverInfo: {
            name: AGENT_MCP_SERVER_NAME,
            version: AGENT_MCP_SERVER_VERSION,
        },
        capabilities: { tools: {} },
        instructions: AGENT_MCP_SERVER_INSTRUCTIONS,
    },
    {
        basePath: "/api",
        maxDuration: 300,
    },
)

const authHandler = withMcpAuth(handler, verifyAgentMcpToken, { required: true })

export { authHandler as POST, authHandler as DELETE }
