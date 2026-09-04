"use client"

import * as React from "react"
import { Eye, Loader2, RefreshCw, Save, ShieldCheck } from "@/components/iconimate"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <ShieldCheck className="size-6 text-primary" />
            备案管理
          </h1>
          <p className="text-sm text-muted-foreground">
            配置 ICP 与公安备案信息。启用后会展示在所有前台公开页面的导航区域。
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => void fetchConfig()} disabled={loading || saving}>
            {loading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
            刷新
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={loading || saving}>
            {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}
            保存
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">前台展示</CardTitle>
          <CardDescription>
            关闭后会保留已填写的信息，但前台导航区不会显示备案链接。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-6 rounded-lg border p-4">
            <div className="space-y-1">
              <Label htmlFor="filing-enabled">显示备案信息</Label>
              <p className="text-xs text-muted-foreground">至少填写一个备案号后才可启用</p>
            </div>
            <Switch
              id="filing-enabled"
              checked={config.enabled}
              disabled={loading}
              onCheckedChange={(enabled) => setConfig((current) => ({ ...current, enabled }))}
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>ICP 备案</CardTitle>
            <CardDescription>工信部备案号与对应查询链接。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="filing-icp-number">ICP备案号</Label>
              <Input
                id="filing-icp-number"
                value={config.icpNumber}
                disabled={loading}
                maxLength={120}
                placeholder="京ICP备xxxxxxxx号"
                onChange={(event) => updateField("icpNumber", event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="filing-icp-url">备案链接</Label>
              <Input
                id="filing-icp-url"
                type="url"
                value={config.icpUrl}
                disabled={loading}
                maxLength={500}
                placeholder="https://beian.miit.gov.cn/"
                onChange={(event) => updateField("icpUrl", event.target.value)}
              />
              <p className="text-xs text-muted-foreground">留空保存时会使用工信部备案查询入口。</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>公安备案</CardTitle>
            <CardDescription>公网安备编号与公安联网备案查询链接。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="filing-public-security-number">公安备案号</Label>
              <Input
                id="filing-public-security-number"
                value={config.publicSecurityNumber}
                disabled={loading}
                maxLength={120}
                placeholder="京公网安备 xxxxxxxxxxxxxx号"
                onChange={(event) => updateField("publicSecurityNumber", event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="filing-public-security-url">备案链接</Label>
              <Input
                id="filing-public-security-url"
                type="url"
                value={config.publicSecurityUrl}
                disabled={loading}
                maxLength={500}
                placeholder="https://www.beian.gov.cn/..."
                onChange={(event) => updateField("publicSecurityUrl", event.target.value)}
              />
              <p className="text-xs text-muted-foreground">建议填写备案系统生成的、带 recordcode 的完整地址。</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">发布状态</CardTitle>
          <CardDescription>公开页面会在保存后读取最新的单例配置。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className={`size-2 rounded-full ${config.enabled ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
            <span>{config.enabled ? "已启用前台展示" : "未启用前台展示"}</span>
            <span className="text-muted-foreground">更新于 {formatDateTime(config.updatedAt)}</span>
          </div>
          <Button type="button" variant="outline" asChild>
            <a href="/" target="_blank" rel="noopener noreferrer">
              <Eye className="mr-2 size-4" />
              预览前台
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
