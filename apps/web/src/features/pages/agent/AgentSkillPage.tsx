"use client"

import { ArrowRight, Download, FileCode2, Package, Plug } from "lucide-react"
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
  copyToClipboard,
  getSkillPackUrl,
  getSkillUrl,
} from "./agent-shared"
import { AgentCopyRow, AgentPageHeader, AgentStepList, AgentToolChips } from "./agent-ui"

const SKILL_PACKAGE_FILES: Array<{ path: string; description: string }> = [
  { path: "petrichor/SKILL.md", description: "根入口：按用户意图路由到对应子文档" },
  { path: "config.json", description: "站点地址与 Agent API Key 配置" },
  { path: "skills/setup.md", description: "配置、自检与接口发现" },
  { path: "skills/articles.md", description: "文章 / 文件夹的新建、更新、删除、移动" },
  { path: "skills/docs.md", description: "知识库浏览与关键词 / 推理 / 语义三种检索" },
  { path: "skills/qa.md", description: "单库与跨库文档问答" },
  { path: "skills/share.md", description: "分享链接、密码与到期管理" },
  { path: "skills/ai.md", description: "AI 摘要与思维导图生成" },
  { path: "skills/wiki.md", description: "知识 Wiki 浏览、重建与体检" },
  { path: "scripts/petrichor", description: "零依赖 Python CLI（所有能力的统一入口）" },
  { path: "scripts/petrichor-api.sh", description: "curl 版回退脚本（无 Python 环境时）" },
  { path: "references/endpoints.md", description: "全部 REST 端点的字段与示例" },
]

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

export function AgentSkillPage() {
  const skillUrl = getSkillUrl()
  const skillPackUrl = getSkillPackUrl()

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-10">
      <AgentPageHeader
        icon={Package}
        title="Skill 包"
        description={
          <>
            为不支持 MCP 的 Agent 准备的能力包：一个按意图路由的 Skill 加零依赖 CLI，
            任何能执行 shell 的 Agent（Claude Code、Codex 等）都能调用 Petrichor 的全部文档能力。
          </>
        }
        actions={
          <Button type="button" asChild>
            <a href={skillPackUrl} download="petrichor-agent-skills.zip">
              <Download className="mr-2 size-4" />
              下载 Skill 包
            </a>
          </Button>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">包地址</CardTitle>
              <CardDescription>
                调用需配合
                <Link to={dashboardRoutes.agentKeys} className="mx-1 underline underline-offset-2">
                  API Key
                </Link>
                使用：下载包可通过地址直接获取，解压后编辑
                <span className="mx-1 font-mono">config.json</span>
                即可。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <AgentCopyRow label="Skill 包（ZIP，推荐）" value={skillPackUrl} />
              <div className="text-xs text-muted-foreground">
                兼容旧单文件 Skill：
                <button
                  type="button"
                  className="ml-1 font-mono underline underline-offset-2"
                  onClick={() => void copyToClipboard(skillUrl, "单文件 Skill 地址")}
                >
                  {skillUrl}
                </button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">安装方式</CardTitle>
              <CardDescription>选择你的 Agent 工具，解压后编辑包内 config.json。</CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="claude-code">
                <TabsList className="w-full">
                  <TabsTrigger value="claude-code" className="flex-1">Claude Code</TabsTrigger>
                  <TabsTrigger value="codex" className="flex-1">Codex CLI</TabsTrigger>
                  <TabsTrigger value="generic" className="flex-1">通用 CLI</TabsTrigger>
                </TabsList>
                <TabsContent value="claude-code" className="mt-3 space-y-2">
                  <CodeBlock>
                    <CodeBlockCode code={buildClaudeCodeSkillSnippet()} language="bash" showLineNumbers={false} />
                  </CodeBlock>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    解压到 <span className="font-mono">~/.claude/skills/</span> 后全局可用；只给单个项目用就解压到项目的
                    <span className="ml-1 font-mono">.claude/skills/</span>。API Key 写在
                    <span className="mx-1 font-mono">petrichor/config.json</span>
                    里。
                  </p>
                </TabsContent>
                <TabsContent value="codex" className="mt-3 space-y-2">
                  <CodeBlock>
                    <CodeBlockCode code={buildCodexSkillSnippet()} language="bash" showLineNumbers={false} />
                  </CodeBlock>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    旧版本 Codex 不支持 skills 目录时，把包解压到仓库任意位置，并在
                    <span className="mx-1 font-mono">AGENTS.md</span>
                    中注明「Petrichor 相关任务请先阅读 petrichor/SKILL.md」；配置仍写
                    <span className="mx-1 font-mono">petrichor/config.json</span>。
                  </p>
                </TabsContent>
                <TabsContent value="generic" className="mt-3 space-y-2">
                  <CodeBlock>
                    <CodeBlockCode code={buildGenericSkillSnippet()} language="bash" showLineNumbers={false} />
                  </CodeBlock>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    CLI 仅依赖 Python 3.8+ 标准库；没有 Python 时用
                    <span className="mx-1 font-mono">scripts/petrichor-api.sh</span>
                    （curl 版，功能等价）。
                  </p>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileCode2 className="size-4 text-muted-foreground" />
                包内结构
              </CardTitle>
              <CardDescription>
                根 SKILL.md 按需路由，Agent 不会一次性加载所有子文档，节省上下文。
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y border-t">
                {SKILL_PACKAGE_FILES.map((file) => (
                  <div key={file.path} className="flex flex-col gap-1 px-6 py-2.5 sm:flex-row sm:items-center sm:gap-4">
                    <span className="shrink-0 font-mono text-xs sm:w-56">{file.path}</span>
                    <span className="text-xs text-muted-foreground">{file.description}</span>
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
                    description: "明文仅展示一次，请妥善保存。",
                  },
                  {
                    title: "下载并解压 Skill 包",
                    description: "可以点击下载，也可以复制包地址用 curl 下载。",
                  },
                  {
                    title: "编辑 config.json",
                    description: (
                      <>
                        填入 <span className="font-mono">apiKey</span>；通常
                        <span className="mx-1 font-mono">baseUrl</span>
                        已按下载地址自动写好。
                      </>
                    ),
                  },
                  {
                    title: "自检",
                    description: (
                      <>
                        运行 <span className="font-mono">scripts/petrichor capabilities</span>
                        ，返回权限列表即安装成功。
                      </>
                    ),
                  },
                  {
                    title: "审计与排障",
                    description: (
                      <>
                        调用记录在
                        <Link to={dashboardRoutes.agentLogs} className="mx-1 underline underline-offset-2">
                          调用日志
                        </Link>
                        中可查。
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
              <CardDescription>与 MCP 工具能力一致，并额外覆盖 AI 生成。</CardDescription>
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
                无需下载文件，工具参数还带结构化校验。
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
            <Badge variant="secondary" className="font-normal">零依赖 CLI</Badge>
            <Badge variant="secondary" className="font-normal">按意图路由</Badge>
            <Badge variant="secondary" className="font-normal">兼容 Agent Skills 规范</Badge>
          </div>
        </div>
      </div>
    </div>
  )
}
