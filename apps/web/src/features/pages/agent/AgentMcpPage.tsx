"use client"

import { ArrowRight, Package, Plug, ShieldCheck } from "@/components/iconimate"
import { Link } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockCode } from "@/components/ui/code-block"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { dashboardRoutes } from "@/lib/dashboard-routes"

import {
  buildClaudeCodeMcpSnippet,
  buildCodexMcpSnippet,
  buildJsonMcpSnippet,
  getMcpUrl,
} from "./agent-shared"
import { AgentCopyRow, AgentPageHeader, AgentScopeBadge, AgentStepList, AgentToolChips } from "./agent-ui"

// 与 Go API 的 MCP 工具规格保持一致的展示层清单。
const MCP_TOOL_GROUPS: Array<{ title: string; scopes: string[]; tools: string[] }> = [
  {
    title: "检索与阅读",
    scopes: ["doc:read"],
    tools: [
      "list_knowledge_bases",
      "get_knowledge_base_tree",
      "search_documents",
      "search_document_tree",
      "semantic_search_document_tree",
      "view_document",
      "list_articles",
    ],
  },
  {
    title: "文档问答",
    scopes: ["qa:read"],
    tools: ["ask_documents"],
  },
  {
    title: "文章与文件夹",
    scopes: ["article:write", "article:delete"],
    tools: ["create_folder", "create_article", "update_article", "move_article", "delete_article"],
  },
]

const MCP_TOOL_COUNT = MCP_TOOL_GROUPS.reduce((total, group) => total + group.tools.length, 0)

export function AgentMcpPage() {
  const mcpUrl = getMcpUrl()

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-10">
      <AgentPageHeader
        icon={Plug}
        title="MCP 服务"
        description={
          <>
            标准 Model Context Protocol 服务器，Claude Code、Codex、Cursor 等 MCP 客户端一行配置即可
            检索、阅读、写入你的知识库。与 REST 层共用同一套 API Key 与调用审计。
          </>
        }
        actions={
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className="font-normal">Streamable HTTP</Badge>
            <Badge variant="secondary" className="font-normal">无状态</Badge>
            <Badge variant="secondary" className="font-normal">{MCP_TOOL_COUNT} 个工具</Badge>
          </div>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-6">
          <div className="space-y-3">
            <div>
              <h2 className="text-base font-semibold">服务器端点</h2>
              <p className="text-sm text-muted-foreground">
                所有请求（包括 <span className="font-mono">initialize</span>）都必须带
                <span className="mx-1 font-mono">Authorization: Bearer &lt;API Key&gt;</span>
                请求头，未鉴权一律 401。
              </p>
            </div>
            <AgentCopyRow
              label="MCP 端点（Streamable HTTP）"
              value={mcpUrl}
              hint={
                <>
                  API Key 在
                  <Link to={dashboardRoutes.agentKeys} className="mx-1 underline underline-offset-2">
                    API 密钥
                  </Link>
                  生成；每次工具调用都会写入
                  <Link to={dashboardRoutes.agentLogs} className="mx-1 underline underline-offset-2">
                    调用日志
                  </Link>
                  （来源标记为 <span className="font-mono">petrichor-mcp/&lt;工具名&gt;</span>）。
                </>
              }
            />
          </div>

          <div className="border-t border-border/40" />

          <div className="space-y-3">
            <div>
              <h2 className="text-base font-semibold">客户端接入</h2>
              <p className="text-sm text-muted-foreground">选择你的 Agent 工具，替换其中的 API Key 后执行。</p>
            </div>
            <Tabs defaultValue="claude-code">
              <TabsList className="w-full">
                <TabsTrigger value="claude-code" className="flex-1">Claude Code</TabsTrigger>
                <TabsTrigger value="codex" className="flex-1">Codex CLI</TabsTrigger>
                <TabsTrigger value="json" className="flex-1">Cursor / JSON</TabsTrigger>
              </TabsList>
              <TabsContent value="claude-code" className="mt-3 space-y-2">
                <CodeBlock>
                  <CodeBlockCode code={buildClaudeCodeMcpSnippet()} language="bash" showLineNumbers={false} />
                </CodeBlock>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  默认只对当前项目生效，加 <span className="font-mono">--scope user</span> 全局可用。
                  安装后在 <span className="font-mono">/mcp</span> 面板确认 petrichor 已连接。
                </p>
              </TabsContent>
              <TabsContent value="codex" className="mt-3 space-y-2">
                <CodeBlock>
                  <CodeBlockCode code={buildCodexMcpSnippet()} language="toml" showLineNumbers={false} />
                </CodeBlock>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  将 <span className="font-mono">ptc_live_xxx</span> 替换成「API 密钥」页生成的明文 Key。
                </p>
              </TabsContent>
              <TabsContent value="json" className="mt-3 space-y-2">
                <CodeBlock>
                  <CodeBlockCode code={buildJsonMcpSnippet()} language="json" showLineNumbers={false} />
                </CodeBlock>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  适用于 Cursor、Claude Desktop 等使用 JSON 配置、支持 Streamable HTTP 的 MCP 客户端。
                </p>
              </TabsContent>
            </Tabs>
          </div>

          <div className="border-t border-border/40" />

          <div className="space-y-3">
            <div>
              <h2 className="text-base font-semibold">内置工具</h2>
              <p className="text-sm text-muted-foreground">
                每个工具都要求 API Key 具备对应权限（scope），权限不足会返回 403。
              </p>
            </div>
            <div className="space-y-4 rounded-xl border border-border/40 bg-card/40 p-4">
              {MCP_TOOL_GROUPS.map((group) => (
                <div key={group.title} className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{group.title}</span>
                    {group.scopes.map((scope) => (
                      <AgentScopeBadge key={scope} scope={scope} />
                    ))}
                  </div>
                  <AgentToolChips items={group.tools} />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <div className="space-y-3 rounded-xl border border-border/40 bg-muted/20 p-4">
            <h3 className="font-medium text-sm">接入步骤</h3>
            <AgentStepList
              steps={[
                {
                  title: (
                    <>
                      生成
                      <Link to={dashboardRoutes.agentKeys} className="mx-1 underline underline-offset-2">
                        API Key
                      </Link>
                    </>
                  ),
                  description: "明文仅展示一次，按需勾选权限范围。",
                },
                {
                  title: "配置 MCP 客户端",
                  description: "按左侧对应工具的配置片段接入，替换 API Key。",
                },
                {
                  title: "验证连接",
                  description: "让 Agent 调用 list_knowledge_bases，能列出知识库即接入成功。",
                },
                {
                  title: "审计与排障",
                  description: (
                    <>
                      每次工具调用都记录在
                      <Link to={dashboardRoutes.agentLogs} className="mx-1 underline underline-offset-2">
                        调用日志
                      </Link>
                      ，401 检查 Key、403 检查权限范围。
                    </>
                  ),
                },
              ]}
            />
          </div>

          <div className="space-y-3 rounded-xl border border-border/40 bg-card/60 p-4 text-xs leading-relaxed text-muted-foreground">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Package className="size-4 text-muted-foreground" />
              MCP 还是 Agent Skill？
            </div>
            <p>
              <span className="font-medium text-foreground">MCP</span>
              ：客户端原生支持、工具带结构化参数校验，推荐 Claude Code / Codex / Cursor 优先使用。
            </p>
            <p>
              <span className="font-medium text-foreground">Agent Skill</span>
              ：不依赖 MCP 支持，任何能读取 Skill 并执行 shell 的 Agent 都能通过 REST 使用完整能力层。
            </p>
            <Button asChild variant="outline" size="sm" className="w-full">
              <Link to={dashboardRoutes.agentSkill}>
                前往技能包
                <ArrowRight className="ml-2 size-4" />
              </Link>
            </Button>
          </div>

          <div className="space-y-2 rounded-xl border border-border/40 bg-card/60 p-4 text-xs leading-relaxed text-muted-foreground">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <ShieldCheck className="size-4 text-muted-foreground" />
              安全说明
            </div>
            <p>服务端只存 API Key 的 SHA-256 哈希，可随时在「API 密钥」页撤销。</p>
            <p>删除文章等危险操作已在工具描述中要求 Agent 先向你确认。</p>
            <p>按最小权限原则为不同 Agent 颁发不同 scope 的 Key。</p>
          </div>
        </div>
      </div>
    </div>
  )
}
