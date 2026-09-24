"use client"

import * as React from "react"
import { Loader2, RefreshCw, Save } from "@/components/iconimate"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
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
        <div className="mx-auto w-full max-w-3xl space-y-8 p-4 md:py-8 md:px-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pb-6 border-b border-border/50">
                <div className="space-y-1">
                    <h1 className="text-xl font-semibold tracking-tight text-foreground">外观与公开功能</h1>
                    <p className="text-sm text-muted-foreground">
                        配置前台公开主页与访客交互功能。
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={fetchConfig} disabled={loading}>
                        {loading ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : <RefreshCw className="size-3.5 mr-1.5" />}
                        <span>刷新</span>
                    </Button>
                    <Button size="sm" onClick={handleSave} disabled={saving || loading}>
                        {saving ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : <Save className="size-3.5 mr-1.5" />}
                        <span>保存</span>
                    </Button>
                </div>
            </div>

            <div className="space-y-3">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                    公开互动
                </h2>
                <div className="flex items-center justify-between py-3 border-b border-border/40 gap-4">
                    <div className="space-y-1">
                        <Label htmlFor="public-qa-toggle" className="text-sm font-medium text-foreground cursor-pointer">
                            开启前台公开问答
                        </Label>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                            开启后，未登录访客可在前台「问答」页面（/ask）就公开分享的文章进行 AI 问答；每个访客每小时限 10 次提问。关闭后将提示已停用。
                        </p>
                    </div>
                    <Switch
                        id="public-qa-toggle"
                        checked={config.publicQaEnabled}
                        onCheckedChange={(value) =>
                            setConfig((prev) => ({ ...prev, publicQaEnabled: value }))
                        }
                    />
                </div>
            </div>
        </div>
    )
}
