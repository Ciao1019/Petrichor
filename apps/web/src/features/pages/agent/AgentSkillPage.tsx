"use client"

import { Copy, Download, Package } from "lucide-react"
import { Link } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { dashboardRoutes } from "@/lib/dashboard-routes"

import { copyToClipboard, getSkillPackUrl, getSkillUrl } from "./agent-shared"

export function AgentSkillPage() {
  const skillUrl = getSkillUrl()
  const skillPackUrl = getSkillPackUrl()

  return (
    <div className="flex w-full flex-col gap-6 px-6 py-6 lg:px-10">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Package className="size-6 text-primary" />
            Skill 包
          </h1>
          <p className="text-sm text-muted-foreground">
            下载并在 Agent 工具（Claude Code、Codex 等）中安装 Skill 包，使其可调用 Petrichor 的文档能力。
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Skill 包下载</CardTitle>
          <CardDescription>
            推荐使用打包后的 Skill 压缩包。该地址需配合
            <Link to={dashboardRoutes.agentKeys} className="ml-1 underline underline-offset-2">
              API Key
            </Link>
            一起使用。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-sm font-medium">Skill 包地址</div>
                <div className="break-all text-xs text-muted-foreground">{skillPackUrl}</div>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void copyToClipboard(skillPackUrl, "Skill 包地址")}
                >
                  <Copy className="mr-2 h-4 w-4" />
                  复制地址
                </Button>
                <Button type="button" size="sm" asChild>
                  <a href={skillPackUrl} download="petrichor-agent-skills.zip">
                    <Download className="mr-2 h-4 w-4" />
                    下载包
                  </a>
                </Button>
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              兼容旧单文件 Skill：
              <button
                type="button"
                className="ml-1 underline underline-offset-2"
                onClick={() => void copyToClipboard(skillUrl, "单文件 Skill 地址")}
              >
                {skillUrl}
              </button>
            </div>
            <div className="text-xs text-muted-foreground">
              外部调用必须带 <span className="font-mono">X-Petrichor-Agent-Source</span> 请求头，否则接口会失败并写入审计日志。
            </div>
          </div>

          <div className="grid gap-3 text-sm">
            <div className="rounded-md border p-3">
              <div className="mb-1 font-medium">使用步骤</div>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>
                  前往
                  <Link to={dashboardRoutes.agentKeys} className="mx-1 underline underline-offset-2">
                    API Key 管理
                  </Link>
                  生成专属密钥（明文仅展示一次，请妥善保存）。
                </li>
                <li>下载 Skill 包并在本地 Agent 工具（Claude Code、Codex 等）中导入。</li>
                <li>按提示设置 <span className="font-mono">PETRICHOR_BASE_URL</span> 与 <span className="font-mono">PETRICHOR_API_KEY</span> 环境变量。</li>
                <li>
                  调用情况会同步记录到
                  <Link to={dashboardRoutes.agentLogs} className="mx-1 underline underline-offset-2">
                    调用日志
                  </Link>
                  ，可用于审计与排障。
                </li>
              </ol>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
