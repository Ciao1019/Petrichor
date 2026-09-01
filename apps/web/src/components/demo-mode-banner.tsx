"use client"

import { FlaskConical, LogOut } from "@/components/iconimate"

import { Button } from "@/components/ui/button"
import { exitDemoMode, isDemoMode } from "@/lib/demo/demo-mode"

/* 演示模式提示条：挂在仪表盘布局顶部，非演示模式时不渲染任何东西。
   明确告知「数据只在内存里」，并提供退出入口。 */
export function DemoModeBanner() {
    if (!isDemoMode()) return null

    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-amber-300/60 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
            <span className="inline-flex items-center gap-1.5 font-medium">
                <FlaskConical className="size-3.5" aria-hidden="true" />
                演示模式
            </span>
            <span className="text-amber-800/80 dark:text-amber-200/70">
                演示模式只会看到部分菜单；连接正式 Go API 后可使用完整功能。
            </span>
            <span className="ml-auto">
                <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 gap-1 px-2 text-[11px] text-amber-900 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-900/40"
                    onClick={() => exitDemoMode()}
                >
                    <LogOut className="size-3" aria-hidden="true" />
                    退出演示
                </Button>
            </span>
        </div>
    )
}
