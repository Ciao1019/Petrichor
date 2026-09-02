"use client"

import { ArrowRight, Download, FileCode2, Package, Plug } from "@/components/iconimate"
import { Link } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CodeBlock, CodeBlockCode } from "@/components/ui/code-block"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { dashboardRoutes } from "@/lib/dashboard-routes"

import {
  buildClaudeCodeSkillSnippet,
  buildCodexSkillSnippet,
  buildGenericSkillSnippet,
  getSkillPackUrl,
  getSkillUrl,
} from "./agent-shared"
import { AgentCopyRow, AgentPageHeader, AgentStepList, AgentToolChips } from "./agent-ui"

const SKILL_CAPABILITIES = [
  "文章读写",
  "关键词检索",
  "推理检索",
  "语义检索",
  "文档问答",
  "文章分享",
  "AI 摘要",
  "思维导图",
  "Wiki 维护",
]

const SKILL_RULES: Array<{ title: string; description: string }> = [
  { title: "动态站点地址", description: "下载时按当前请求域名写入 PETRICHOR_BASE_URL 示例" },
  { title: "最小权限", description: "每次 REST 调用仍校验 Agent API Key scope 与资源归属" },
  { title: "危险操作确认", description: "删除文章、撤销分享前要求 Agent 复述影响并获得确认" },
  { title: "能力自发现", description: "以 manifest 和 capabilities 的实时响应为接口清单" },
]

export function AgentSkillPage() {
  const skillUrl = getSkillUrl()
  const skillPackUrl = getSkillPackUrl()

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-10">
      <AgentPageHeader
        icon={Package}
        title="Agent Skill"
        description={
          <>
            为不支持 MCP、但能读取 Skill 并执行 shell 的 Agent 提供单文件接入说明。
            Skill 通过环境变量和受保护 REST API 调用 Petrichor 的文档能力。
          </>
        }
        actions={
          <Button type="button" asChild>
            <a href={skillUrl} download="SKILL.md">
              <Download className="mr-2 size-4" />
              下载 SKILL.md
            </a>
          </Button>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">下载地址</CardTitle>
              <CardDescription>
                下载文件不需要 Key；Skill 发起受保护调用时，需配合
                <Link to={dashboardRoutes.agentKeys} className="mx-1 underline underline-offset-2">
                  Agent API Key
                </Link>
                和 <span className="font-mono">PETRICHOR_BASE_URL</span> 使用。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <AgentCopyRow label="单文件 Skill" value={skillUrl} />
              <AgentCopyRow label="可选目录 ZIP" value={skillPackUrl} />
              <p className="text-xs leading-relaxed text-muted-foreground">
                ZIP 端点只打包服务端 <span className="font-mono">agent.skills_directory</span>
                指向的自定义目录；默认部署未提供该目录时会返回 404。
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">安装方式</CardTitle>
              <CardDescription>选择客户端，下载 SKILL.md 并在运行 Agent 的环境中设置两个变量。</CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="claude-code">
                <TabsList className="w-full">
                  <TabsTrigger value="claude-code" className="flex-1">Claude Code</TabsTrigger>
                  <TabsTrigger value="codex" className="flex-1">Codex CLI</TabsTrigger>
                  <TabsTrigger value="generic" className="flex-1">通用 Agent</TabsTrigger>
                </TabsList>
                <TabsContent value="claude-code" className="mt-3 space-y-2">
                  <CodeBlock>
                    <CodeBlockCode code={buildClaudeCodeSkillSnippet()} language="bash" showLineNumbers={false} />
                  </CodeBlock>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    只给当前项目使用时，可改放到项目的
                    <span className="ml-1 font-mono">.claude/skills/petrichor/SKILL.md</span>。
                  </p>
                </TabsContent>
                <TabsContent value="codex" className="mt-3 space-y-2">
                  <CodeBlock>
                    <CodeBlockCode code={buildCodexSkillSnippet()} language="bash" showLineNumbers={false} />
                  </CodeBlock>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    旧版客户端不识别 skills 目录时，把文件放进项目，并在
                    <span className="mx-1 font-mono">AGENTS.md</span>
                    中要求处理 Petrichor 任务前先阅读该文件。
                  </p>
                </TabsContent>
                <TabsContent value="generic" className="mt-3 space-y-2">
                  <CodeBlock>
                    <CodeBlockCode code={buildGenericSkillSnippet()} language="bash" showLineNumbers={false} />
                  </CodeBlock>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    自检响应会返回当前 Key 的 scopes、能力清单、MCP 地址与可访问知识库。
                  </p>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileCode2 className="size-4 text-muted-foreground" />
                运行契约
              </CardTitle>
              <CardDescription>单文件 Skill 只提供调用规则，不捆绑 CLI 或 config.json。</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y border-t">
                {SKILL_RULES.map((rule) => (
                  <div key={rule.title} className="flex flex-col gap-1 px-6 py-3 sm:flex-row sm:gap-4">
                    <span className="shrink-0 text-sm font-medium sm:w-36">{rule.title}</span>
                    <span className="text-xs leading-relaxed text-muted-foreground">{rule.description}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">使用步骤</CardTitle>
            </CardHeader>
            <CardContent>
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
                    description: "按实际任务选择最小 scopes，明文仅展示一次。",
                  },
                  {
                    title: "下载 SKILL.md",
                    description: "安装到客户端的 skills 目录，或放进项目并显式要求 Agent 阅读。",
                  },
                  {
                    title: "设置环境变量",
                    description: "配置 PETRICHOR_BASE_URL 与 PETRICHOR_API_KEY。",
                  },
                  {
                    title: "执行 capabilities 自检",
                    description: "确认 Key 有效、scope 正确并能看到目标知识库。",
                  },
                  {
                    title: "审计与排障",
                    description: (
                      <>
                        所有受保护调用都能在
                        <Link to={dashboardRoutes.agentLogs} className="mx-1 underline underline-offset-2">
                          调用日志
                        </Link>
                        中查询。
                      </>
                    ),
                  },
                ]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">能力范围</CardTitle>
              <CardDescription>单文件 Skill 引导 Agent 调用完整 REST 能力层。</CardDescription>
            </CardHeader>
            <CardContent>
              <AgentToolChips items={SKILL_CAPABILITIES} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Plug className="size-4 text-muted-foreground" />
                客户端支持 MCP？
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs leading-relaxed text-muted-foreground">
              <p>
                Claude Code、Codex、Cursor 等支持 MCP 的客户端推荐优先接入 MCP Server：
                无需下载文件，13 个核心工具都带结构化参数校验。
              </p>
              <Button asChild variant="outline" size="sm" className="w-full">
                <Link to={dashboardRoutes.agentMcp}>
                  前往 MCP Server
                  <ArrowRight className="ml-2 size-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>

          <div className="flex flex-wrap gap-1.5 px-1">
            <Badge variant="secondary" className="font-normal">单文件</Badge>
            <Badge variant="secondary" className="font-normal">REST 自发现</Badge>
            <Badge variant="secondary" className="font-normal">兼容 Agent Skills 规范</Badge>
          </div>
        </div>
      </div>
    </div>
  )
}
