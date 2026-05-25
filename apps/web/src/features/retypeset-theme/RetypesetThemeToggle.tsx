"use client"

import * as React from "react"
import { Moon, Sun } from "lucide-react"
import { useOptionalRetypesetTheme } from "./RetypesetThemeContext"

export function RetypesetThemeToggle({ className }: { className?: string }) {
    const ctx = useOptionalRetypesetTheme()
    if (!ctx || !ctx.allowManualOverride) return null

    const isDay = ctx.activeTone === "light"
    const Icon = isDay ? Sun : Moon
    const label = isDay ? "切换到夜间主题" : "切换到日间主题"

    return (
        <button
            type="button"
            onClick={ctx.toggleDayNight}
            aria-label={label}
            title={label}
            className={
                "retypeset-c-secondary inline-flex size-7 cursor-pointer items-center justify-center rounded-full transition-colors hover:text-[var(--retypeset-accent)] " +
                (className ?? "")
            }
        >
            <Icon className="size-4" aria-hidden="true" />
            <span className="sr-only">{label}</span>
        </button>
    )
}
