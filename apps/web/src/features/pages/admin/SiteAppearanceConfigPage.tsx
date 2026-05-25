"use client"

import * as React from "react"
import { Loader2, RefreshCw, Save } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import {
    adminSiteAppearanceApi,
    type SiteAppearanceResponse,
} from "@/lib/api"
import {
    DEFAULT_RETYPESET_APPEARANCE,
    RETYPESET_THEMES,
    RETYPESET_THEME_IDS,
    isRetypesetThemeId,
    type RetypesetThemeId,
} from "@/lib/retypeset-themes"

const HOUR_OPTIONS = Array.from({ length: 25 }, (_, h) => h)

function resolveApiError(error: unknown, fallback: string) {
    return (
        (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
        (error instanceof Error ? error.message : "") ||
        fallback
    )
}

function formatHour(hour: number) {
    return `${String(hour).padStart(2, "0")}:00`
}

function ThemePreview({ themeId }: { themeId: RetypesetThemeId }) {
    const theme = RETYPESET_THEMES[themeId]
    return (
        <div
            className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
            style={{ background: theme.background, color: theme.secondary, borderColor: theme.secondary + "33" }}
        >
            <span
                aria-hidden
                className="size-3 rounded-full"
                style={{ background: theme.accent }}
            />
            <span style={{ color: theme.primary }} className="font-medium">
                {theme.label}
            </span>
            <span className="opacity-70">/ {theme.tone}</span>
        </div>
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
            toast.error(resolveApiError(e, "加载外观配置失败"))
        } finally {
            setLoading(false)
        }
    }, [])

    React.useEffect(() => {
        void fetchConfig()
    }, [fetchConfig])

    const handleSave = React.useCallback(async () => {
        if (config.dayStartHour === config.dayEndHour) {
            toast.error("白天开始时间不能等于结束时间")
            return
        }
        setSaving(true)
        try {
            const res = await adminSiteAppearanceApi.update({
                dayTheme: config.dayTheme,
                nightTheme: config.nightTheme,
                dayStartHour: config.dayStartHour,
                dayEndHour: config.dayEndHour,
                allowManualOverride: config.allowManualOverride,
            })
            setConfig(res.data)
            toast.success("外观配置已保存")
        } catch (e) {
            toast.error(resolveApiError(e, "保存外观配置失败"))
        } finally {
            setSaving(false)
        }
    }, [config])

    const updateTheme = (field: "dayTheme" | "nightTheme", value: string) => {
        if (!isRetypesetThemeId(value)) return
        setConfig((prev) => ({ ...prev, [field]: value }))
    }

    const updateHour = (field: "dayStartHour" | "dayEndHour", value: string) => {
        const n = Number(value)
        if (!Number.isFinite(n)) return
        setConfig((prev) => ({ ...prev, [field]: n }))
    }

    const dayTheme = isRetypesetThemeId(config.dayTheme) ? config.dayTheme : "paper"
    const nightTheme = isRetypesetThemeId(config.nightTheme) ? config.nightTheme : "slate"

    return (
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-semibold">外观设置</h1>
                    <p className="text-sm text-muted-foreground">
                        配置前台 Retypeset 主题：日间/夜间各用哪套，以及按浏览器本地时间切换的时段。
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
                    <CardTitle className="text-base">主题方案</CardTitle>
                    <CardDescription>
                        选择白天和夜间各使用哪套主题。浏览器进入对应时段后自动切换。
                    </CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-6 md:grid-cols-2">
                    <div className="space-y-2">
                        <Label htmlFor="appearance-day-theme">白天主题</Label>
                        <Select value={dayTheme} onValueChange={(v) => updateTheme("dayTheme", v)}>
                            <SelectTrigger id="appearance-day-theme" className="w-full">
                                <SelectValue placeholder="选择白天主题" />
                            </SelectTrigger>
                            <SelectContent>
                                {RETYPESET_THEME_IDS.map((id) => (
                                    <SelectItem key={id} value={id}>
                                        {RETYPESET_THEMES[id].label}（{RETYPESET_THEMES[id].tone}）
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <ThemePreview themeId={dayTheme} />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="appearance-night-theme">夜间主题</Label>
                        <Select value={nightTheme} onValueChange={(v) => updateTheme("nightTheme", v)}>
                            <SelectTrigger id="appearance-night-theme" className="w-full">
                                <SelectValue placeholder="选择夜间主题" />
                            </SelectTrigger>
                            <SelectContent>
                                {RETYPESET_THEME_IDS.map((id) => (
                                    <SelectItem key={id} value={id}>
                                        {RETYPESET_THEMES[id].label}（{RETYPESET_THEMES[id].tone}）
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <ThemePreview themeId={nightTheme} />
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">时段</CardTitle>
                    <CardDescription>
                        按访客浏览器本地时间判定。白天 [开始, 结束) 区间内显示白天主题，其余时段显示夜间主题。跨午夜的区间也支持。
                    </CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-6 md:grid-cols-2">
                    <div className="space-y-2">
                        <Label htmlFor="appearance-day-start">白天开始</Label>
                        <Select
                            value={String(config.dayStartHour)}
                            onValueChange={(v) => updateHour("dayStartHour", v)}
                        >
                            <SelectTrigger id="appearance-day-start" className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {HOUR_OPTIONS.map((h) => (
                                    <SelectItem key={h} value={String(h)}>
                                        {formatHour(h)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="appearance-day-end">白天结束</Label>
                        <Select
                            value={String(config.dayEndHour)}
                            onValueChange={(v) => updateHour("dayEndHour", v)}
                        >
                            <SelectTrigger id="appearance-day-end" className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {HOUR_OPTIONS.map((h) => (
                                    <SelectItem key={h} value={String(h)}>
                                        {formatHour(h)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">手动切换</CardTitle>
                    <CardDescription>
                        开启后，访客在前台导航上会出现日/夜切换按钮，选择会记忆到他自己的 localStorage，覆盖自动判断。
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex items-center justify-between rounded-md border p-3">
                        <div className="space-y-0.5">
                            <Label className="text-sm font-medium">允许访客手动切换</Label>
                            <p className="text-xs text-muted-foreground">关闭则严格按时段，访客无法覆盖</p>
                        </div>
                        <Switch
                            checked={config.allowManualOverride}
                            onCheckedChange={(value) =>
                                setConfig((prev) => ({ ...prev, allowManualOverride: value }))
                            }
                        />
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}
