"use client"

import * as React from "react"
import { Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { adminSiteAppearanceApi } from "@/lib/api"

function resolveApiError(error: unknown, fallback: string) {
    return (
        (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
        (error instanceof Error ? error.message : "") ||
        fallback
    )
}

export function SiteAppearanceConfigPage() {
    const [loading, setLoading] = React.useState(true)

    const fetchConfig = React.useCallback(async () => {
        setLoading(true)
        try {
            await adminSiteAppearanceApi.detail()
        } catch (e) {
            toast.error(resolveApiError(e, "加载前台配置失败"))
        } finally {
            setLoading(false)
        }
    }, [])

    React.useEffect(() => {
        void fetchConfig()
    }, [fetchConfig])

    return (
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-semibold">外观设置</h1>
                    <p className="text-sm text-muted-foreground">
                        配置前台公开页面的可用功能。
                    </p>
                </div>
                <Button variant="outline" size="sm" onClick={fetchConfig} disabled={loading}>
                    {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                    <span className="ml-2">刷新</span>
                </Button>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">前台问答</CardTitle>
                    <CardDescription>
                        公开站 `/ask` 问答已下线；后续如需再开放，会在此重新配置。
                    </CardDescription>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                    当前无可用开关。站内对话请使用「助手」。
                </CardContent>
            </Card>
        </div>
    )
}
