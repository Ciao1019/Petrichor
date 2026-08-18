"use client"

import * as React from "react"
import { Copy, KeyRound, RefreshCw, ShieldCheck, Trash2 } from "@/components/iconimate"
import { toast } from "sonner"

import { agentApi, type AgentApiKeyItem } from "@/lib/api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"

import {
  DEFAULT_AGENT_SCOPES,
  buildSkillConfigSnippet,
  copyToClipboard,
  formatDateTime,
  normalizeAxiosErrorMessage,
  scopeLabels,
} from "./agent-shared"
import { AgentPageHeader } from "./agent-ui"

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
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-10">
      <AgentPageHeader
        icon={KeyRound}
        title="API Key 管理"
        description="为 Claude Code、Codex、Cursor 等 Agent 工具颁发密钥。MCP Server、Skill 包与 REST 接口共用同一套 Key，明文仅生成时展示一次。"
        actions={
          <>
            <Button type="button" variant="outline" size="sm" onClick={() => void fetchKeys()} disabled={loading}>
              <RefreshCw className="mr-2 size-4" />
              刷新
            </Button>
            <Button type="button" size="sm" onClick={() => void createKey()} disabled={creating}>
              <KeyRound className="mr-2 size-4" />
              {creating ? "生成中..." : "生成 Key"}
            </Button>
          </>
        }
      />

      {createdApiKey ? (
        <Alert className="border-primary/30 bg-primary/5">
          <ShieldCheck className="size-4" />
          <AlertTitle>请立即保存 API Key</AlertTitle>
          <AlertDescription className="space-y-3">
            <div className="text-sm">明文只显示这一次，刷新页面后无法再次查看。</div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input readOnly value={createdApiKey} className="font-mono text-xs" />
              <Button type="button" variant="outline" onClick={() => void copyToClipboard(createdApiKey, "API Key")}>
                <Copy className="mr-2 size-4" />
                复制
              </Button>
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Skill config.json</Label>
              <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
                {buildSkillConfigSnippet(createdApiKey)}
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
            调用时以 <span className="font-mono">Authorization: Bearer &lt;API Key&gt;</span> 请求头鉴权；
            撤销立即生效。
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y border-t">
            {loading && items.length === 0 ? (
              <div className="space-y-3 p-6">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : null}

            {!loading && items.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
                <div className="flex size-12 items-center justify-center rounded-full border bg-muted/50 text-muted-foreground">
                  <KeyRound className="size-5" />
                </div>
                <div className="space-y-1">
                  <div className="text-sm font-medium">还没有 API Key</div>
                  <div className="text-xs text-muted-foreground">
                    生成后即可接入 MCP Server 或安装 Skill 包，调用文档能力。
                  </div>
                </div>
                <Button type="button" size="sm" onClick={() => void createKey()} disabled={creating}>
                  <KeyRound className="mr-2 size-4" />
                  {creating ? "生成中..." : "生成第一个 Key"}
                </Button>
              </div>
            ) : null}

            {items.map((item) => (
              <div key={item.id} className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{item.name}</span>
                    <span className="rounded border bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                      {item.keyPrefix}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {item.scopes.map((scope) => (
                      <Badge key={scope} variant="outline" className="font-normal text-[11px] text-muted-foreground">
                        {scopeLabels[scope] ?? scope}
                      </Badge>
                    ))}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    最近使用：{formatDateTime(item.lastUsedAt)} · 创建：{formatDateTime(item.createdAt)}
                    {item.expiresAt ? ` · 到期：${formatDateTime(item.expiresAt)}` : null}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => void revokeKey(item)}
                  disabled={revokingId === item.id}
                >
                  <Trash2 className="mr-2 size-4" />
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
