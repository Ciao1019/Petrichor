"use client"

import * as React from "react"
import { Copy, KeyRound, RefreshCw, ShieldCheck, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { agentApi, type AgentApiKeyItem } from "@/lib/api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"

import {
  DEFAULT_AGENT_SCOPES,
  buildShellSnippet,
  copyToClipboard,
  formatDateTime,
  normalizeAxiosErrorMessage,
  scopeLabels,
} from "./agent-shared"

export function AgentKeysPage() {
  const [items, setItems] = React.useState<AgentApiKeyItem[]>([])
  const [loading, setLoading] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [revokingId, setRevokingId] = React.useState<string | null>(null)
  const [createdApiKey, setCreatedApiKey] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const fetchKeys = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await agentApi.listKeys()
      setItems(res.data.items)
    } catch (e) {
      setError(normalizeAxiosErrorMessage(e, "Agent API Key 加载失败"))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void fetchKeys()
  }, [fetchKeys])

  const createKey = async () => {
    setCreating(true)
    setCreatedApiKey(null)
    try {
      const res = await agentApi.createKey({
        name: `Agent Skill ${new Date().toLocaleDateString()}`,
        scopes: DEFAULT_AGENT_SCOPES,
      })
      setCreatedApiKey(res.data.apiKey)
      setItems((prev) => [res.data.item, ...prev])
      toast.success("Agent API Key 已生成")
    } catch (e) {
      toast.error(normalizeAxiosErrorMessage(e, "生成失败"))
    } finally {
      setCreating(false)
    }
  }

  const revokeKey = async (item: AgentApiKeyItem) => {
    const confirmed = window.confirm(
      `确认撤销 ${item.name}（${item.keyPrefix}）？撤销后已安装的 Agent 将无法继续调用。`,
    )
    if (!confirmed) return

    setRevokingId(item.id)
    try {
      await agentApi.revokeKey(item.id)
      setItems((prev) => prev.filter((key) => key.id !== item.id))
      toast.success("API Key 已撤销")
    } catch (e) {
      toast.error(normalizeAxiosErrorMessage(e, "撤销失败"))
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <div className="flex w-full flex-col gap-6 px-6 py-6 lg:px-10">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <KeyRound className="size-6 text-primary" />
            API Key 管理
          </h1>
          <p className="text-sm text-muted-foreground">
            为 Claude Code、Codex、OpenClaw 等 Agent 工具生成可调用文档能力的密钥。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void fetchKeys()} disabled={loading}>
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
          <Button type="button" size="sm" onClick={() => void createKey()} disabled={creating}>
            <KeyRound className="mr-2 h-4 w-4" />
            {creating ? "生成中..." : "生成 Key"}
          </Button>
        </div>
      </div>

      {createdApiKey ? (
        <Alert>
          <ShieldCheck className="h-4 w-4" />
          <AlertTitle>请立即保存 API Key</AlertTitle>
          <AlertDescription className="space-y-3">
            <div className="text-sm">明文只显示这一次，刷新页面后无法再次查看。</div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input readOnly value={createdApiKey} className="font-mono text-xs" />
              <Button type="button" variant="outline" onClick={() => void copyToClipboard(createdApiKey, "API Key")}>
                <Copy className="mr-2 h-4 w-4" />
                复制
              </Button>
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">终端环境变量</Label>
              <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
                {buildShellSnippet(createdApiKey)}
              </pre>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">已颁发的 API Key</CardTitle>
          <CardDescription>
            外部调用必须带 <span className="font-mono">X-Petrichor-Agent-Source</span>，否则接口会失败并写入审计日志。
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y border-t">
            {loading && items.length === 0 ? (
              <div className="space-y-3 p-4">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : null}

            {!loading && items.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                暂无 API Key，生成后即可安装 Skill 并调用文档能力。
              </div>
            ) : null}

            {items.map((item) => (
              <div key={item.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{item.name}</span>
                    <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
                      {item.keyPrefix}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    权限：{item.scopes.map((scope) => scopeLabels[scope] ?? scope).join("、")}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    最近使用：{formatDateTime(item.lastUsedAt)} · 创建：{formatDateTime(item.createdAt)}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void revokeKey(item)}
                  disabled={revokingId === item.id}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {revokingId === item.id ? "撤销中..." : "撤销"}
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
