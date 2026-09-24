"use client"

import * as React from "react"
import { Eye, Loader2, RefreshCw, Save } from "@/components/iconimate"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { adminSiteFilingApi, publicSiteFilingApi, type SiteFilingResponse } from "@/lib/api"

const emptyConfig: SiteFilingResponse = {
  enabled: false,
  icpNumber: "",
  icpUrl: "https://beian.miit.gov.cn/",
  publicSecurityNumber: "",
  publicSecurityUrl: "https://www.beian.gov.cn/portal/registerSystemInfo",
  createdAt: null,
  updatedAt: null,
}

function resolveApiError(error: unknown, fallback: string) {
  return (
    (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
    (error instanceof Error ? error.message : "") ||
    fallback
  )
}

function formatDateTime(value?: string | null) {
  if (!value) return "尚未写入数据库"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function SiteFilingConfigPage() {
  const [config, setConfig] = React.useState<SiteFilingResponse>(emptyConfig)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)

  const fetchConfig = React.useCallback(async () => {
    setLoading(true)
    try {
      const response = await adminSiteFilingApi.detail()
      setConfig(response.data)
    } catch (error: unknown) {
      toast.error(resolveApiError(error, "加载备案配置失败"))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void fetchConfig()
  }, [fetchConfig])

  const handleSave = React.useCallback(async () => {
    if (config.enabled && !config.icpNumber.trim() && !config.publicSecurityNumber.trim()) {
      toast.error("开启前台展示前，请至少填写一个备案号")
      return
    }

    setSaving(true)
    try {
      const response = await adminSiteFilingApi.update({
        enabled: config.enabled,
        icpNumber: config.icpNumber,
        icpUrl: config.icpUrl,
        publicSecurityNumber: config.publicSecurityNumber,
        publicSecurityUrl: config.publicSecurityUrl,
      })
      setConfig(response.data)
      publicSiteFilingApi.invalidateClientCache()
      toast.success("备案配置已保存")
    } catch (error: unknown) {
      toast.error(resolveApiError(error, "保存备案配置失败"))
    } finally {
      setSaving(false)
    }
  }, [config])

  const updateField = React.useCallback(
    (field: "icpNumber" | "icpUrl" | "publicSecurityNumber" | "publicSecurityUrl", value: string) => {
      setConfig((current) => ({ ...current, [field]: value }))
    },
    [],
  )

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 p-4 md:py-8 md:px-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pb-6 border-b border-border/50">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            备案管理
          </h1>
          <p className="text-sm text-muted-foreground">
            配置 ICP 与公安备案信息。启用后会展示在前台公开主页底部。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => void fetchConfig()} disabled={loading || saving}>
            {loading ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 size-3.5" />}
            刷新
          </Button>
          <Button type="button" size="sm" onClick={() => void handleSave()} disabled={loading || saving}>
            {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Save className="mr-1.5 size-3.5" />}
            保存
          </Button>
        </div>
      </div>

      {/* 展示开关 */}
      <div className="space-y-3 pb-6 border-b border-border/40">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
          前台展示
        </h2>
        <div className="flex items-center justify-between py-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="filing-enabled" className="text-sm font-medium text-foreground cursor-pointer">
              在前台显示备案信息
            </Label>
            <p className="text-xs text-muted-foreground">
              至少填写一个备案号后才可生效。关闭后会保留已填写的数据，但不在前台显示。
            </p>
          </div>
          <Switch
            id="filing-enabled"
            checked={config.enabled}
            disabled={loading}
            onCheckedChange={(enabled) => setConfig((current) => ({ ...current, enabled }))}
          />
        </div>
      </div>

      {/* ICP 备案 */}
      <div className="space-y-4 pb-6 border-b border-border/40">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
          工信部 ICP 备案
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="filing-icp-number" className="text-xs text-muted-foreground">ICP 备案号</Label>
            <Input
              id="filing-icp-number"
              value={config.icpNumber}
              disabled={loading}
              maxLength={120}
              placeholder="京ICP备xxxxxxxx号"
              onChange={(event) => updateField("icpNumber", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="filing-icp-url" className="text-xs text-muted-foreground">查询链接</Label>
            <Input
              id="filing-icp-url"
              type="url"
              value={config.icpUrl}
              disabled={loading}
              maxLength={500}
              placeholder="https://beian.miit.gov.cn/"
              onChange={(event) => updateField("icpUrl", event.target.value)}
            />
          </div>
        </div>
      </div>

      {/* 公安备案 */}
      <div className="space-y-4 pb-6 border-b border-border/40">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
          全国公安联网备案
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="filing-public-security-number" className="text-xs text-muted-foreground">公安备案号</Label>
            <Input
              id="filing-public-security-number"
              value={config.publicSecurityNumber}
              disabled={loading}
              maxLength={120}
              placeholder="京公网安备 xxxxxxxxxxxxxx号"
              onChange={(event) => updateField("publicSecurityNumber", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="filing-public-security-url" className="text-xs text-muted-foreground">查询链接</Label>
            <Input
              id="filing-public-security-url"
              type="url"
              value={config.publicSecurityUrl}
              disabled={loading}
              maxLength={500}
              placeholder="https://www.beian.gov.cn/..."
              onChange={(event) => updateField("publicSecurityUrl", event.target.value)}
            />
          </div>
        </div>
      </div>

      {/* 状态与预览 */}
      <div className="flex flex-col gap-3 py-2 sm:flex-row sm:items-center sm:justify-between text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${config.enabled ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
          <span>{config.enabled ? "已在前台启用" : "未在前台启用"}</span>
          <span>·</span>
          <span>更新于 {formatDateTime(config.updatedAt)}</span>
        </div>
        <Button type="button" variant="ghost" size="sm" asChild className="text-xs">
          <a href="/" target="_blank" rel="noopener noreferrer">
            <Eye className="mr-1.5 size-3.5" />
            预览前台效果
          </a>
        </Button>
      </div>
    </div>
  )
}
