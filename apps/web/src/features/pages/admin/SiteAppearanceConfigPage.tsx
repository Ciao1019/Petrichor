"use client"

import * as React from "react"
import { Loader2, RefreshCw, Save } from "@/components/iconimate"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
    adminSiteAppearanceApi,
    type SiteAppearanceResponse,
} from "@/lib/api"
import { DEFAULT_RETYPESET_APPEARANCE } from "@/lib/retypeset-themes"

function resolveApiError(error: unknown, fallback: string) {
    return (
        (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
        (error instanceof Error ? error.message : "") ||
        fallback
    )
}

export function SiteAppearanceConfigPage() {
    const [config, setConfig] = React.useState<SiteAppearanceResponse>(() => ({
        ...DEFAULT_RETYPESET_APPEARANCE,
        createdAt: null,
        updatedAt: null,
    }))
    const [loading, setLoading] = React.useState(true)
    const [saving, setSaving] = React.useState(false)

    const fetchConfig = React.useCallback(async () => {
        setLoading(true)
        try {
            const res = await adminSiteAppearanceApi.detail()
            setConfig(res.data)
        } catch (e) {
            toast.error(resolveApiError(e, "加载前台配置失败"))
        } finally {
            setLoading(false)
        }
    }, [])

    React.useEffect(() => {
        void fetchConfig()
    }, [fetchConfig])

    const handleSave = React.useCallback(async () => {
        setSaving(true)
        try {
            const res = await adminSiteAppearanceApi.update({
                publicQaEnabled: config.publicQaEnabled,
            })
            setConfig(res.data)
            toast.success("前台配置已保存")
        } catch (e) {
            toast.error(resolveApiError(e, "保存前台配置失败"))
        } finally {
            setSaving(false)
        }
    }, [config.publicQaEnabled])

    return (
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-semibold">外观设置</h1>
                    <p className="text-sm text-muted-foreground">
                        配置前台公开页面的可用功能。
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={fetchConfig} disabled={loading}>
                        {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                        <span className="ml-2">刷新</span>
                    </Button>
                    <Button size="sm" onClick={handleSave} disabled={saving || loading}>
                        {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                        <span className="ml-2">保存</span>
                    </Button>
                </div>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">前台问答</CardTitle>
                    <CardDescription>
                        开启后，未登录访客可在前台「问答」页面（/ask）就你公开分享的文章进行 AI 问答；每个访客每小时限 10 次提问。
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex items-center justify-between rounded-md border p-3">
                        <div className="space-y-0.5">
                            <Label className="text-sm font-medium">开启前台公开问答</Label>
                            <p className="text-xs text-muted-foreground">关闭后 /ask 页面将提示功能已停用</p>
                        </div>
                        <Switch
                            checked={config.publicQaEnabled}
                            onCheckedChange={(value) =>
                                setConfig((prev) => ({ ...prev, publicQaEnabled: value }))
                            }
                        />
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}
